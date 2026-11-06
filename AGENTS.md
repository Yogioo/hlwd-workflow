# AGENTS.md

一个**本地工具**：看板 + AI 工作流。它自己不存业务数据——数据都在被打开的那个**项目目录**里。
人建单、AI 干活：**接单 → 执行 → 门禁 → 审查 → 完成工单**。

## 1. 三条铁律

1. **唯一真相源是项目里的 beads。** 不另建数据库、不缓存工单状态、不在代码里藏待办清单。任何字段都能用 `bd` 读回。
2. **只有黑盒，没有共享内部。** 模块之间只通过 §4 的契约通信；跨模块 `import` 内部实现一律视为破坏。
3. **工具与项目分离。** 工具（本仓库）只提供能力；`<项目>/.hlwd/`（配置、提示词、运行记录）与 `<项目>/.beads/`（工单）属于项目，换项目就换一整套数据。

## 2. 模块

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `beads`（`bd`） | 工单存储与状态，每个项目一份 | 不跑 AI、不判验收 |
| `web` | 看板、建单、改单、改项目配置、切项目 | 不跑 AI、不写 git、不绕开适配层 |
| `engine` | 接单 → 执行 → 门禁 → 审查 → 回写结论；`watch.mjs` 常驻循环自动接单 | 不渲染页面、不定义工单字段 |
| `web` | 看板、建单、改单、改项目配置、切项目；起停自动流水线 | 不跑 AI、不写 git、不绕开适配层 |
| `project.mjs` | 打开项目：补齐 `.hlwd/`（配置/提示词/门禁）、缺 `.beads/` 就 `bd init` | 不存状态、不调 AI |

数据流：`人 → web → beads → engine → beads → web → 人`。web 与 engine 互不调用，beads 是消息总线。
当前打开哪个项目，只记在全局 `~/.hlwd/state.json`（**不是**项目配置）。看板进程信息（端口 / 绑的地址 / 口令探活用）记在 `~/.hlwd/board.json`，自动流水线的心跳记在 `~/.hlwd/watch/<项目>.json`；都是全局运行期信息，不是业务数据。

**账号也属于这台机器，不属于项目**：`~/.hlwd/users.json`（密码只存 scrypt 加盐哈希）与 `~/.hlwd/sessions.json`（登录会话，重启不踢人）。一个人一个身份，切项目还是他。

## 3. 产物布局

```
工具（本仓库）                     项目（被开发的目标目录）
  wf.mjs                             .hlwd/config.json     状态/优先级中文名 + engine 配置
  project.mjs                        .hlwd/prompts/*.md    项目定制的提示词
  web/  engine/                      .hlwd/gate.mjs        项目门禁（默认 always true）
                                     .hlwd/attachments/<卡片>/  图片/附件（gitignore）
                                     .hlwd/runs/           每次运行一个目录（gitignore）
  .hlwd/  .beads/  ← 它自己也是        .hlwd/journal.ndjson  事件流（gitignore）
     一个可以被打开的项目             .beads/               工单
```

`.hlwd/.gitignore` 由工具生成，排 `runs/`、`journal.ndjson`、`attachments/`——配置、提示词和门禁要进版本库，运行产物和附件不进。

## 4. 契约（改这里要先改文档）

**Project**（`project.mjs`，web 与 engine 共用）

```
ensureProject(dir) -> {dir, created[], config}   # 补齐 .hlwd/、prompts、gate.mjs、runs、.beads
readProjectConfig(dir) / saveProjectConfig(dir, patch)
readPrompts(dir) / savePrompts(dir, {execute, review})
gateFile(dir) -> <dir>/.hlwd/gate.mjs
```

- 打开项目是**幂等**的：已存在的一律不覆盖，只在返回值里说明补了什么。
- 配置写入必须校验：不认识的 runner / 非 1–5 的 attempts / 空名称一律拒绝，宁可不保存。

**Watcher**（`engine/watch.mjs`，常驻循环；web 与 wf 只通过进程/心跳文件跟它说话）

```
node engine/watch.mjs --project <dir> [--interval 5000]   # 跑循环
node engine/watch.mjs --project <dir> --stop              # 优雅停（跑完手上这张）
node engine/watch.mjs --project <dir> --status            # 一行 JSON 状态
```

- 心跳：`~/.hlwd/watch/<项目key>.json`（`{pid, state: idle|running|stopped, card, lastCode, lastError, beatAt, interval, stopping}`）；`running` 以 pid 还活着为准，不靠文件自证。
- 每张单起独立的 `engine/run.mjs` 子进程：单张崩了不带走循环，进程退出也不留残留状态。
- 同一项目只跑一个（已有 pid 活着就拒绝再起）；不同项目互不干扰。
- 停止是**协作式**：先写 `<项目key>.stop`，循环跑完手上这张才退（空转时最多 0.5s 就反应）；`--force`/看板上的「再点一下」会连子进程一起强杀（可能留下 `in_progress` 的单，需要人工改回待接）。
- `wf.mjs work` 在流水线运行时拒绝（否则两个进程会同时接单）；`--dry` 不受影响。
- web 侧：`GET /api/watch` 只读（内网也允许），`POST /api/watch {action: start|stop|force}` **仅本机**（它会在宿主机上起 AI）。

**WorkSource**（beads 适配层，`web` 与 `engine` 共用一份实现）

```
setWorkdir(dir)                # 之后所有 bd 命令都在这个项目下跑
list(filter) -> Issue[]
get(id) -> Issue
create(fields) -> Issue
update(id, patch) -> Issue     # 含状态迁移
comment(id, text) -> void
```

- `Issue` 最小字段集：`id, title, body, status, labels, assignee, created, updated, createdBy`。
- `createdBy` 是 bd 原生字段：建单时把 `--actor` 传进去，谁建的就是谁。
- 写操作都能带 `actor`（`createIssue / updateIssue / commentIssue`）。没带就用 `setActor()` 设的默认值（engine 设成 `cfg.actor`）；都没有就不带，由 bd 回落到 git user。
- 只能用 `bd` CLI（或 beads 官方 HTTP 接口）。禁止直连 `.beads/*.db` 写数据。

**Identity**（`web/auth.mjs`；web 与 engine 共用一个「actor」的说法）

```
register({name, display, password}) -> user    # 第一个注册的人是 owner，其余 member
verify({name, password}) -> user              # 失败抛 AuthError(401)，不区分「没这人」和「密码错」
createSession(name) -> token / readSession(token) -> user / dropSession(token)
changePassword(name, old, next, keepToken)    # 换密码顺手踢掉其他设备
publicUser(user) -> {name, display, role, createdAt}   # 对外的唯一形状（不含 salt/hash）
```

- 身份是**全局**的（`~/.hlwd/users.json`），HTTP 面只有 `GET /api/auth/me` 与 `POST /api/auth/{register,login,logout}`；cookie 里是随机 token，不是密码。
- 登录后所有写操作都带 `actor = 显示名`：建单记 `created_by`，评论记作者，改状态补一条 `状态：A → B` 的评论。
- `WF_AUTH=off` 关掉登录（单机自用）：不拦接口，写操作不带 actor，评论按 bd 的默认值记。
- 权限**还没做**：`role` 已经存在（owner / member），以后判权限只改 auth.mjs，不动页面。

**AgentRunner**（`engine` 内部，对外只暴露一个函数）

```
run(promptFile, workdir, sandbox) -> {status, outDir, events}
```

- 复用 `agent-tools agent-run`（技能 `agent-run`），**不要自己拼 CLI、不要 fork**；换 runner 改配置，不改代码。
- `status` 只表示这一轮跑没跑起来，**永远不代表「做完了」或「审查通过」**。

**Gate**（`<项目>/.hlwd/gate.mjs`，engine 调用，人可改；工具不碰它的内容）

```
export default async ({workdir, issue, runDir, attempt, cfg})
  -> true | false | {pass: boolean, reason?: string}
```

- 顺序固定：**执行 → 门禁 → 审查**。门禁不通过就不进审查，`reason` 回灌给执行端（同一工作区继续改，算一次 attempt）。
- 判定口径：`true` / `{pass:true}` 通过；`false` / `{pass:false}` / 抛错 / 返回值看不懂 / 超时（默认 10 分钟，`HLWD_GATE_TIMEOUT_MS` 可改）一律不通过——门禁宁严不宽。
- 单独 node 进程跑（`engine/gate-run.mjs`）：门禁是用户脚本，语法错、死循环、`process.exit` 不能拖垮引擎。
- 默认模板是 always true，新项目不会被门禁卡住；要真检查（测试/构建/lint/自定义规则）就改这个文件，不碰工具代码。
- 原始输出留在 `<run>/gate-<attempt>.log`；结论（pass/reason/ms）进 `run.json` 的 `attempts[].gate` 与 journal 的 `gate` 事件。
- 门禁不是审查：它只回答「机器能查的过没过」，代码质量、无关改动、假实现仍归 review。
- 看板「设置」只显示它的路径 + 「打开脚本 / 打开所在目录 / 复制路径」（`POST /api/gate/open`，`HLWD_EDITOR` 可指定编辑器）——页面不编辑脚本，脚本进版本库、用编辑器改。

**验收归 engine。** 是否通过由 §5 状态机 + 门禁结论 + 执行产物（commit/测试输出）决定，不由 runner 退出码决定。

**RunTrace**（`web` 只读）

```
<项目>/.hlwd/runs/<cardId>-<ts>/run.json          # 卡片快照 / attempts / verdict / commit / outcome
<项目>/.hlwd/runs/<cardId>-<ts>/exec-<n>/         # 第 n 轮执行回合：events.jsonl + output.txt + log.txt
<项目>/.hlwd/runs/<cardId>-<ts>/review-<n>/       # 第 n 轮审查回合：同上
<项目>/.hlwd/journal.ndjson                      # append-only，一行一事件
```

- 这三处都是**产物，不是状态**：删掉它们工单照样成立，只是追溯变模糊。
- 写方只有 `engine`（`exec/review` 子目录由 `agent-tools agent-run` 写）；读方只有 `web`。
  `web` 不读 engine 的代码，只读这些路径。
- `attempts[].execute/gate/review` 里 `ms`/`ok`/`pass` 为 `null` 表示**此刻正在跑这一步**：
  engine 在每步开工前先落一次 `run.json`，看板据此知道「现在卡在哪一阶段」，
  进程中途崩了也留得下现场。
- `events.jsonl` 是 runner 原始事件流（工具调用 / 思考 / 文本，含 `*_partial` 增量），
  由 `web/sessions.mjs` 归一成消息流后交给看板「会话」页；看板不解析 runner 的格式细节。
  跑完的用 `GET /api/issues/:id/turns/:runId/:phase` 分页翻，正在跑的开
  `…/stream`（SSE）跟着长。两个接口都只读、都按 `SAFE` 文件名校验。

**Config / Prompts**（`<项目>/.hlwd/`）

```
config.json: labels.statuses / labels.priorities / columns / engine.*（含 autoWatch：看板启动时是否自动开自动流水线，默认 false）
prompts/execute.md, prompts/review.md     # 占位符 {{ID}} {{TITLE}} {{BODY}} {{HISTORY}} {{FEEDBACK}} / {{VERDICT}}
```

- 写方是 `web`（看板「设置」→ `PUT /api/settings`）；读方是 `engine`（每次运行开始时读）。
- 项目没写提示词时，回落到工具自带的 `engine/prompts/*.md`。

## 5. 状态机（就这四个，别加）

```
open ──ready-for-agent──> in_progress ──> review ──> closed
                              │              │
                              └──失败/超时──> open（回退，附原因评论）
                                            └──审查不通过──> in_progress（同一工作区继续改）
```

- 状态用 beads 原生 `status`；`review` 是自定义状态，靠 `bd config set status.custom "review:wip"` 注册。
- 门禁不通过等同审查不通过：**留在 `in_progress`**，原因回灌执行端，不单独引入新状态。
- 看板绑内网时（`--lan`）只是多了一个入口，状态机不变；谁能改单由 `--token` 决定。
- `ready-for-agent` 用 label 表达，与 `status` 正交：它回答「能不能派给 AI」。
- 每次迁移留一条评论，**只写一句 AI 结论**（例：`AI 已完成并提交 1a2b3c4。`）；验证命令、耗时、原始事件进 `run.json` / 全链路。
- **谁改的**：人工在看板改状态时，web 自动补一条 `状态：待接 → 执行中` 的评论，作者就是登录的人（bd 的 update 本身不记变更人）；engine 的迁移用 `cfg.actor`，评论由各阶段写。

## 6. 目录

```
AGENTS.md
wf.mjs             # 唯一入口：board / stop / work / trace / new，只做分发
project.mjs        # 项目层：打开目录、补齐 .hlwd/、配置与提示词读写
package.json       # 只有 scripts，没有依赖
.hlwd/ .beads/     # 本仓库自己作为项目时的配置与工单
web/               # 页面 + beads 适配层
  beads.mjs        # WorkSource 适配层：全项目唯一调用 bd 的文件
  runs.mjs         # 只读端口：把 <项目>/.hlwd/runs 与 journal 给看板
  sessions.mjs     # 只读端口：把每轮 agent 的 events.jsonl 归一成消息流（会话页 / SSE）
  server.mjs       # HTTP JSON 接口 + 静态页，零依赖（node:http）
  app/             # 单页看板：index.html / app.js / markdown.js / style.css，无构建
                   #   工单页（人看，markdown）/ 全链路页（程序看，含原始 JSON）
                   #   会话页（AI 的工具调用、思考、最终回复；在跑时实时跟随）
engine/            # 流程编排
  run.mjs          # 入口：接一张单走完流程，一次只跑一张（--project 指定项目）
  lib.mjs          # 跑命令 / 渲染提示词 / 调 agent-run / 跑门禁
  gate-run.mjs     # 门禁执行器：单独进程跑项目的 .hlwd/gate.mjs
  watch.mjs        # 自动流水线：有就绪单就起一张，没有就等；心跳给看板看
  manifest.mjs     # 写 run.json 与 journal.ndjson
  flows/           # 一个阶段一个文件：claim / execute / gate / review / complete
  prompts/         # 默认提示词模板（项目没定制时用它）
  skills/agent-run # 复制维护的 agent-run 技能（上游可覆盖）
vendor/agent-tools/ # 自带的 @yogioo/agent-tools 副本（来源见 VENDORED.md）
```

新目录出现前先问：它属于工具、还是属于项目？两边都不属于就别建。

## 7. 跑起来

```bash
node wf.mjs                       # 我现在该干什么：当前项目 + 工单概况 + 下一步
node wf.mjs board [--bg]          # 看板（npm start = --bg）
node wf.mjs board --lan           # 同上，绑 0.0.0.0 让内网同事打开（npm run start:lan）
node wf.mjs stop                  # 停掉后台看板（npm run stop）
node wf.mjs work                  # 让 AI 干下一张就绪单（npm run engine）
node wf.mjs watch --bg            # 自动流水线：常驻，有就绪单就自动开干
node wf.mjs watch --stop          # 优雅停（跑完手上这张；--interval <ms> 调轮询间隔）
node wf.mjs trace <卡片id>        # 终端看一张单的全链路
node wf.mjs new "标题" [描述]     # 建单，自动打可派标签

node wf.mjs --project D:\code\foo ...   # 任何动词都可以指定项目
```

- 不给 `--project` 就用上次打开的项目；首次打开会自动建 `.hlwd/` 与 `.beads/`。
- 看板默认要登录（部署在没人守的机器上时，同事从内网访问各自注册）：第一个访问的人看到的是「注册」，第一个账号是管理员；单机自用想省这一步就 `WF_AUTH=off`。
- `work` 的参数原样透传：`--dry` / `--id <卡片>` / `--attempts N` / `--allow-dirty`。
- `engine` 一次只跑一张，跑完就退；要连续跑就外面套循环。
- 退出码：`0` 完成或没有就绪单；`1` 执行失败 / 审查不通过；`2` 工作区不干净或参数错。
- 依赖解析：要用能找到的 `bd` 与 AI CLI；`agent-tools` 用仓库自带的 `vendor/agent-tools`（`AGENT_TOOLS_BIN` 可覆盖）。
- 首次打开空项目：`bd init` 会建 `.beads/` 并 `git init` + 提交一次（bd 基于 git 工作），项目的 `.gitignore` 也是它写的。
- 看板只是 beads 的一层视图：关掉它不影响数据与流程。看板每 5s 自动刷新，搜索盖标题/描述/评论。
- **要不要开自动流水线**：开了就不用守终端——看板上点一下（或 `watch --bg`），之后只要有「待接 + 可派」的单就自己开干；关闭看板不影响流水线，`node wf.mjs stop` 两个一起停。
- 想连“点一下”也省了：设置里勾「看板启动时自动开自动流水线」（`engine.autoWatch=true`），看板一启动就把流水线拉起来。

**内网分享**（给同网段的同事看/建/改单）

```bash
node wf.mjs board --bg --lan --token 口令      # 推荐：带口令，打印每个网卡的分享地址
node wf.mjs board --lan                        # 不带口令：本网段谁都能改单
node wf.mjs board --host 192.168.1.7 --bg      # 只绑某块网卡
```

- 分享地址由 `/api/meta.share` 给出（每个非内网回环 IPv4 一条），终端里 `board` 与 `node wf.mjs` 都会打印。
- 设了 `WF_TOKEN` / `--token` 就全站要口令：`http://ip:port/?token=口令` 打开一次，之后靠 cookie，不用一直带。
- 即使开了口令，「设置 → 打开脚本/打开所在目录」也只允许**本机**调（`/api/gate/open` 校验 loopback 来源），远程只能改文件。
- 看板进程的信息（端口 / 绑的地址 / 口令）记在 `~/.hlwd/board.json`，`node wf.mjs` 用它探活和打印分享地址；`stop` 会删。


`engine` 只在工作区干净时启动（`.hlwd/` 不算脏）；脏改动的后果是被算进这张单的提交。

## 8. 给 AI 的作业守则

- **动手前先读**：工单状态、已有评论、当前项目（`node wf.mjs` 第一行就写着）。
- **一次只推进一步**：接单就只接单，执行就只执行，审查就只审查。跳阶段等于伪造记录。
- **改动最小**：能改一个函数不新建文件，能改配置不加抽象层。新增抽象要说清它挡住了什么。
- **不留暗门**：不做「先注释掉」「临时硬编码」；临时方案写进工单评论并标回滚条件。
- **完成 = 可复现**：关闭工单时，触发它的人工步骤必须是看板上点一下或 `wf` 的一条命令。
- **不确定就停**：需求含糊、契约要变、要动 beads schema —— 停下来问，不要猜。

## 9. 复用到别的项目

本来就是多项目的：`node wf.mjs --project <目录>` 打开即用，工具不用改。
想让某项目有不同的行为，改**那个项目**的 `.hlwd/config.json` 或 `.hlwd/prompts/`，不要改工具代码。
若某项目需要第四种模块，先证明现有模块吸收不了。
