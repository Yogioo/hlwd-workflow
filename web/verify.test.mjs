// web/verify.mjs：验证码的生命周期、限流、过期与作废（发信函数注入，不真发邮件）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-verify-'));
process.env.HLWD_HOME = home;
await fs.writeFile(
  path.join(home, 'mail.json'),
  JSON.stringify({
    host: '127.0.0.1',
    port: 2525,
    secure: false,
    user: 'bot@hellowd.net',
    pass: 'x',
    from: 'HLWD 看板 <bot@hellowd.net>',
    allowDomains: ['hellowd.net'],
  }),
);

const { issueCode, consumeCode, setNow, setSender, setStoreDir } = await import('./verify.mjs');
setStoreDir(home);

let now = Date.parse('2026-11-09T02:00:00Z');
setNow(() => now);

const sent = [];
setSender(async (message) => {
  sent.push(message);
});

async function reset() {
  await fs.rm(path.join(home, 'codes.json'), { force: true });
  sent.length = 0;
}

const codeOf = (message) => /验证码：(\d{6})/.exec(message.text)[1];

test('发码 → 收码人正确、正文有 6 位码；用掉后不能再用', async () => {
  await reset();
  const out = await issueCode({ email: 'PengYunJie@Hellowd.net', ip: '10.0.0.2' });
  assert.equal(out.ok, true);
  assert.equal(out.cooldown, 60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'pengyunjie@hellowd.net', '邮箱按小写存/发');
  assert.match(sent[0].subject, /注册验证码/);
  const code = codeOf(sent[0]);

  const raw = await fs.readFile(path.join(home, 'codes.json'), 'utf8');
  assert.ok(!raw.includes(code), '文件里不能出现验证码明文');

  await consumeCode({ email: 'pengyunjie@hellowd.net', code });
  await assert.rejects(() => consumeCode({ email: 'pengyunjie@hellowd.net', code }), /不对或已经过期/);
});

test('错 5 次就作废，即使后来填对也不行', async () => {
  await reset();
  await issueCode({ email: 'a@hellowd.net', ip: '10.0.0.3' });
  const code = codeOf(sent[0]);
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => consumeCode({ email: 'a@hellowd.net', code: '000000' === code ? '111111' : '000000' }));
  }
  await assert.rejects(() => consumeCode({ email: 'a@hellowd.net', code }), /作废|不对|过期/);
});

test('冷却按邮箱算：码用掉后计数不归零，60 秒内不能再取', async () => {
  await reset();
  await issueCode({ email: 'b@hellowd.net', ip: '10.0.0.4' });
  const code = codeOf(sent[0]);
  await consumeCode({ email: 'b@hellowd.net', code });
  await assert.rejects(() => issueCode({ email: 'b@hellowd.net' }), (err) => err.status === 429 && /秒后再试/.test(err.message));
  now += 61_000;
  await issueCode({ email: 'b@hellowd.net' });
});

test('10 分钟后过期', async () => {
  await reset();
  await issueCode({ email: 'c@hellowd.net', ip: '10.0.0.5' });
  const code = codeOf(sent[0]);
  now += 11 * 60_000;
  await assert.rejects(() => consumeCode({ email: 'c@hellowd.net', code }), /过期/);
});

test('发信失败：这次不留下码，冷却也退掉，换好配置能立刻重试', async () => {
  await reset();
  setSender(async () => {
    throw new Error('SMTP 503');
  });
  await assert.rejects(() => issueCode({ email: 'f@hellowd.net' }), /没发出去/);
  setSender(async (message) => {
    sent.push(message);
  });
  await issueCode({ email: 'f@hellowd.net' });
  assert.equal(sent.length, 1, '不会被刚才的失败卡 60 秒');
});

test('邮箱里有路径字符直接拒绝（它会当文件名用）', async () => {
  await reset();
  await assert.rejects(() => issueCode({ email: 'a/b@hellowd.net' }), /邮箱格式不对/);
});

test('只允许配置里的公司域名', async () => {
  await reset();
  await assert.rejects(() => issueCode({ email: 'someone@gmail.com' }), /只允许 @hellowd\.net/);
  assert.equal(sent.length, 0, '没发信');
});

test('同一邮箱一小时最多 5 封', async () => {
  await reset();
  for (let i = 0; i < 5; i += 1) {
    await issueCode({ email: 'd@hellowd.net', ip: '10.0.0.6' });
    await consumeCode({ email: 'd@hellowd.net', code: codeOf(sent.at(-1)) });
    now += 61_000;
  }
  await assert.rejects(() => issueCode({ email: 'd@hellowd.net' }), /一小时内取得太多了/);
});

test('找回密码的邮件措辞不一样，但共用同一套码', async () => {
  await reset();
  await issueCode({ email: 'e@hellowd.net', purpose: 'reset' });
  assert.match(sent[0].subject, /密码重置验证码/);
  assert.match(sent[0].text, /重置密码/);
  await consumeCode({ email: 'e@hellowd.net', code: codeOf(sent[0]) });
});
