# hlwd-workflow

> 一个**本地**工具：网页看板 + AI 工作流。
> 人建单 → AI 接单 → 执行 → **门禁** → 审查 → 交付 PR；人验收后再推进工单状态，全过程可追溯。

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

工具与 `bd` 的分工：工单的增删改查**只用 `bd` CLI**（`web/beads.mjs` 是唯一调用处），不直连数据库文件。验收 / 归档用三个自定义状态，第一次打开项目时自动注册：`plan_review:active,test_review:active,archived:frozen`。

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

## 2. 完整链路：从零到交付

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
工单 0 张：新建 0 · 开发中 0 · 策划验收 0 · 测试验收 0 · 已完成 0 · 已归档 0
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
工单 1 张：新建 1 · 开发中 0 · 策划验收 0 · 测试验收 0 · 已完成 0 · 已归档 0
就绪 1 张
  · demo-ckv  写一份 README.md  [中]

看板 未启动
自动流水线 关

下一步
  node wf.mjs board            起看板，建单 / 看全链路
  node wf.mjs watch --bg       自动流水线：有就绪单就自动开干
  node wf.mjs work             让 AI 干下一张就绪单
```

「就绪」= 状态是**新建**且带了 `ready-for-agent` 标签。`new` 会自动打上这个标签；在看板里建的单，点面板上的「让 AI 干这个」也能拿到。

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
[10:34:32] 交付 demo-ckv（状态保持开发中，等人工验收）
```

这一次 `work` 干了什么：认领（新建 → 开发中）→ 调 AI 改文件 → 跑门禁 → 另起一个回合审查 → commit → 推送 / 建 PR。**状态留在「开发中」**，等人看完 PR 后在工单页改成「策划验收」。

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
状态 开发中 · AI 已完成（待人工验收） · 负责人 ai · 优先级 中

状态变更
  11/6 18:34  新建
  11/6 18:34  开发中 · ai

运行 demo-ckv-1793961245895  26.6s  → delivered  提交 3c97eec
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
新建 open ──AI 接单──> 开发中 in_progress ──AI 交付──> 开发中（等人工验收）
                              │
                              ├─ 门禁不通过 / 审查不通过 ─> 同一工作区继续改（最多 attempts 轮）
                              └─ 执行失败               ─> 回 open（可重新派）

人工验收后在工单页手动推进：
开发中 ──> 策划验收 plan_review ──> 测试验收 test_review ──> 已完成 closed ──> 已归档 archived
```

五个阶段，一个阶段一个文件（`engine/flows/`）：

| 阶段 | 干什么 | 不干什么 |
|---|---|---|
| `claim` | 认领「新建 + 可派」的单，状态改 `in_progress`（开发中），留一句评论 | 不判断这单值不值得做 |
| `execute` | 渲染提示词 → `agent-tools agent-run` 一次 AI 回合，随便它怎么改 | 不判断做得好不好 |
| `gate` | 跑项目自己的 `.hlwd/gate.mjs`，**返回值**决定过不过 | 不改代码、不做审美判断 |
| `review` | 另起一个 AI 回合，只看 `git diff` 与证据，写 `verdict.json` | 不改代码、不提交 |
| `complete` | 通过就 `git commit`（带 `Card:`/`Run:` trailer）→ 推送 → 建 PR；**不改工单状态** | 不把「跑起来了」当成「做对了」 |

**runner 的退出码不代表验收通过。** 门禁和审查结论都有独立的判定口径：看不懂、没证据、超时一律算不通过。

---

## 4. 命令

```bash
node wf.mjs                        # 我现在该干什么：项目 + 工单概况 + 下一步
node wf.mjs board [--bg]           # 看板（npm start = --bg）
node wf.mjs board --lan            # 绑 0.0.0.0 给内网同事用（内网按可信处理，不设口令）
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

看板「设置 → 门禁」里有路径和「查看脚本 / 复制路径」：查看是页面内的只读窗口（`GET /api/gate/script`），内网谁都能看；
改脚本是程序员克隆项目后改 `.hlwd/gate.mjs`（它进版本库），页面不提供编辑。

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
| 看板 / 列表 | 右上角切换：看板按工单状态分六列（新建 / 开发中 / 策划验收 / 测试验收 / 已完成 / 已归档），**不能拖卡改状态**；列表一行一张单，多显示负责人、关注人、创建时间、更新时间、评论数与描述摘要，点表头排序（地址带 `?view=list`，刷新后仍停在列表） |
| 列表的列 | 「列」里勾选显示哪些列（状态 / AI 进度 / 负责人 / 关注人 / 创建时间等）、按住表头拖换列序、拖右边界改列宽；双击边界恢复默认宽度 |
| 筛选 | 顶栏下面「筛选」：关键词、状态、优先级、类型、负责人（含未指派）、创建人、标签、最近更新（今天 / 近 7 天 / 近 30 天 / 指定日期）。条件按 AND 叠加，**看板和列表一起过滤** |
| 预设 | 内置「全部 / 可派 / 我负责」，常看的条件「存为预设」点一下就切回来；自建的可以双击改名、点 × 删除 |
| 顶栏搜索 | 标题 / 描述 / **评论** 全字段搜索（每 5 秒自动刷新），和筛选条件是叠加的 |
| 点卡片 | 打开这张卡的**独立页面** `/issue/<id>`：地址可以直接复制给别人，他打开就看到同一张卡 |
| 工单页 | 左边正文 / 附件 / 评论，右边常驻**状态**、**负责人（多选）**、**关注人（多选）**、优先级、**一键派单**、标签 |
| 评论 | **实时**：别人发的评论不用刷新就出现在你页面上（有新评论会高亮），别人改状态/负责人/关注人你这边也跟着变 |
| 一键派单 | 没标签就加 `ready-for-agent`；已结束的顺手改回「新建」；已打的变成「取消派单」 |
| 全链路 | 接单 → 执行 → 门禁 → 审查 → 提交，带耗时、原因、原始 JSON |
| 分享 | 复制地址栏就是分享：不需要截图、不需要让人自己找，也不怕他找错卡 |
| 会话 | AI 在里面到底干了什么：工具调用（命令/参数/输出/耗时）、思考、正文。跑完的可回看，正在跑的实时跟随 |
| 设置 | 优先级中文名、AI 预设（执行 / 审查各挂一份）、提示词、门禁、自动流水线 |

列、列宽、排序、预设都存在 `~/.hlwd/prefs/<用户名>.json`（`WF_AUTH=off` 时是 `_local.json`）里**你 + 这个项目**那一段：换项目各是各的，换台机器不带过去。新项目第一次打开会继承你最近一次调好的列与排序，但不会继承预设。

**会话页：看 AI 的内部过程**

- 「执行者 / 验收者」每一轮一个按钮（`执行 #1` / `审查 #1`…），点开看这一轮的全过程
- 工具调用一行一条（`bash du -sh public/hero.png` · 86ms），点开看输出；失败的直接展开
- 思考默认折叠（右上角「思考」开关可整体关掉），正文定稿后才按 markdown 渲染
- 正在跑的那一轮会自动跟住：思考/工具/文字一条条长出来，跑完自动接上下一轮（执行完了接审查）
- 数据来自 `<项目>/.hlwd/runs/<卡>/<exec|review>-<n>/events.jsonl`；看板只读它，不改 beads
- 单轮可能有 1MB+，所以翻历史是分页的（「加载更多」），跟着看的走 SSE 增量
| 设置 | 优先级中文名、AI 预设（执行 / 审查各挂一份）、提示词、门禁、自动流水线 |

**图片与附件**

- 面板里点「上传图片/文件」、直接**粘贴截图**（Ctrl/Cmd+V）、或把文件**拖进面板**都行
- 图片显示为缩略图，点一下放大；非图片显示为文件链接
- **下载**：每个附件行都有「下载」，图片放大后还有「下载原图」——存下来的文件名是当初那个原文件名，不是内部的时间戳名
- 评论里的图（粘贴进来的那些）同样是附件地址，点开大图就能「下载原图」，别人也能存
- 「插入评论」把 `![](附件地址)` 或 `[文件名](附件地址)` 插到评论光标处，方便在描述里引用截图
- 存在 `<项目>/.hlwd/attachments/<卡片>/`，单文件上限 25MB，不进版本库（在 `.hlwd/.gitignore` 里）
- **什么类型都能传**：png/jpg/gif/webp/avif/svg/bmp 显示缩略图，其余按文件行列出；
  pdf / 文本 / csv / json / 音视频可以点开预览，zip、office 文档、没有扩展名的就直接下载（`application/octet-stream`）
- SVG 只给下载、不会在本站当页面打开（里面可能带脚本；缩略图本身在 `<img>` 里渲染，不受影响）
- 所有附件响应都带 `nosniff`，浏览器不会把 .txt 之类嗅探成 HTML 去执行
- 运行时，执行与审查提示词的正文后面会列上附件的**本机绝对路径**，AI 能自己打开截图/日志

**实时评论是怎么做的**

- 一条卡片一条 SSE 通道（`GET /api/issues/<id>/events`），页面开着就跟着
- 我们自己的写路径（发评论 / 改状态 / 改标签）直接广播，延迟就是一次 bd 往返
- engine 或别人直接用 `bd` 改的东西，靠每条被看的卡一个 2 秒轮询兜底（每卡一份，不随人数增长）
- 断线浏览器会自动重连；页面关掉流就停，不留后台进程

**账号：谁建的、谁改的、谁评论的**

部署在没人守的机器上时，同事从内网访问，先注册自己的账号：

- 配了发信邮箱就用**公司邮箱 + 验证码**注册：填邮箱 → 「获取验证码」→ 收 6 位码 → 设密码；只允许 `allowDomains` 里的域名
- 没配发件邮箱就退回「用户名 + 密码」注册（老行为），不会把注册整块关掉
- 第一个注册的账号是管理员（`owner`），后面注册的都是普通成员
- 登录填用户名或邮箱都行；忘了密码点「忘记密码」，用同一个邮箱收码重置（会踢掉所有旧会话）
- 登录后：**工单记创建人**（`bd` 原生的 `created_by`）、**评论记作者**、**改状态自动留一条 `状态：新建 → 开发中`**（作者就是改的人）
- 顶栏右上角是你的名字和「退出」；会话存在 cookie 里（30 天），刷新、重启看板都不用重新登录
- 账号存在跑看板那台机器的 `~/.hlwd/users.json`：密码只存 scrypt 加盐哈希，文件权限 0600；验证码在 `~/.hlwd/codes.json`（只存哈希，10 分钟有效）
- 权限还没做（只有 owner / member 两个字段占着位），先只有「登录才看得到、干活留名」
- 单机自用不想登录：`WF_AUTH=off node wf.mjs board`（这时评论按 bd 的 git user 记）

发信邮箱写在跑看板那台机器的 `~/.hlwd/mail.json`（文件权限 0600，不进项目）：

```json
{
  "host": "smtp.feishu.cn",
  "port": 465,
  "secure": true,
  "user": "hlwd@公司.com",
  "pass": "邮箱后台生成的第三方客户端专用密码",
  "from": "HLWD 看板 <hlwd@公司.com>",
  "allowDomains": ["公司.com"]
}
```

飞书 / 企业邮箱通用的 465 端口 SSL；改完重启看板生效。建议用专门的服务邮箱，不要用个人邮箱
（这个密码等于「以该账号名义发信」的权力）。

**内网分享给同事：**

```bash
node wf.mjs board --lan
# 分享（内网，绑 0.0.0.0）：
#   http://192.168.1.23:3100
```

- **内网按可信处理**：不设共享口令，靠每人一个账号区分到人（注册要公司邮箱验证码）
- 起停「自动流水线」、查看门禁脚本，内网谁都能用——服务就跑在这台机器上，没有「本机用户」这回事
- 看门禁脚本是页面内的只读窗口；要改脚本请克隆项目改 `.hlwd/gate.mjs`，改完提交
- 不用记 IP、也不用重启：看板 **设置 → 访问** 里点「开放到内网 / 收回本机」即可——服务端就地关掉监听再绑新地址
  （`127.0.0.1` ⇄ `0.0.0.0`），进程不重启；面板同时列出这台机器的内网地址（标出虚拟网卡）。
- `--token` / `WF_TOKEN` 的代码还在，只用于把看板临时暴露到可信内网之外；内网流程不用它。

---

## 8. 数据放哪

```
工具（本仓库）                      你的项目
  wf.mjs                             .hlwd/config.json     AI 预设 / 运行参数 / 自动流水线开关
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
| `presets` | 一份「默认」 | AI 预设：`{id, name, runner, model, thinking}`。执行 / 审查各挂一份，改预设对下一次运行生效 |
| `nodes` | AI 节点挂「默认」，收尾只提交 | `{execute:{preset}, review:{preset}, complete:{commit, push, pr, remote, base}}`：AI 节点只引用预设；收尾节点决定提交 / 推送 / 建 PR |
| `sandbox` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access` |
| `attempts` | `2` | 执行→门禁→审查 最多几轮（1–5） |
| `timeoutMs` | `1800000` | 单次 AI 回合超时 |
| `actor` | `ai` | 接单时没人负责才写的负责人名 |
| `readyLabel` | `ready-for-agent` | 「可派给 AI」用的标签 |
| `autoWatch` | `false` | 看板启动时是否自动开自动流水线 |

提示词在 `.hlwd/prompts/execute.md` 与 `review.md`（缺省回落到工具自带的 `engine/prompts/`）：

- execute：`{{ID}} {{TITLE}} {{BODY}} {{HISTORY}} {{FEEDBACK}}`
- review：`{{ID}} {{TITLE}} {{BODY}} {{HISTORY}} {{VERDICT}}`（`{{VERDICT}}` 是它必须写出的 JSON 文件路径）

想让它「先写测试再动手」「必须改哪几个文件」，改提示词，不要改引擎。

**AI 干得不对，人怎么补一句（纠偏）**

修正提示词没有单独的输入框：**写在工单评论里**，它就是下一轮的 `{{HISTORY}}`，执行端和审查端都会照着看。

1. 工单页评论区写清「哪里不对、期望什么样、怎么验收」，勾上「这是修正意见」。
2. 点「发送并重新派给 AI」= 一条评论 + 把工单改回「新建」+ 保留可派标签（等价 `POST /api/issues/<id>/revise`）。
   这一轮还在跑时会拒绝（提示词已经写死了，现在写的意见它看不到）；点「重新派给 AI」也行，只是要自己先发评论。
3. 下一轮的执行/审查提示词里就能看到这条意见（流程节点里点「看渲染后的提示词」核对）。

两个例外：**发布失败**的单重派只重跑收尾、不叫 AI，要按意见重做用 `node wf.mjs work --id <卡片> --fresh`；
上一轮 AI 的改动还留在工作区时，engine 会以「工作区不干净」拒绝，先提交或加 `--allow-dirty`（脏改动会算进这张单的提交）。

**收尾节点：提交 → 推送 → 建 PR**

- 三个开关有顺序：不提交就没有可推的东西，不推送就没法建 PR。页面按这个顺序禁用，服务端也拒绝矛盾组合。
- 打开 `pr` 后，engine **接单时就切出 `card/<id>` 分支**（从 `origin/<base>` 切，避免把本地未推的提交卷进 PR）；同一张单重派会复用已有分支。
- 建完 PR 自动切回 `base`；**任一步失败都不改工单状态**，工单留在「开发中」并写一条评论说明卡在哪一步，修好后人工重派即可。成功也只把 `run.json` 记成 `delivered`，状态仍是「开发中」。
- `gh` 是可选依赖：要建 PR 得先 `gh auth login`。没装或没登录会明确报错，不会假装成功。
- `remote` / `base` 默认 `origin` / `main`，可在收尾节点里改。
- **发布失败只重试发布**：收尾没做完（推送被拒、`gh` 没登录、PR 建不出来）时，工单停在「开发中 · 发布失败」，看板上的按钮会变成「**重试发布**」。
  点它（或 `node wf.mjs work --id <卡片>`）只会重跑提交/推送/PR，**不会再叫 AI 把活干一遍**；上一轮的执行与审查记录会带进新的运行记录。
  想真的从头再来，用 `node wf.mjs work --id <卡片> --fresh`。

---

## 10. 常见问题

**`engine` 说工作区不干净？**
`.hlwd/` 之外的未提交改动一律拦下（否则会被算进这张单的提交）。先提交/清理，或加 `--allow-dirty`。

**AI 干完了但没提交？**
「流程 → 收尾」里的「提交」关着，或没有代码改动。看 `.hlwd/runs/<...>/run.json` 的 `outcome` 与 `push` / `pr`。

**PR 没建出来 / 停在「开发中」？**
收尾是「提交 → 推送 → PR」，任一步失败都不改工单状态。看工单最新那条评论（写明卡在哪一步），再确认 `gh auth status` 正常、`base` 分支存在。分支会停在 `card/<id>` 上，方便看现场。

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
