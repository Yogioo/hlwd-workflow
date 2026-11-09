// 工具自身的更新：只对工具仓库做 fetch + fast-forward，不碰当前项目的 git。
// 页面「设置 → 更新」用它；合并成功后由 web/server.mjs 重启看板进程。
import { spawn } from 'node:child_process';
import path from 'node:path';

const GIT_TIMEOUT_MS = Number(process.env.HLWD_UPDATE_TIMEOUT_MS ?? 120000);

function runGit(root, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let child;
    try {
      child = spawn('git', args, {
        cwd: root,
        windowsHide: true,
        // 内网更新不该卡在账号密码提示上：拿不到凭据就明确失败
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      });
    } catch (error) {
      resolve({ code: -1, out, err: error.message, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8').on('data', (data) => (out += data));
    child.stderr.setEncoding('utf8').on('data', (data) => (err += data));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
    child.stdin.end();
  });
}

const firstLine = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function detail(res, fallback) {
  if (res.timedOut) return `git 超过 ${Math.round(GIT_TIMEOUT_MS / 1000)}s 没响应`;
  return firstLine(res.err) || firstLine(res.out) || fallback;
}

const emptyRepo = (root) => ({
  root: path.resolve(root),
  git: false,
  ownRepo: false,
  branch: '',
  remote: '',
  upstream: '',
  target: '',
  commit: '',
  subject: '',
  date: '',
  dirty: false,
  ahead: null,
  behind: null,
  targetExists: false,
  canUpdate: false,
  reason: '',
});

/**
 * 工具仓库的现状：分支、提交、工作区、远端跟踪。
 * 不跑网络；behind / ahead 是上一次 fetch 留下的远端跟踪引用，可能不是最新。
 */
export async function readStatus(root) {
  const dir = path.resolve(root);
  const status = emptyRepo(dir);

  const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) {
    return { ...status, reason: `工具目录不是 git 仓库（${dir}），无法自动更新` };
  }

  const top = (await runGit(dir, ['rev-parse', '--show-toplevel'])).out.trim();
  if (!top || !samePath(top, dir)) {
    return {
      ...status,
      git: true,
      reason: `工具目录不是独立的 git 仓库（它在 ${top || '未知目录'} 里）；为避免误更新父仓库，已禁用自动更新`,
    };
  }

  status.git = true;
  status.ownRepo = true;

  const branchRes = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  status.branch = branchRes.code === 0 ? branchRes.out.trim() : '';

  const log = await runGit(dir, ['log', '-1', '--format=%h%x00%s%x00%cI']);
  if (log.code === 0) {
    const [commit, subject, date] = log.out.split('\0');
    status.commit = commit?.trim() ?? '';
    status.subject = subject?.trim() ?? '';
    status.date = date?.trim() ?? '';
  }

  const dirty = await runGit(dir, ['status', '--porcelain', '--untracked-files=no']);
  status.dirty = dirty.code === 0 ? Boolean(dirty.out.trim()) : true;

  const remotes = (await runGit(dir, ['remote'])).out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const upstreamRes = await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  status.upstream = upstreamRes.code === 0 ? upstreamRes.out.trim() : '';
  status.remote = status.upstream
    ? status.upstream.split('/')[0]
    : remotes.includes('origin')
      ? 'origin'
      : (remotes[0] ?? '');
  status.target = status.upstream || (status.remote && status.branch ? `${status.remote}/${status.branch}` : '');

  if (status.target) {
    const exists = await runGit(dir, ['rev-parse', '--verify', '--quiet', status.target]);
    status.targetExists = exists.code === 0;
    if (status.targetExists) {
      const counts = await runGit(dir, ['rev-list', '--left-right', '--count', `HEAD...${status.target}`]);
      if (counts.code === 0) {
        const [ahead, behind] = counts.out.trim().split(/\s+/).map((n) => Number(n));
        status.ahead = Number.isFinite(ahead) ? ahead : null;
        status.behind = Number.isFinite(behind) ? behind : null;
      }
    }
  } else {
    status.targetExists = false;
  }

  if (!status.branch) {
    status.reason = '工具仓库当前是 detached HEAD（没有在某个分支上），没法快进更新';
  } else if (status.dirty) {
    status.reason = '工具仓库有未提交的改动；先提交或还原，自动更新不会覆盖本地文件';
  } else if (!status.remote) {
    status.reason = '工具仓库没有配置 git remote，无法获取最新版本';
  } else if (!status.targetExists) {
    status.reason = `远端分支 ${status.target} 还不存在；先确认仓库地址和当前分支`;
  } else if (status.ahead > 0 && status.behind > 0) {
    status.reason = `本地和远端已分叉（领先 ${status.ahead} 个、落后 ${status.behind} 个提交），快进合并不了，需要人工处理`;
  }

  status.canUpdate = Boolean(
    status.ownRepo &&
      status.branch &&
      !status.dirty &&
      status.remote &&
      status.targetExists &&
      !(status.ahead > 0 && status.behind > 0),
  );
  return status;
}

/** 去远端看一眼。fetch 只改远端跟踪引用，不动工作区；失败也把本地现状带回去。 */
export async function checkUpdates(root) {
  const before = await readStatus(root);
  const checkedAt = new Date().toISOString();
  if (!before.git || !before.ownRepo || !before.branch || !before.remote) {
    return { repo: before, checkedAt, error: '' };
  }
  const fetched = await runGit(before.root, ['fetch', '--prune', before.remote]);
  if (fetched.code !== 0) {
    return { repo: before, checkedAt, error: `拉取远端失败：${detail(fetched, `git fetch 退出码 ${fetched.code}`)}` };
  }
  return { repo: await readStatus(before.root), checkedAt, error: '' };
}

/**
 * 拉取并快进。只做 ff-only：本地有分叉、工作区脏、或远端有冲突时都拒绝，
 * 绝不用 reset / checkout --force 把用户文件丢掉。
 */
export async function applyUpdates(root) {
  const checked = await checkUpdates(root);
  const repo = checked.repo;
  const fail = (code, error) => ({ ok: false, code, error, repo, checkedAt: checked.checkedAt });

  if (checked.error) return fail(502, checked.error);
  if (!repo.git || !repo.ownRepo) return fail(400, repo.reason || '工具目录不是 git 仓库');
  if (!repo.branch) return fail(409, repo.reason);
  if (repo.dirty) return fail(409, repo.reason);
  if (!repo.remote) return fail(409, repo.reason);
  if (!repo.targetExists) return fail(409, repo.reason);
  if (repo.ahead > 0 && repo.behind > 0) return fail(409, repo.reason);
  if (!repo.behind) {
    return { ok: true, updated: false, from: repo.commit, to: repo.commit, repo, checkedAt: checked.checkedAt };
  }

  const before = repo.commit;
  const merged = await runGit(repo.root, ['merge', '--ff-only', repo.target]);
  if (merged.code !== 0) {
    return fail(409, `快进合并失败：${detail(merged, `git merge 退出码 ${merged.code}`)}。工作区没有被 reset，手动处理后再试`);
  }

  const after = await readStatus(repo.root);
  return {
    ok: true,
    updated: after.commit !== before,
    from: before,
    to: after.commit,
    repo: after,
    checkedAt: new Date().toISOString(),
  };
}
