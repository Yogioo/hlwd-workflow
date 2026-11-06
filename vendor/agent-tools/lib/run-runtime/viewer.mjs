/**
 * Read-only local event viewer for a progress JSONL file.
 *
 * Binds to loopback by default. The page has no external resources and renders
 * records with textContent only (no HTML injection). This is pure observation:
 * it never writes to the event file and never triggers any task action.
 *
 * Provenance: minimal replacement for the observation mechanics in
 * skills/exec-review/scripts/progress-http.mjs.
 */

import { createServer } from 'node:http'

import { readEvents } from './progress.mjs'

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>run-runtime events</title>
<style>
body{background:#0b0e14;color:#e6edf3;font:13px/1.5 ui-monospace,Consolas,monospace;margin:0;padding:20px}
h1{font-size:15px;font-weight:600;margin:0 0 4px}
#meta{color:#8b949e;margin-bottom:14px}
ol{list-style:none;padding:0;margin:0}
li{border-top:1px solid #222a3a;padding:6px 0;white-space:pre-wrap;word-break:break-word}
.t{color:#5c6570}.lv{color:#d29922}.ev{color:#58a6ff}.bad{color:#f85149}
</style>
</head>
<body>
<h1>run-runtime events</h1>
<div id="meta">connecting...</div>
<ol id="list"></ol>
<script>
(function () {
  var next = 0;
  var list = document.getElementById('list');
  var meta = document.getElementById('meta');
  function append(rec) {
    var li = document.createElement('li');
    var t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date(rec.t).toISOString() + ' ';
    li.appendChild(t);
    var lv = document.createElement('span');
    lv.className = 'lv';
    lv.textContent = 'L' + rec.level + ' ';
    li.appendChild(lv);
    var ev = document.createElement('span');
    ev.className = 'ev';
    ev.textContent = rec.event;
    li.appendChild(ev);
    var rest = {};
    for (var k in rec) if (k !== 't' && k !== 'level' && k !== 'event') rest[k] = rec[k];
    var body = document.createElement('div');
    body.textContent = JSON.stringify(rest);
    li.appendChild(body);
    list.appendChild(li);
    while (list.childNodes.length > 500) list.removeChild(list.firstChild);
  }
  function appendBad(rec) {
    var li = document.createElement('li');
    li.className = 'bad';
    li.textContent = 'malformed line ' + rec.line + ': ' + rec.error;
    list.appendChild(li);
  }
  function poll() {
    fetch('events?after=' + next).then(function (r) { return r.json(); }).then(function (data) {
      for (var i = 0; i < data.events.length; i++) append(data.events[i]);
      for (var j = 0; j < data.malformed.length; j++) appendBad(data.malformed[j]);
      next = data.lineCount;
      meta.textContent = data.lineCount + ' records, ' + data.malformed.length + ' malformed';
    }).catch(function () { meta.textContent = 'connection lost'; });
  }
  poll();
  setInterval(poll, 1500);
})();
</script>
</body>
</html>
`

/**
 * Start a read-only viewer.
 * @param {{eventsFile:string, host?:string, port?:number}} opts
 * @returns {Promise<{url:string, host:string, port:number, eventsFile:string, close:()=>Promise<void>}>}
 */
export function createViewerServer(opts) {
  const eventsFile = opts.eventsFile
  const host = opts.host || '127.0.0.1'
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${host}`)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }
    if (url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') || '0')
      const result = readEvents(eventsFile, { after: Number.isInteger(after) ? after : 0 })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(result))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found\n')
  })

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port(opts.port), host, () => {
      const address = server.address()
      const actualHost = address.address === '::' || address.address === '::1' ? host : address.address
      resolvePromise({
        url: `http://${actualHost}:${address.port}/`,
        host: actualHost,
        port: address.port,
        eventsFile,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

function port(value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : 0
}
