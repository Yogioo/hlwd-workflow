// web/mail.mjs：用一个本地假 SMTP 服务器验协议细节（不连云上邮箱）。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { MailError, sendMail } from './mail.mjs';

/** 极简 SMTP 服务端：只认 EHLO / AUTH / MAIL / RCPT / DATA / QUIT。 */
async function fakeSmtp({ authFail = false } = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    let buf = '';
    let dataMode = false;
    let data = '';
    socket.on('error', () => {}); // 客户端发完 QUIT 就断开，RST 属正常
    socket.write('220 test ready\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            received.push(data);
            data = '';
            socket.write('250 queued\r\n');
          } else {
            data += line + '\r\n';
          }
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) socket.write('250-test\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (cmd.startsWith('AUTH PLAIN')) socket.write(authFail ? '535 5.7.8 bad credentials\r\n' : '235 2.7.0 ok\r\n');
        else if (cmd.startsWith('MAIL FROM')) socket.write('250 2.1.0 ok\r\n');
        else if (cmd.startsWith('RCPT TO')) socket.write('250 2.1.5 ok\r\n');
        else if (cmd === 'DATA') {
          dataMode = true;
          socket.write('354 go ahead\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const configOf = (port) => ({
  host: '127.0.0.1',
  port,
  secure: false,
  user: 'bot@hellowd.net',
  pass: 'secret',
  from: 'HLWD 看板 <bot@hellowd.net>',
  allowDomains: [],
});

test('发信：走完 EHLO/AUTH/MAIL/RCPT/DATA，中文标题编成 encoded-word', async () => {
  const smtp = await fakeSmtp();
  try {
    const out = await sendMail({
      to: 'pengyunjie@hellowd.net',
      subject: 'HLWD 看板注册验证码',
      text: '验证码：123456\n10 分钟内有效。',
      config: configOf(smtp.port),
    });
    assert.equal(out.ok, true);
    assert.equal(smtp.received.length, 1);
    const message = smtp.received[0];
    assert.match(message, /^To: <pengyunjie@hellowd\.net>/m);
    assert.match(message, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(message, /^Content-Transfer-Encoding: base64$/m);
    const body = message.split('\r\n\r\n')[1].replace(/\s+/g, '');
    assert.match(Buffer.from(body, 'base64').toString('utf8'), /验证码：123456/);
  } finally {
    await smtp.close();
  }
});

test('发信：登录被拒时抛出带服务器原话的 MailError', async () => {
  const smtp = await fakeSmtp({ authFail: true });
  try {
    await assert.rejects(
      () =>
        sendMail({
          to: 'pengyunjie@hellowd.net',
          subject: 'x',
          text: 'x',
          config: configOf(smtp.port),
        }),
      (err) => err instanceof MailError && err.code === 535 && /登录失败/.test(err.message),
    );
  } finally {
    await smtp.close();
  }
});

test('发信：收件地址不合法就不连服务器', async () => {
  await assert.rejects(
    () => sendMail({ to: 'not-an-email', subject: 'x', text: 'x', config: configOf(1) }),
    /收件地址不对/,
  );
});
