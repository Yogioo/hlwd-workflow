// 邮箱验证码：注册和找回密码共用一套。
// 状态属于这台机器：~/.hlwd/codes.json（0600，跟 users.json 同级），不进项目、不进 beads。
// 只存 sha256(salt + code)，不存明文；过期、重试次数、发送冷却、每邮箱/每 IP 限流都在这里判。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMailConfig, sendMail } from './mail.mjs';

const DEFAULT_DIR = process.env.HLWD_HOME ? path.resolve(process.env.HLWD_HOME) : path.join(os.homedir(), '.hlwd');

const CODE_TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const PER_EMAIL_HOUR = 5;
const PER_IP_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
// 跟 auth.mjs 一个口径：邮箱会当文件名用，别让路径字符混进来
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

let storeDir = DEFAULT_DIR;
let codesFile = path.join(storeDir, 'codes.json');
let sender = sendMail;
let clock = () => Date.now();
let chain = Promise.resolve();

export class VerifyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'VerifyError';
    this.status = status;
  }
}

/** 测试用：换存验证码的目录 / 换发信函数 / 换时钟。 */
export function setStoreDir(dir) {
  storeDir = path.resolve(dir);
  codesFile = path.join(storeDir, 'codes.json');
}
export function setSender(fn) {
  sender = fn ?? sendMail;
}
export function setNow(fn) {
  clock = fn ?? (() => Date.now());
}

export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

/** 同一进程里把「读 → 判 → 写」串起来，避免两个请求同时发码/验码打架。 */
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function load() {
  let data = {};
  try {
    data = JSON.parse((await fs.readFile(codesFile, 'utf8')).replace(/^\uFEFF/, '')) ?? {};
  } catch (err) {
    if (err.code !== 'ENOENT') throw new VerifyError(`验证码文件读不出来：${err.message}`, 500);
  }
  const now = clock();
  const fresh = (list) => (Array.isArray(list) ? list : []).filter((ts) => Number.isFinite(ts) && now - ts < HOUR_MS);
  const codes = {};
  for (const [email, entry] of Object.entries(data.codes ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) continue;
    codes[email] = entry;
  }
  const sent = {};
  for (const [email, list] of Object.entries(data.sent ?? {})) {
    const recent = fresh(list);
    if (recent.length) sent[email] = recent;
  }
  const ips = {};
  for (const [ip, list] of Object.entries(data.ips ?? {})) {
    const recent = fresh(list);
    if (recent.length) ips[ip] = recent;
  }
  return { codes, sent, ips };
}

async function save(data) {
  await fs.mkdir(path.dirname(codesFile), { recursive: true });
  await fs.writeFile(codesFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.chmod(codesFile, 0o600).catch(() => {});
}

const hashOf = (salt, code) => crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');

/** 允许注册的域名：mail.json 的 allowDomains；没写就只允许发件邮箱自己的域名。 */
export function allowedDomains(cfg) {
  if (cfg?.allowDomains?.length) return cfg.allowDomains;
  const from = String(cfg?.from ?? cfg?.user ?? '');
  const match = /@([^<>\s]+)/.exec(from);
  return match ? [match[1].toLowerCase()] : [];
}

function domainOf(email) {
  return email.slice(email.indexOf('@') + 1);
}

/**
 * 发一个验证码。purpose 只影响邮件措辞（register / reset）。
 * 返回 {ok, cooldown, ttl}；发信失败会抛 502，并清掉这次没送到的码（允许马上重试）。
 */
export function issueCode({ email, ip = '', purpose = 'register' } = {}) {
  return serial(async () => {
    const addr = normalizeEmail(email);
    if (!EMAIL_RE.test(addr)) throw new VerifyError('邮箱格式不对');
    const cfg = await readMailConfig();
    if (!cfg || !cfg.pass) throw new VerifyError('这台看板还没配好发信邮箱（~/.hlwd/mail.json）', 503);
    const domains = allowedDomains(cfg);
    if (domains.length && !domains.includes(domainOf(addr))) {
      throw new VerifyError(`只允许 ${domains.map((d) => '@' + d).join(' / ')} 的邮箱`);
    }

    const now = clock();
    const data = await load();
    // 冷却和每小时配额跟着「这个邮箱」走，不跟具体某个码走：
    // 否则验证码用掉后计数被清空，可以无限重取。
    const sent = data.sent[addr] ?? [];
    const last = sent[sent.length - 1];
    if (last && now - last < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
      throw new VerifyError(`验证码刚发过，${wait} 秒后再试`, 429);
    }
    if (sent.length >= PER_EMAIL_HOUR) throw new VerifyError('这个邮箱一小时内取得太多了，稍后再试', 429);
    const ipKey = String(ip ?? '');
    const ipRecent = ipKey ? data.ips[ipKey] ?? [] : [];
    if (ipKey && ipRecent.length >= PER_IP_HOUR) throw new VerifyError('这台机器请求太频繁，稍后再试', 429);

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('hex');
    data.codes[addr] = {
      salt,
      hash: hashOf(salt, code),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      sentAt: now,
    };
    data.sent[addr] = [...sent, now];
    if (ipKey) data.ips[ipKey] = [...ipRecent, now];
    await save(data);

    const subject = purpose === 'reset' ? 'HLWD 看板密码重置验证码' : 'HLWD 看板注册验证码';
    const action = purpose === 'reset' ? '重置密码' : '注册';
    const text = [
      `你正在${action} HLWD 工单看板。`,
      '',
      `验证码：${code}`,
      '',
      '10 分钟内有效，只能使用一次。',
      '如果这不是你本人操作，忽略这封信即可，你的账号不会有任何变化。',
    ].join('\n');

    try {
      await sender({ to: addr, subject, text, config: cfg });
    } catch (err) {
      // 没送到的码不留，冷却也一起退掉：用户换好配置可以马上重试
      delete data.codes[addr];
      data.sent[addr] = (data.sent[addr] ?? []).filter((ts) => ts !== now);
      if (!data.sent[addr].length) delete data.sent[addr];
      if (ipKey) {
        data.ips[ipKey] = (data.ips[ipKey] ?? []).filter((ts) => ts !== now);
        if (!data.ips[ipKey].length) delete data.ips[ipKey];
      }
      await save(data).catch(() => {});
      throw new VerifyError(`验证码邮件没发出去：${err.message}`, 502);
    }
    return { ok: true, cooldown: Math.floor(COOLDOWN_MS / 1000), ttl: Math.floor(CODE_TTL_MS / 1000) };
  });
}

/** 验码并作废（一次性）。错 5 次直接把这个码废掉。 */
export function consumeCode({ email, code } = {}) {
  return serial(async () => {
    const addr = normalizeEmail(email);
    const given = String(code ?? '').trim();
    const data = await load();
    const entry = data.codes[addr];
    if (!entry) throw new VerifyError('验证码不对或已经过期，请重新获取');
    if (clock() > Number(entry.expiresAt ?? 0)) {
      delete data.codes[addr];
      await save(data);
      throw new VerifyError('验证码过期了，请重新获取');
    }
    if (!/^\d{6}$/.test(given)) throw new VerifyError('验证码是 6 位数字');

    const expected = Buffer.from(String(entry.hash), 'hex');
    const actual = Buffer.from(hashOf(entry.salt, given), 'hex');
    const same = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!same) {
      entry.attempts = Number(entry.attempts ?? 0) + 1;
      if (entry.attempts >= MAX_ATTEMPTS) delete data.codes[addr];
      await save(data);
      throw new VerifyError(entry.attempts >= MAX_ATTEMPTS ? '错太多次了，这个验证码已作废，请重新获取' : '验证码不对');
    }
    delete data.codes[addr];
    await save(data);
    return { ok: true };
  });
}