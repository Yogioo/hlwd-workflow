// 账号与会话：属于**这台机器上的看板**，不跟着项目走 —— 一个人一个身份，切项目还是你。
// 存在 ~/.hlwd/ 下（跟 state.json / board.json 同级，不进任何项目仓库）：
//   users.json     账号（scrypt 加盐存的密码，不存明文）
//   sessions.json  登录会话（cookie 里存的是随机 token，不是密码）
// 权限先不做，但用户记录里留了 role：第一个注册的人是 owner，后面都是 member；
// 以后要判权限，只需要在这里加规则，页面不用改。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

const DEFAULT_DIR = process.env.HLWD_HOME ? path.resolve(process.env.HLWD_HOME) : path.join(os.homedir(), '.hlwd');

let storeDir = DEFAULT_DIR;
let usersFile = path.join(storeDir, 'users.json');
let sessionsFile = path.join(storeDir, 'sessions.json');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 记住 30 天，局域网自用够了
const MIN_PASSWORD = 6;
const NAME_RE = /^[\w.\-\u4e00-\u9fa5]{2,24}$/; // 字母数字下划线中文点横线，2~24

export const SESSION_COOKIE = 'wf_session';
export const SESSION_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** 测试用：换一个存账号的目录（默认 ~/.hlwd）。 */
export function setStoreDir(dir) {
  storeDir = path.resolve(dir);
  usersFile = path.join(storeDir, 'users.json');
  sessionsFile = path.join(storeDir, 'sessions.json');
  usersCache = null;
  sessionsCache = null;
}

// 进程内缓存：看板是单进程，写的时候同步落到磁盘，读就不用每次都碰文件
let usersCache = null;
let sessionsCache = null;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  // 密码哈希虽然加盐了，也没必要让同机其他人读到
  await fs.chmod(file, 0o600).catch(() => {});
}

const loadUsers = async () => (usersCache ??= (await readJson(usersFile, { users: [] })).users ?? []);

async function saveUsers(users) {
  usersCache = users;
  await writeJson(usersFile, { users });
}

async function loadSessions() {
  if (sessionsCache) return sessionsCache;
  const raw = (await readJson(sessionsFile, { sessions: {} })).sessions ?? {};
  const now = Date.now();
  const live = {};
  for (const [token, session] of Object.entries(raw)) {
    if (session?.name && now - Number(session.createdAt ?? 0) < SESSION_TTL_MS) live[token] = session;
  }
  sessionsCache = live;
  return live;
}

async function saveSessions(sessions) {
  sessionsCache = sessions;
  await writeJson(sessionsFile, { sessions });
}

const scryptHash = async (password, salt) => (await scrypt(password, salt, 64)).toString('hex');

const publicUser = (user) =>
  user ? { name: user.name, display: user.display || user.name, role: user.role || 'member', createdAt: user.createdAt } : null;

export { publicUser };

/** 账号数（第一个注册的人是 owner）。 */
export async function countUsers() {
  return (await loadUsers()).length;
}

export async function listUsers() {
  return (await loadUsers()).map(publicUser);
}

export async function findUser(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return (await loadUsers()).find((u) => u.name.toLowerCase() === key) ?? null;
}

/**
 * 注册。第一个账号自动是 owner。
 * 用户名大小写不敏感（登录时不折腾），但显示时保留原样。
 */
export async function register({ name, display, password } = {}) {
  const login = String(name ?? '').trim();
  if (!NAME_RE.test(login)) throw new AuthError('用户名要 2~24 位，只能是字母、数字、下划线、点、横线或中文');
  const pass = String(password ?? '');
  if (pass.length < MIN_PASSWORD) throw new AuthError(`密码至少 ${MIN_PASSWORD} 位`);
  const users = await loadUsers();
  if (users.some((u) => u.name.toLowerCase() === login.toLowerCase())) throw new AuthError('这个用户名已经被注册了');

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    name: login,
    display: String(display ?? '').trim().slice(0, 32) || login,
    salt,
    hash: await scryptHash(pass, salt),
    role: users.length ? 'member' : 'owner',
    createdAt: new Date().toISOString(),
  };
  await saveUsers([...users, user]);
  return publicUser(user);
}

/** 登录：用户名大小写不敏感，密码用固定时间比较（别用 === 泄漏时序）。 */
export async function verify({ name, password } = {}) {
  const user = await findUser(name);
  const pass = String(password ?? '');
  // 用户不存在也走一遍哈希，避免靠耗时区分「没这个人」和「密码错」
  const salt = user?.salt ?? 'x'.repeat(32);
  const hash = await scryptHash(pass || 'x', salt);
  const same =
    Boolean(user) && hash.length === user.hash.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.hash));
  if (!same) throw new AuthError('用户名或密码不对', 401);
  return publicUser(user);
}

/** 给已登录的人换显示名（自己改自己）。 */
export async function renameUser(name, display) {
  const users = await loadUsers();
  const user = users.find((u) => u.name.toLowerCase() === String(name ?? '').toLowerCase());
  if (!user) throw new AuthError('账号不存在', 404);
  user.display = String(display ?? '').trim().slice(0, 32) || user.name;
  await saveUsers(users);
  return publicUser(user);
}

// —— 会话 ——

export async function createSession(name) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = { ...(await loadSessions()) };
  sessions[token] = { name, createdAt: Date.now() };
  await saveSessions(sessions);
  return token;
}

/** token → 用户；账号被删了就当没登录。 */
export async function readSession(token) {
  if (!token) return null;
  const sessions = await loadSessions();
  const session = sessions[token];
  if (!session) return null;
  const user = await findUser(session.name);
  return user ? publicUser(user) : null;
}

export async function dropSession(token) {
  if (!token) return;
  const sessions = { ...(await loadSessions()) };
  if (!sessions[token]) return;
  delete sessions[token];
  await saveSessions(sessions);
}

/** 改密码（顺手踢掉其他设备：旧会话全作废，除了当前这个）。 */
export async function changePassword(name, oldPassword, newPassword, keepToken) {
  const users = await loadUsers();
  const user = users.find((u) => u.name.toLowerCase() === String(name ?? '').toLowerCase());
  if (!user) throw new AuthError('账号不存在', 404);
  await verify({ name: user.name, password: oldPassword });
  const pass = String(newPassword ?? '');
  if (pass.length < MIN_PASSWORD) throw new AuthError(`密码至少 ${MIN_PASSWORD} 位`);
  const salt = crypto.randomBytes(16).toString('hex');
  user.salt = salt;
  user.hash = await scryptHash(pass, salt);
  await saveUsers(users);

  const sessions = { ...(await loadSessions()) };
  for (const token of Object.keys(sessions)) {
    if (token !== keepToken && sessions[token].name.toLowerCase() === user.name.toLowerCase()) delete sessions[token];
  }
  await saveSessions(sessions);
  return publicUser(user);
}
