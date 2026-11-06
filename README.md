# hlwd-workflow

> 一个**本地**工具：网页看板 + AI 工作流。
> 人建单 → AI 接单 → 执行 → **门禁** → 审查 → 提交关单，全过程可追溯。

它自己不存业务数据：工单在你打开的**项目目录**里（beads 数据库），运行记录在项目的 `.hlwd/`。换项目就换一整套数据，工具本身不用改。

- 零依赖：只用 Node 标准库，没有 npm 依赖、没有构建步骤
- 单页看板：建单 / 改单 / 一键派单 / 看全链路 / 看 AI 会话 / 账号登录 / 内网分享
- 门禁可编程：每个项目自带 `.hlwd/gate.mjs`，返回值决定「这一轮算不算过关」
- 自动流水线：开了之后有就绪单就自己干，不用守终端

---

## 1. 前置依赖

| 依赖 | 用途 | 安装 |
|---|---|---|
| Node.js **≥ 20** | 跑工具本身 | https://nodejs.org |
| `bd`（beads） | 工单存储，每个项目一份 | `npm i -g @beads/bd` |
| AI CLI 一个 | 真正干活（`pi` / `codex` / `cursor-agent`） | 自己装，能命令行跑通就行（本仓库实测用 `pi`） |
| `agent-tools` | 把一次 agent 回合规范化 | **已随仓库自带**，不用装 |

### 装 beads（`bd`）—— 工单存储

`bd` 是命令行 issue tracker：每个项目一份 `.beads/`，用内嵌数据库存数据，不联网、无服务端。

```bash
npm i -g @beads/bd
bd --version          # 本仓库实测：bd version 1.1.2（更新版本也可以用）
```

| 平台 | 装完确认 | 找不到时 |
|---|---|---|
| Windows | `where bd` → `...\npm\bd.exe` | `set BD_BIN=C:\path\to\bd.exe`（PowerShell：`$env:BD_BIN=...`） |
| macOS / Linux | `which bd` → `/usr/local/bin/bd` | `export BD_BIN=/path/to/bd` |

升级：`npm i -g @beads/bd@latest`，再 `bd --version` 确认。

**第一次打开项目时工具会自己跑：**

```bash
bd init --prefix <目录名> --non-interactive --skip-agents --skip-hooks
```

所以你不需要手动 `bd init`。它会顺手建三样东西，都属于项目、都该进版本库：

1. `.beads/`（工单数据 + 配置，随项目进版本库，团队拉一次就有同一份工单）
2. 项目的 `.gitignore`
3. **`git init` + 一次提交**（`bd init: initialize beads issue tracking`）—— bd 基于 git 工作；你的项目本来就是 git 仓库的话它不会覆盖

工具与 `bd` 的分工：工单的增删改查**只用 `bd` CLI**（`web/beads.mjs` 是唯一调用处），不直连数据库文件；`review` 这个自定义状态靠 `bd config set status.custom "review:wip"` 注册。

### agent-tools 为什么自带

`agent-tools` 是作者本人的工具包（上游 [Yogioo/agent-skills](https://github.com/Yogioo/agent-skills)，未发布到 npm）。
为了让你 clone 下来就能用，它被复制在 `vendor/agent-tools/`（约 0.5 MB，零依赖），版本与来源见 [vendor/agent-tools/VENDORED.md](vendor/agent-tools/VENDORED.md)。

解析顺序：`AGENT_TOOLS_BIN` > `vendor/agent-tools/` > PATH 里的全局安装。

想换成自己的实现？`engine` 只依赖这个命令的**参数约定**：

```
agent-tools agent-run run --runner <pi|codex|agent> --workdir <目录> \
  --prompt-file <文件> --out-dir <新目录> --sandbox <read-only|workspace-write|danger-full-access> \
  [--model M] [--thinking T] [--timeout 毫秒]
```

- 成功时退出码 `0`，最后一行 stdout 是一段 JSON（工具读其中的 `exitCode` / `timedOut` / `aborted`）
- `--out-dir` 必须是**新目录**，它会拒绝已存在的目录
- 包装你手头的 AI CLI 成这个形状，用 `AGENT_TOOLS_BIN` 指过去就能用

自检：

```bash
node vendor/agent-tools/bin/agent-tools.mjs agent-run capabilities   # 看支持哪些 runner
BD_BIN=/path/to/bd AGENT_TOOLS_BIN=/path/to/agent-tools node wf.mjs # 自定义路径
```

---

## 2. 完整链路：从零到关单

下面每一步都给了实际输出（Windows 上真的跑过一遍），照着做能走完全链路。

### 2.1 准备

```bash
git clone https://github.com/Yogioo/hlwd-workflow.git
cd hlwd-workflow
```

后面都在这个目录里跑，`--project` 指向你要开发的项目（不存在就先 `mkdir` 一个空目录）。
不想每次 `cd`，可以定义个别名：`WF="node $PWD/wf.mjs"`，之后用 `$WF --project ...`。

### 2.2 打开项目（第一次）

```bash
node wf.mjs --project /path/to/your/project
```

```
项目 /path/to/your/project（补齐 .hlwd/、.hlwd/config.json、.hlwd/prompts/、.hlwd/prompts/execute.md、
                      .hlwd/prompts/review.md、.hlwd/gate.mjs、.hlwd/runs/、.beads/（bd init）、.hlwd/.gitignore）
工单 0 张：待接 0 · 执行中 0 · 待审 0 · 已完成 0
就绪 0 张
```

空目录打开后会长这样：

```
.hlwd/  config.json  prompts/{execute,review}.md  gate.mjs  runs/
.beads/ 工单数据（bd 管的）
```

看板还没起，所以这行会显示「看板 未启动」；补齐的路径只会在第一次出现。

### 2.3 建单

```bash
node wf.mjs new "写一份 README.md" "在项目根建 README.md，标题 # Demo，下面一行说明"
node wf.mjs                      # 看清单
```

```
已建单 demo-ckv  写一份 README.md
下一步：node wf.mjs work         （或 node wf.mjs work --id demo-ckv）

项目 /path/to/your/project
工单 1 张：待接 1 · 执行中 0 · 待审 0 · 已完成 0
就绪 1 张
  · demo-ckv  写一份 README.md  [中]

看板 未启动
自动流水线 关

下一步
  node wf.mjs board            起看板，建单 / 看全链路
  node wf.mjs watch --bg       自动流水线：有就绪单就自动开干
  node wf.mjs work             让 AI 干下一张就绪单
```

「就绪」= 状态是**待接**且带了 `ready-for-agent` 标签。`new` 会自动打上这个标签；在看板里建的单，点面板上的「让 AI 干这个」也能拿到。

### 2.4 让 AI 干（执行 → 门禁 → 审查 → 提交）

```bash
node wf.mjs work
```

```
[10:34:03] 项目 /path/to/your/project
[10:34:05] 接单 demo-ckv — 写一份 README.md
[10:34:05] 运行目录 .hlwd\runs\demo-ckv-1793961245895
[10:34:05] 执行（第 1 轮）→ .hlwd\runs\...\prompt-exec-1.md
[10:34:14] 执行回合结束 → ...\exec-1                 ← AI 改完了
[10:34:14] 门禁通过（37ms）：默认门禁：不做任何检查，直接放行
[10:34:14] 审查（第 1 轮）→ .hlwd\runs\...\prompt-review-1.md
[10:34:31] 审查结论 pass：README.md 仅含一级标题 "# Demo" 与一行说明，范围与工单一致
[10:34:31] 已提交 3c97eec
[10:34:32] 关闭 demo-ckv
```

这一次 `work` 干了什么：认领 → 调 AI 改文件 → 跑门禁 → 另起一个回合审查 → commit → 关单。

### 2.5 验收（别只看日志）

```bash
git log --oneline --stat        # 每个提交都带 Card: / Run:，方便反查
git log -1 --format=%B
```

```
demo-ckv: 写一份 README.md

Card: demo-ckv
Run: .hlwd/runs/demo-ckv-1793961245895
```

```bash
node wf.mjs trace demo-ckv      # 终端看全链路
```

```
demo-ckv  写一份 README.md
状态 已完成（closed） · 负责人 ai · 优先级 中

状态变更
  11/6 18:34  待接
  11/6 18:34  执行中 · ai
  11/6 18:34  已完成 · ai

运行 demo-ckv-1793961245895  26.6s  → closed  提交 3c97eec
  #1 执行 8.4s ok
  #1 门禁 38ms pass — 默认门禁：不做任何检查，直接放行
  #1 审查 16.7s pass — README.md 仅含一级标题…
       · git status --porcelain → 仅新增 ?? README.md
       · cat README.md → "# Demo" + 空行 + "演示用项目仓库。"
       … 共 5 条验证，见 run.json
  产物 .hlwd/runs/demo-ckv-1793961245895/
```

各阶段原始产物都在 `.hlwd/runs/<卡片>-<时间>/`：提示词、AI 事件、`gate-1.log`、`verdict-1.json`、`run.json`。

### 2.6 加一道真门禁（可选，但建议）

把项目里的 `.hlwd/gate.mjs` 换成会跑测试的版本：

```js
import { spawnSync } from 'node:child_process';

export default async function gate({ workdir }) {
  const r = spawnSync('npm', ['test'], { cwd: workdir, shell: true, encoding: 'utf8' });
  if (r.status === 0) return { pass: true, reason: 'npm test 全绿' };
  return { pass: false, reason: (r.stderr || r.stdout || 'npm test 失败').slice(-800) };
}
```

之后每张单都要先过 `npm test`：不过就把失败信息发回给 AI，让它在同一个工作区继续改（最多 `attempts` 轮，默认 2）。

### 2.7 接着跑：看板 / 自动流水线

```bash
node wf.mjs board --bg          # 看板 http://127.0.0.1:3100（npm start）
node wf.mjs watch --bg          # 自动流水线：有就绪单就自己干（npm run watch）
node wf.mjs stop                # 停看板 + 请求停流水线
```

之后你只需要在看板上建单、点「让 AI 干这个」。

---

## 3. 一次 `work` 里发生了什么

```
open ──ready-for-agent──> in_progress ──> closed
                              │
                              ├─ 门禁不通过 / 审查不通过 ─> 同一工作区继续改（最多 attempts 轮）
                              └─ 执行失败               ─> 回 open（可重新派）
```

四个阶段，一个阶段一个文件（`engine/flows/`）：

| 阶段 | 干什么 | 不干什么 |
|---|---|---|
| `claim` | 认领「待接 + 可派」的单，状态改 `in_progress`，留一句评论 | 不判断这单值不值得做 |
| `execute` | 渲染提示词 → `agent-tools agent-run` 一次 AI 回合，随便它怎么改 | 不判断做得好不好 |
| `gate` | 跑项目自己的 `.hlwd/gate.mjs`，**返回值**决定过不过 | 不改代码、不做审美判断 |
| `review` | 另起一个 AI 回合，只看 `git diff` 与证据，写 `verdict.json` | 不改代码、不提交 |
| `complete` | 通过就 `git commit`（带 `Card:`/`Run:` trailer）并关单 | 不把「跑起来了」当成「做对了」 |

**runner 的退出码不代表验收通过。** 门禁和审查结论都有独立的判定口径：看不懂、没证据、超时一律算不通过。

---

## 4. 命令

```bash
node wf.mjs                        # 我现在该干什么：项目 + 工单概况 + 下一步
node wf.mjs board [--bg]           # 看板（npm start = --bg）
node wf.mjs board --lan --token x  # 绑 0.0.0.0 给内网同事用，带访问口令
node wf.mjs work [--dry]           # 干下一张就绪单（--id <卡片> / --attempts N / --allow-dirty）
node wf.mjs watch [--bg]           # 自动流水线：有就绪单就自动开干
node wf.mjs watch --stop|--force   # 优雅停（跑完手上这张）/ 立即停（连 agent 一起杀）
node wf.mjs trace <卡片id>         # 终端看一张单的全链路
node wf.mjs new "标题" [描述]      # 建单，自动打可派标签
node wf.mjs stop                   # 停看板 + 请求停自动流水线
```

任何动词都能加 `--project <目录>`；不给就用上次打开的项目。

npm 快捷方式：`npm start`（看板）、`npm run start:lan`、`npm run engine`（干一张）、`npm run watch`、`npm run stop`、`npm test`。

---

## 5. 门禁：项目自己的判定脚本

打开项目时会自动生成 `.hlwd/gate.mjs`，**默认永远通过**。它跟着项目进版本库，改它不需要动工具代码。

```js
// 契约：export default async (ctx) => true | false | { pass, reason }
// ctx = { workdir, issue: {id,title,body,labels,priority}, runDir, attempt, cfg }
export default async function gate({ workdir }) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('npm', ['test'], { cwd: workdir, shell: true, encoding: 'utf8' });
  if (r.status === 0) return { pass: true, reason: 'npm test 全绿' };
  return { pass: false, reason: (r.stderr || r.stdout || 'npm test 失败').slice(-800) };
}
```

- 返回 `false` / 抛错 / 返回值看不懂 / 超时（默认 10 分钟，`HLWD_GATE_TIMEOUT_MS` 可调）→ **不通过**
- 不通过就不进审查，`reason` 会被塞进下一轮执行提示词，AI 在同一个工作区继续改
- 门禁跑在独立 node 进程里：语法错、死循环、`process.exit` 都不会拖垮引擎
- 原始输出留在 `.hlwd/runs/<卡片>-<时间>/gate-<轮次>.log`

看板「设置 → 门禁」里有路径和三个按钮（打开脚本 / 打开所在目录 / 复制路径），不用记路径。

---

## 6. 自动流水线

```bash
node wf.mjs watch --bg      # 常驻：每 5 秒看一眼有没有就绪单（--interval <ms> 可改）
```

- 看板右上角也有开关：**开** → 有单就跑；**停止中** → 跑完手上这张就退；再点一下 → **强杀**
- 每个项目只能跑一个；不同项目互不干扰
- 心跳在 `~/.hlwd/watch/<项目>.json`，`node wf.mjs` 会显示「自动流水线 开（pid …，正在干 <卡片>）」
- 想让它随看板自动启动：设置里勾「看板启动时自动开「自动流水线」」（`engine.autoWatch`），或者直接改 `config.json`
- 流水线在跑时 `wf.mjs work` 会拒绝执行（避免两个进程抢同一张单），`--dry` 不受影响

---

## 7. 看板

| 位置 | 作用 |
|---|---|
| 顶栏搜索 | 标题 / 描述 / **评论** 全字段搜索（每 5 秒自动刷新） |
| 「只看可派给 AI」 | 过滤出 AI 能接的单 |
| 点卡片 | 打开这张卡的**独立页面** `/issue/<id>`：地址可以直接复制给别人，他打开就看到同一张卡 |
| 工单页 | 左边正文 / 附件 / 评论，右边常驻状态、优先级、**一键派单**、标签 |
| 评论 | **实时**：别人发的评论不用刷新就出现在你页面上（有新评论会高亮），别人改状态你这边也跟着变 |
| 一键派单 | 没标签就加 `ready-for-agent`；已关闭的顺手改回「待接」；已打的变成「取消派单」 |
| 全链路 | 接单 → 执行 → 门禁 → 审查 → 提交，带耗时、原因、原始 JSON |
| 分享 | 复制地址栏就是分享：不需要截图、不需要让人自己找，也不怕他找错卡 |
| 会话 | AI 在里面到底干了什么：工具调用（命令/参数/输出/耗时）、思考、正文。跑完的可回看，正在跑的实时跟随 |
| 设置 | 状态/优先级中文名、AI 执行参数、提示词、门禁、自动流水线 |

**会话页：看 AI 的内部过程**

- 「执行者 / 验收者」每一轮一个按钮（`执行 #1` / `审查 #1`…），点开看这一轮的全过程
- 工具调用一行一条（`bash du -sh public/hero.png` · 86ms），点开看输出；失败的直接展开
- 思考默认折叠（右上角「思考」开关可整体关掉），正文定稿后才按 markdown 渲染
- 正在跑的那一轮会自动跟住：思考/工具/文字一条条长出来，跑完自动接上下一轮（执行完了接审查）
- 数据来自 `<项目>/.hlwd/runs/<卡>/<exec|review>-<n>/events.jsonl`；看板只读它，不改 beads
- 单轮可能有 1MB+，所以翻历史是分页的（「加载更多」），跟着看的走 SSE 增量
| 设置 | 状态/优先级中文名、AI 执行参数、提示词、门禁、自动流水线 |

**图片与附件**

- 面板里点「上传图片/文件」、直接**粘贴截图**（Ctrl/Cmd+V）、或把文件**拖进面板**都行
- 图片显示为缩略图，点一下放大；非图片显示为文件链接
- **下载**：每个附件行都有「下载」，图片放大后还有「下载原图」——存下来的文件名是当初那个原文件名，不是内部的时间戳名
- 评论里的图（粘贴进来的那些）同样是附件地址，点开大图就能「下载原图」，别人也能存
- 「插入评论」把 `![](附件地址)` 或 `[文件名](附件地址)` 插到评论光标处，方便在描述里引用截图
- 存在 `<项目>/.hlwd/attachments/<卡片>/`，单文件上限 25MB，不进版本库（在 `.hlwd/.gitignore` 里）
- 运行时，执行与审查提示词的正文后面会列上附件的**本机绝对路径**，AI 能自己打开截图/日志

**实时评论是怎么做的**

- 一条卡片一条 SSE 通道（`GET /api/issues/<id>/events`），页面开着就跟着
- 我们自己的写路径（发评论 / 改状态 / 改标签）直接广播，延迟就是一次 bd 往返
- engine 或别人直接用 `bd` 改的东西，靠每条被看的卡一个 2 秒轮询兜底（每卡一份，不随人数增长）
- 断线浏览器会自动重连；页面关掉流就停，不留后台进程

**账号：谁建的、谁改的、谁评论的**

部署在没人守的机器上时，同事从内网访问，先注册自己的账号：

- 第一个打开页面的人看到的是「注册」——第一个账号是管理员（`owner`），后面注册的都是普通成员
- 登录后：**工单记创建人**（`bd` 原生的 `created_by`）、**评论记作者**、**改状态自动留一条 `状态：待接 → 执行中`**（作者就是改的人）
- 顶栏右上角是你的名字和「退出」；会话存在 cookie 里（30 天），刷新、重启看板都不用重新登录
- 账号存在跑看板那台机器的 `~/.hlwd/users.json`：密码只存 scrypt 加盐哈希，文件权限 0600；一个人一个身份，切项目还是你
- 权限还没做（只有 owner / member 两个字段占着位），先只有「登录才看得到、干活留名」
- 单机自用不想登录：`WF_AUTH=off node wf.mjs board`（这时评论按 bd 的 git user 记）

**内网分享给同事：**

```bash
node wf.mjs board --lan --token 口令
# 分享（内网，绑 0.0.0.0）：需要访问口令
#   http://192.168.1.23:3100/?token=口令
```

- 口令只需带一次（记住 cookie），接口和静态页都受保护
- 只有**本机**能点开「自动流水线」和「打开门禁脚本」——它们会在宿主机上启进程
- 不给 `--token` 也能分享，但同网段谁都能建单/改单，自己权衡

---

## 8. 数据放哪

```
工具（本仓库）                      你的项目
  wf.mjs                             .hlwd/config.json     状态名 / AI 配置 / 自动流水线开关
  project.mjs                        .hlwd/prompts/*.md    项目定制的提示词
  web/  engine/                      .hlwd/gate.mjs        门禁脚本（默认 always true）
  vendor/agent-tools/                （工具侧：自带的 agent-tools 副本）
                                     .hlwd/runs/<卡片>-<ts>/ 每次运行的 run.json + 提示词 + 日志
                                     .hlwd/journal.ndjson  事件流（append-only）
                                     .beads/               工单（beads 数据库）
```

- **唯一真相源是 beads**：不另建数据库、不缓存工单状态。删掉 `runs/` 和 `journal.ndjson` 工单照样成立，只是追溯变模糊
- `.hlwd/.gitignore` 只排 `runs/` 与 `journal.ndjson`——配置、提示词、门禁都该进版本库
- 全局只记两件事：当前打开哪个项目（`~/.hlwd/state.json`）、看板/流水线的进程信息（`~/.hlwd/board.json`、`~/.hlwd/watch/*.json`）

---

## 9. 配置与提示词

`.hlwd/config.json` 的 `engine` 段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `runner` | `pi` | `pi` / `codex` / `agent`（Cursor） |
| `model` / `thinking` | 空 | 透传给 runner，空 = 用 runner 默认 |
| `sandbox` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access` |
| `attempts` | `2` | 执行→门禁→审查 最多几轮（1–5） |
| `timeoutMs` | `1800000` | 单次 AI 回合超时 |
| `gitCommit` | `true` | 通过后自动提交 |
| `actor` | `ai` | 接单时写的负责人名 |
| `readyLabel` | `ready-for-agent` | 「可派给 AI」用的标签 |
| `autoWatch` | `false` | 看板启动时是否自动开自动流水线 |

提示词在 `.hlwd/prompts/execute.md` 与 `review.md`（缺省回落到工具自带的 `engine/prompts/`）：

- execute：`{{ID}} {{TITLE}} {{BODY}} {{HISTORY}} {{FEEDBACK}}`
- review：`{{ID}} {{TITLE}} {{BODY}} {{VERDICT}}`（`{{VERDICT}}` 是它必须写出的 JSON 文件路径）

想让它「先写测试再动手」「必须改哪几个文件」，改提示词，不要改引擎。

---

## 10. 常见问题

**`engine` 说工作区不干净？**
`.hlwd/` 之外的未提交改动一律拦下（否则会被算进这张单的提交）。先提交/清理，或加 `--allow-dirty`。

**AI 干完了但没提交？**
`gitCommit` 关了，或没有代码改动。看 `.hlwd/runs/<...>/run.json` 的 `outcome`。

**门禁一直挡住？**
看同目录 `gate-<轮次>.log`。最常见的是门禁里跑 `npm test` 而项目本来就有失败用例——先把门禁改准，再放开。

**`bd: command not found` / AI CLI 跑不通？**
`bd` 用 `BD_BIN` 指定；`agent-tools` 仓库里已经有了，想换就设 `AGENT_TOOLS_BIN`。AI CLI（`pi` / `codex` / `cursor-agent`）得自己装并在 PATH 里——工具只负责把它叫起来。

**端口被占？**
`PORT=3101 node wf.mjs board`。

**Windows 上 `node wf.mjs` 报错退出？**
确保 Node ≥ 20；`bd` 在 PATH 里（或设 `BD_BIN`），AI CLI 也一样。

**能同时跑多个项目吗？**
能。每个项目一份 `.hlwd/` 与 `.beads/`，看板可以切换项目，自动流水线按项目分别启停。

---

## 11. 设计约束

- **唯一真相源是项目里的 beads**，工具不存工单状态
- **只有黑盒，没有共享内部**：`beads`（工单） / `web`（看板） / `engine`（流程）之间只通过 CLI、HTTP、文件通信；跨模块 import 内部实现算破坏
- **工具与项目分离**：换项目就换一整套数据，行为差异写进项目的 `.hlwd/`
- **验收不等于退出码**：门禁结论 + 审查 verdict + 提交产物，才算完成

细节与契约在 [AGENTS.md](AGENTS.md)。

---

## License

[MIT](LICENSE)
