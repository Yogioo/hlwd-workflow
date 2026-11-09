// 发信：只读这台机器的 ~/.hlwd/mail.json，只支持 SMTP（465 直连 TLS，或测试用的明文端口）。
// 纯输出模块：不碰账号、不存状态；发不出去就抛 MailError，由调用方决定怎么提示。
// 零依赖：node:net / node:tls 自己讲 SMTP，不引 nodemailer。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const HOME = process.env.HLWD_HOME ? path.resolve(process.env.HLWD_HOME) : path.join(os.homedir(), '.hlwd');
export const MAIL_CONFIG_FILE = path.join(HOME, 'mail.json');

const REPLY_TIMEOUT_MS = 20000;

export class MailError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'MailError';
    this.code = code;
  }
}

const trim = (v) => (typeof v === 'string' ? v.trim() : '');

/** 配置优先级：环境变量 > mail.json。没有配置文件就返回 null（= 没配邮箱）。 */
export async function readMailConfig() {
  let file = {};
  try {
    file = JSON.parse((await fs.readFile(MAIL_CONFIG_FILE, 'utf8')).replace(/^\uFEFF/, '')) ?? {};
  } catch (err) {
    if (err.code !== 'ENOENT') throw new MailError(`mail.json 读不出来：${err.message}`);
  }
  const env = process.env;
  const cfg = {
    kind: 'smtp',
    host: trim(env.WF_SMTP_HOST) || trim(file.host),
    port: Number(trim(env.WF_SMTP_PORT) || file.port || 465),
    secure: env.WF_SMTP_SECURE ? env.WF_SMTP_SECURE !== 'false' : file.secure !== false,
    user: trim(env.WF_SMTP_USER) || trim(file.user),
    pass: env.WF_SMTP_PASS ?? (typeof file.pass === 'string' ? file.pass : ''),
    from: trim(env.WF_SMTP_FROM) || trim(file.from) || trim(file.user),
    allowDomains: Array.isArray(file.allowDomains)
      ? file.allowDomains.map((d) => trim(String(d)).toLowerCase().replace(/^@/, '')).filter(Boolean)
      : [],
  };
  return cfg.host && cfg.user ? cfg : null;
}

/** 看板/注册页只关心这一件事：有没有配好能发信的邮箱。 */
export async function mailEnabled() {
  try {
    const cfg = await readMailConfig();
    return Boolean(cfg && cfg.pass);
  } catch {
    return false;
  }
}

// —— 极简 SMTP 客户端 ——
// 只做发信要用的那几步：问候 → EHLO → AUTH → MAIL/RCPT → DATA。响应按行收，多行响应以 "250-" 开头、"250 " 收尾。

class Smtp {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
    this.pending = [];
    this.replies = [];
    this.waiters = [];
    this.error = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(new MailError(`连不上邮件服务器：${err.code ?? err.message}`)));
    socket.on('close', () => this.fail(new MailError('邮件服务器提前断开了连接')));
    socket.setTimeout(REPLY_TIMEOUT_MS, () => this.fail(new MailError(`邮件服务器 ${REPLY_TIMEOUT_MS / 1000} 秒没响应`)));
  }

  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.pending.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.pending };
        this.pending = [];
        this.deliver(reply);
      }
    }
  }

  deliver(reply) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(reply);
    } else {
      this.replies.push(reply);
    }
  }

  fail(err) {
    if (this.error) return;
    this.error = err;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.socket.destroy();
  }

  read() {
    if (this.error) return Promise.reject(this.error);
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new MailError('等邮件服务器响应超时'));
      }, REPLY_TIMEOUT_MS);
      this.waiters.push(waiter);
    });
  }

  async cmd(line, ok, label) {
    this.socket.write(line + '\r\n');
    const reply = await this.read();
    if (!ok.includes(reply.code)) {
      throw new MailError(`${label}失败（${reply.lines.join(' / ')}）`, reply.code);
    }
    return reply;
  }

  async auth(user, pass, caps) {
    const plain = /\bPLAIN\b/i.test(caps);
    const login = /\bLOGIN\b/i.test(caps);
    if (!plain && !login) throw new MailError('邮件服务器没提供可用的登录方式');
    if (plain) {
      await this.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')}`, [235], '登录');
      return;
    }
    await this.cmd('AUTH LOGIN', [334], '登录');
    await this.cmd(Buffer.from(user, 'utf8').toString('base64'), [334], '登录');
    await this.cmd(Buffer.from(pass, 'utf8').toString('base64'), [235], '登录');
  }

  quit() {
    try {
      this.socket.write('QUIT\r\n');
    } catch {
      // 已经断了
    }
    this.socket.end();
  }
}

function connectSmtp(cfg) {
  return new Promise((resolve, reject) => {
    const socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    const onError = (err) => reject(new MailError(`连不上 ${cfg.host}:${cfg.port}（${err.code ?? err.message}）`));
    socket.once('error', onError);
    socket.once(cfg.secure ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

// —— 邮件内容 ——
const ASCII = /^[\x20-\x7e]*$/;

function encodeWord(value) {
  const text = String(value ?? '');
  return ASCII.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function formatAddress(from) {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(from ?? '');
  if (!match) return String(from ?? '').trim();
  const name = match[1].replace(/^"|"$/g, '').trim();
  return name ? `${encodeWord(name)} <${match[2].trim()}>` : `<${match[2].trim()}>`;
}

const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

function buildMessage({ from, to, subject, text }) {
  const domain = String(to).split('@')[1] || 'localhost';
  const headers = [
    `From: ${formatAddress(from)}`,
    `To: <${to}>`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = wrap76(Buffer.from(String(text), 'utf8').toString('base64'));
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

// DATA 里的行如果以 "." 开头要再补一个 "."，否则会被当成结束标记
const dotStuff = (message) =>
  message
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n');

/**
 * 发一封纯文本邮件。config 不传就读 ~/.hlwd/mail.json。
 * 成功返回 {ok:true, code:250}；任何一步不通过都抛 MailError。
 */
export async function sendMail({ to, subject, text, config = null } = {}) {
  const cfg = config ?? (await readMailConfig());
  if (!cfg) throw new MailError('这台机器还没配发信邮箱（~/.hlwd/mail.json）');
  const recipient = trim(to);
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(recipient)) throw new MailError(`收件地址不对：${recipient}`);

  const socket = await connectSmtp(cfg);
  const smtp = new Smtp(socket);
  try {
    const greeting = await smtp.read();
    if (greeting.code !== 220) throw new MailError(`服务器问候异常（${greeting.lines.join(' / ')}）`, greeting.code);
    const ehlo = await smtp.cmd('EHLO hlwd.local', [250], 'EHLO');
    const caps = ehlo.lines.join('\n');
    if (cfg.user) await smtp.auth(cfg.user, cfg.pass, caps);
    await smtp.cmd(`MAIL FROM:<${cfg.user || recipient}>`, [250], '发件人');
    await smtp.cmd(`RCPT TO:<${recipient}>`, [250, 251], '收件人');
    await smtp.cmd('DATA', [354], 'DATA');
    const message = dotStuff(buildMessage({ from: cfg.from || cfg.user, to: recipient, subject, text }));
    socket.write(message + '\r\n.\r\n');
    const done = await smtp.read();
    if (done.code !== 250) throw new MailError(`邮件被服务器拒收（${done.lines.join(' / ')}）`, done.code);
    smtp.quit();
    return { ok: true, code: done.code };
  } finally {
    socket.destroy();
  }
}
