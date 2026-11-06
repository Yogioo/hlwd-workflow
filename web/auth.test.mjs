// web/auth.mjs 的单元测试：注册校验、密码比对、会话生命周期、改密码、角色。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AuthError,
  changePassword,
  countUsers,
  createSession,
  dropSession,
  findUser,
  listUsers,
  publicUser,
  readSession,
  register,
  renameUser,
  setStoreDir,
  verify,
} from './auth.mjs';

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-auth-'));
  setStoreDir(dir);
  try {
    await fn(dir);
  } finally {
    setStoreDir(path.join(os.tmpdir(), 'hlwd-auth-unused'));
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('注册：校验用户名与密码，第一个账号是 owner', async () => {
  await withStore(async () => {
    assert.equal(await countUsers(), 0);

    await assert.rejects(() => register({ name: 'a', password: 'secret1' }), /2~24 位/);
    await assert.rejects(() => register({ name: '有空格 的名字', password: 'secret1' }), /2~24 位/);
    await assert.rejects(() => register({ name: 'alice', password: '123' }), /至少 6 位/);

    const alice = await register({ name: 'alice', display: '爱丽丝', password: 'secret1' });
    assert.equal(alice.name, 'alice');
    assert.equal(alice.display, '爱丽丝');
    assert.equal(alice.role, 'owner', '第一个注册的人是管理员');
    assert.equal(await countUsers(), 1);

    const bob = await register({ name: 'bob', password: 'secret2' });
    assert.equal(bob.role, 'member');
    assert.equal(bob.display, 'bob', '没填显示名就用用户名');

    // 重名大小写不敏感
    await assert.rejects(() => register({ name: 'ALICE', password: 'secret3' }), /已经被注册/);
  });
});

test('注册：密码只存 salt + hash，不存明文，也不往外吐', async () => {
  await withStore(async (dir) => {
    await register({ name: 'alice', password: 'secret1' });
    const raw = await fs.readFile(path.join(dir, 'users.json'), 'utf8');
    assert.ok(!raw.includes('secret1'), '文件里不能有明文密码');
    const saved = JSON.parse(raw).users[0];
    assert.match(saved.salt, /^[0-9a-f]{32}$/);
    assert.match(saved.hash, /^[0-9a-f]{128}$/);

    const user = await findUser('alice');
    const pub = publicUser(user);
    assert.deepEqual(Object.keys(pub).sort(), ['createdAt', 'display', 'name', 'role']);
    assert.equal(pub.hash, undefined);
    assert.equal(pub.salt, undefined);

    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(dir, 'users.json'))).mode & 0o777, 0o600);
    }
  });
});

test('登录：密码错 / 没这个人都 401，且都走一遍哈希', async () => {
  await withStore(async () => {
    await register({ name: 'alice', display: '爱丽丝', password: 'secret1' });
    const ok = await verify({ name: 'alice', password: 'secret1' });
    assert.equal(ok.name, 'alice');
    assert.equal(ok.display, '爱丽丝');
    // 用户名大小写不敏感
    assert.equal((await verify({ name: 'ALICE', password: 'secret1' })).name, 'alice');

    await assert.rejects(() => verify({ name: 'alice', password: 'nope-nope' }), (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.status, 401);
      assert.match(err.message, /用户名或密码/);
      return true;
    });
    await assert.rejects(() => verify({ name: 'nobody', password: 'secret1' }), (err) => {
      assert.equal(err.status, 401);
      assert.match(err.message, /用户名或密码/, '不暴露「没这个人」');
      return true;
    });
  });
});

test('会话：签发 / 读回 / 退出 / 过期自动清掉', async () => {
  await withStore(async (dir) => {
    await register({ name: 'alice', password: 'secret1' });
    const token = await createSession('alice');
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal((await readSession(token)).name, 'alice');
    assert.equal(await readSession('不存在的 token'), null);

    // 会话写在磁盘上：看板重启不会把所有人踢下线
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'sessions.json'), 'utf8'));
    assert.ok(saved.sessions[token]);

    // 过期的不认
    const old = { sessions: { [token]: { name: 'alice', createdAt: Date.now() - 31 * 24 * 3600 * 1000 } } };
    await fs.writeFile(path.join(dir, 'sessions.json'), JSON.stringify(old));
    setStoreDir(dir); // 丢掉进程内缓存，重新从磁盘读
    assert.equal(await readSession(token), null, '30 天前的会话不该还有效');

    // 退出
    const fresh = await createSession('alice');
    assert.equal((await readSession(fresh)).name, 'alice');
    await dropSession(fresh);
    assert.equal(await readSession(fresh), null);

    // 账号没了，会话也不算数
    const ghost = await createSession('ghost-name');
    assert.equal(await readSession(ghost), null);
  });
});

test('改密码：旧密码要验对，换完全踢掉其他设备', async () => {
  await withStore(async () => {
    await register({ name: 'alice', password: 'secret1' });
    const phone = await createSession('alice');
    const laptop = await createSession('alice');

    await assert.rejects(() => changePassword('alice', 'wrong-one', 'newsecret'), /用户名或密码/);
    await assert.rejects(() => changePassword('alice', 'secret1', '123'), /至少 6 位/);

    await changePassword('alice', 'secret1', 'newsecret', laptop);
    assert.equal((await readSession(laptop))?.name, 'alice', '当前这台设备不用重登');
    assert.equal(await readSession(phone), null, '其他设备要重新登录');
    await assert.rejects(() => verify({ name: 'alice', password: 'secret1' }), /用户名或密码/);
    assert.equal((await verify({ name: 'alice', password: 'newsecret' })).name, 'alice');
  });
});

test('改显示名：不影响登录名，也不接受空', async () => {
  await withStore(async () => {
    await register({ name: 'alice', display: '爱丽丝', password: 'secret1' });
    const renamed = await renameUser('alice', '爱丽丝·王');
    assert.equal(renamed.display, '爱丽丝·王');
    assert.equal(renamed.name, 'alice');
    assert.equal((await renameUser('alice', '  ')).display, 'alice', '空名字回落到登录名');
    assert.equal((await listUsers()).length, 1);
    await assert.rejects(() => renameUser('nobody', 'x'), /账号不存在/);
  });
});
