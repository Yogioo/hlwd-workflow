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
| `web` | 看板、建单、改单、标签库、关单/重开、改项目配置、切项目；起停自动流水线 | 不跑 AI、不写 git、不绕开适配层 |
| `engine` | 接单 → 执行 → 门禁 → 审查 → 回写结论；`watch.mjs` 常驻循环自动接单 | 不渲染页面、不定义工单字段 |
| `project.mjs` | 打开项目：补齐 `.hlwd/`（配置/提示词/门禁）、缺 `.beads/` 就 `bd init` | 不存状态、不调 AI |

数据流：`人 → web → beads → engine → beads → web → 人`。web 与 engine 互不调用，beads 是消息总线。
当前打开哪个项目，只记在全局 `~/.hlwd/state.json`（**不是**项目配置）。看板进程信息（端口 / 绑的地址 / 口令探活用）记在 `~/.hlwd/board.json`，自动流水线的心跳记在 `~/.hlwd/watch/<项目>.json`；都是全局运行期信息，不是业务数据。

**账号也属于这台机器，不属于项目**：`~/.hlwd/users.json`（密码只存 scrypt 加盐哈希）与 `~/.hlwd/sessions.json`（登录会话，重启不踢人）。一个人一个身份，切项目还是他。

**视图偏好也属于这台机器**：`~/.hlwd/prefs/<用户名>.json` 存这个人「每个项目」的列表列、列宽、排序、筛选预设（`WF_AUTH=off` 时是 `_local.json`）。它是可以随时重算的视图配置，不是业务数据，所以不进项目目录、不进 beads。

## 3. 产物布局

```
工具（本仓库）                     项目（被开发的目标目录）
  wf.mjs                             .hlwd/config.json     标签目录 + engine 配置（状态不再配置）
  project.mjs                        .hlwd/prompts/*.md    项目定制的提示词
  web/  engine/                      .hlwd/gate.mjs        项目门禁（默认 always true）
                                     .hlwd/attachments/<卡片>/  图片/附件（gitignore）
                                     .hlwd/runs/           每次运行一个目录（gitignore）
  .hlwd/  .beads/  ← 它自己也是        .hlwd/journal.ndjson  事件流（gitignore）
     一个可以被打开的项目             .beads/               工单
```

`.hlwd/.gitignore` 由工具生成，排 `runs/`、`journal.ndjson`、`attachments/`——配置、提示词和门禁要进版本库，运行产物和附件不进。

附件的字节只走一个地址：`GET /api/attachments/<卡>/<stored>` 默认 `inline`（页面里直接显示），
加 `?download=1` 变 `attachment`（浏览器存盘，文件名还原成用户给的原名）。

## 4. 契约（改这里要先改文档）

**Project**（`project.mjs`，web 与 engine 共用）

```
ensureProject(dir) -> {dir, created[], config}   # 补齐 .hlwd/、prompts、gate.mjs、runs、.beads
readProjectConfig(dir) / saveProjectConfig(dir, patch)
readPrompts(dir) / savePrompts(dir, {execute, review})
gateFile(dir) -> <dir>/.hlwd/gate.mjs
```

- 打开项目是**幂等**的：已存在的一律不覆盖，只在返回值里说明补了什么。
- 配置写入必须校验：不认识的 runner / 非 1–5 的 attempts / 空的 readyLabel / 非法标签名或颜色一律拒绝，宁可不保存。

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

- `Issue` 最小字段集：`id, title, body, status, labels, assignee, created, updated, createdBy`。`status` 只剩 `open/closed` 作为系统开关；界面不把它当工作流，也不配置它。
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
- 登录后所有写操作都带 `actor = 显示名`：建单记 `created_by`，评论记作者，人工关单/重开补一条工单开关评论。
- `WF_AUTH=off` 关掉登录（单机自用）：不拦接口，写操作不带 actor，评论按 bd 的默认值记。
- 权限**还没做**：`role` 已经存在（owner / member），以后判权限只改 auth.mjs，不动页面。

**UserPrefs**（`web/prefs.mjs`，只有 web 读写）

```
readPrefs(user) -> {version, defaults, projects}
prefsFor(user, projectDir) -> {list: {columns, sort, presets}}
savePrefs(user, projectDir, {list}) -> {list}
```

- `columns`: `[{id, w, hidden}]`，id 取自固定候选集（workflow / priority / type / title / assignee / createdBy / created / updated / labels / comments / ready / id），`w` 夹在 56–720。旧文件里的 `status` 列会在读取时迁成 `workflow`。
- `sort`: `{key, dir}`，单列排序；`presets`: `[{id, name, filter}]`，最多 30 条。
- `filter` 只有 AND 组合：`q / ready / workflow[] / priority[] / type[] / assignee[] / createdBy[] / labels[] / updated{period, from, to}`，没有 OR、没有表达式。旧预设里的 `status[]` 会按 `open→queued / in_progress→active / review→review / closed→done` 迁移。
- 存的键是「项目绝对路径」，所以换项目是另一套；新项目没见过就继承 `defaults` 里的列与排序（每次保存都会把 `defaults` 滚成刚存的那套）。预设不继承：它是给某个项目存的筛选。
- 校验在服务端做：不认识的值一律丢掉，文件被手改坏也只是回落到默认列，不会让页面崩。
- HTTP 面只有 `GET /api/prefs` 与 `PUT /api/prefs`，只读写**当前登录人**自己的文件，不暴露别人的。

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

**Publish**（`engine/git.mjs`，只在 engine 内部用；web 不读它）

```
prepareCardBranch({workdir, issueId, complete}) -> {branch, base, remote, start, reused}
commitAll(workdir, {subject, body}) -> {commit|null, error?}
pushBranch(workdir, {remote, branch}) -> {ok, error}
findOpenPr(workdir, branch) -> url|null        # 重跑不重复建 PR
createPr(workdir, {branch, base, title, body}) -> {ok, url, error}
returnToBase(workdir, {base, remote}) -> {ok, error}
resumablePublish(run) -> {runId, commit, git, attempts} | null   # run.json 里 outcome=publish_failed 才算
```

- 顺序固定：**提交 → 推送 → 建 PR → 关单**；前一步失败后面不做，**任何一步失败都不关单**（工单停在 in_progress，评论写原因）。
- `pr` 打开时每张单一条 `card/<id>` 分支：**接单后、执行前**从 `origin/<base>`（没有就用本地 `<base>`）切出来；分支已存在就复用，重派不会重建。
- 分支从远端基准切、不从本地当前分支切：否则本地没推的提交会被卷进 PR。
- 发布成功后切回 `<base>`；失败就留在 `card/<id>` 上，方便看现场（脏工作区也会自然挡住下一张单）。
- `gh` 是可选外部依赖：没装 / 没登录时明确报错，不静默跳过。PR 已存在（同 head 的 open PR）就复用链接。
- `run.json` 记 `git{branch,base}`、`push{ok,remote,branch,error}`、`pr{ok,url}`：看板据此显示分支、推送结果和 PR 链接；失败时 error 挂在 `err.git` 上带到 run.json。
- 提交用 `git add -A`，`.hlwd/`、`.beads/` 里被版本库跟踪的部分也会进这张单的提交（和以前一样）。
- **发布失败不是「要重做」**：收尾失败时 `outcome=publish_failed`（工单留在 in_progress）。这时重派 **只重跑收尾**，不调用 AI——
  执行与审查的记录原样带进新的 run（`mode=publish`、`resumedFrom=<旧 runId>`）。上次的提交没丢，重试时没有新改动就沿用它的 sha 继续推送。
  看板上的按钮会变成「重试发布」。`node wf.mjs work --fresh` 可以强制忽略这个捷径、从头再跑一遍。

**验收归 engine。** 是否通过由 §5 状态机 + 门禁结论 + 执行产物（commit/测试输出）决定，不由 runner 退出码决定。

**RunTrace**（`web` 只读）

```
<项目>/.hlwd/runs/<cardId>-<ts>/run.json          # 卡片快照 / attempts / verdict / commit / outcome
<项目>/.hlwd/runs/<cardId>-<ts>/exec-<n>/         # 第 n 轮执行回合：events.jsonl + output.txt + log.txt
<项目>/.hlwd/runs/<cardId>-<ts>/review-<n>/       # 第 n 轮审查回合：同上
<项目>/.hlwd/journal.ndjson                      # append-only，一行一事件
```

- 这三处都是**产物，不是工单状态**：删掉它们工单照样成立，只是追溯变模糊。看板的「AI 进度」是从最新 `run.json` 的 attempts 推导的投影，不写回 beads、不另建状态库。
- 写方只有 `engine`（`exec/review` 子目录由 `agent-tools agent-run` 写）；读方只有 `web`。
  `web` 不读 engine 的代码，只读这些路径。
- `attempts[].execute/gate/review` 里 `ms`/`ok`/`pass` 为 `null` 表示**此刻正在跑这一步**：
  engine 在每步开工前先落一次 `run.json`，看板据此知道「现在卡在哪一阶段」，
  进程中途崩了也留得下现场。
- `attempts[].execute.engine` / `attempts[].review.engine` 是**当时生效的 runner/model/thinking 快照**：
  配置以后会改，这张单当时用的哪个模型不能跟着变。
- 页面只通过 `GET /api/issues/<id>/runs/<runId>/file?name=` 读这些产物；白名单只有
  `prompt-{exec,review}-<n>.md`、`gate-<n>.log`、`verdict-<n>.json`，越界或名单外的名字一律 404。
- `events.jsonl` 是 runner 原始事件流（工具调用 / 思考 / 文本，含 `*_partial` 增量），
  由 `web/sessions.mjs` 归一成消息流后交给看板「会话」页；看板不解析 runner 的格式细节。
  跑完的用 `GET /api/issues/:id/turns/:runId/:phase` 分页翻，正在跑的开
  `…/stream`（SSE）跟着长。两个接口都只读、都按 `SAFE` 文件名校验。

**Realtime**（`web` 只读 + 推送；不存状态）

```
GET /api/issues/<id>/events      # SSE：连上先给一份快照，之后字段/评论变了就再推一份
GET /issue/<id>                  # 工单独立页面（返回同一个单页，id 由前端从 URL 读）
```

- 一个卡片一条流，推送的是**整张卡**（issue + comments + 最新的 workflow 进度与节点图，都很小），前端按 id 覆盖渲染。
- 触发：① 我们自己的写路径（评论 / 关单重开 / 改标签）直接广播；② 每条被看的卡一个 2s 轮询
  比对 `updated_at + comment_count + run 签名`，把 engine 或别的进程直接改 bd / run.json 的变化也接进来。
  轮询是**每卡一份**，不随观看人数增长；没人看就自己停。
- 推送只走 HTTP，不落库：删了看板/重启，数据仍然只有 beads 一份。
- 换项目时所有流立刻断开（bd 的 workdir 是全局的，跨项目读会错位）。

**Config / Prompts**（`<项目>/.hlwd/`）

```
config.json: tags[]（name/color/desc/archived）/ labels.priorities / engine.*（含 autoWatch：看板启动时是否自动开自动流水线，默认 false）
              engine.presets[] = {id, name, runner, model, thinking}   # AI 配置的唯一来源；sandbox/attempts/超时/actor 是运行参数，不进预设
              engine.nodes.{execute,review}.preset                    # 节点只引用一份预设，永远有值：没有「留空＝继承」
              engine.nodes.complete = {commit, push, pr, remote, base}   # 收尾节点：提交 → 推送 → 建 PR 的开关（有顺序，后一步依赖前一步）
# 旧版的 labels.statuses / columns 仍可读，只为兼容；设置面板不再写它们。
# 旧版的 engine.stages / engine.{runner,model,thinking} 只在**读取时**折成预设（stages 各成一份，全局三个字段成「默认」）；
# 旧版的 engine.gitCommit 折成 nodes.complete.commit。保存后这些旧字段都不再写回。
prompts/execute.md, prompts/review.md     # 占位符 {{ID}} {{TITLE}} {{BODY}} {{HISTORY}} {{FEEDBACK}} / {{VERDICT}}
```

- 写方是 `web`（看板「设置」→ `PUT /api/settings`，标签走 `/api/tags`）；读方是 `engine`（每次运行开始时读）。
- 预设与节点配置（含收尾的 commit / push / pr）只在**下一次运行**生效：engine 启动时读一次，已在跑的单不受影响（它的快照已经落在 run.json 里）。
- 收尾的开关是**一串有序动作**，不是三个并列项：`pr` 要求 `push`，`push` 要求 `commit`；页面按顺序禁用，服务端也拒绝矛盾组合（手改出来的矛盾在读取时折回）。
- 预设与节点是**同一份契约**：预设至少留一份、名字唯一、runner 只能是 pi / codex / agent；节点必须指向存在的预设，还被节点用着的预设删不掉。
  页面写入严格校验（宁可不保存）；手改坏配置时读取会收敛（坏预设丢掉、节点引用回落到第一份），engine 不至于跑不起来。
- 项目没写提示词时，回落到工具自带的 `engine/prompts/*.md`；在设置里清空提示词并保存 = 把默认模板写回项目文件（不是留空）。
- 标签改名会级联到历史工单（先加新、再去旧）；删除默认要求确认，`?purge=1` 才从工单上摘掉。

## 5. 工作流状态机（固定四段，工单只有 open/closed + 标签）

工单（beads）只保留两个系统开关：`open` / `closed`。看板四列不是工单字段，而是最新一次 engine run 的投影：

```
待接 ──claim──> 执行中 ──gate/review──> 审查中 ──pass──> 已完成
                    │
                    ├──失败/中断──> 待接（带「上次失败 / 已中断」徽章）
                    └──代码过审但没交付──> 发布失败（重派只重试收尾）
```

- `open` / `closed` 只表示工单是否归档；人工在看板上只能「关闭 / 重新打开」，不再拖列改状态。
- 看板列固定：**待接 / 执行中 / 审查中 / 已完成**；由 `web/workflow.mjs` 从最新 `run.json` 推导。卡上再细分「已接单 / 执行中 / 门禁中 / 审查中 / 已完成 / 上次失败 / 已中断」。
- engine 内部仍用 `status=in_progress` 当接单锁（务实版，界面不展示），完成时置 `closed`；失败时按需要回 `open` 或留 `in_progress`。`review` 自定义状态不再由 engine 使用。
- `ready-for-agent` 用 label 表达，与状态机正交：它回答「能不能派给 AI」。接单候选是 `open + ready`，看板不会把已有活跃 run 的卡再派一次。
- 进度不是新状态库：`run.json` 是运行记录，删掉只丢追溯；工作流阶段从 `attempts[].execute/gate/review` 的未完成步骤推导。
- 每次迁移留一条评论，**只写一句 AI 结论**（例：`AI 已完成并提交 1a2b3c4。`）；验证命令、耗时、原始事件进 `run.json` / 流程图的节点抽屉。人工关单/重开补一条工单开关评论。
- **谁改的**：人工操作由登录用户记 `--actor`；engine 的迁移用 `cfg.actor`，评论由各阶段写。
- **状态名和列不再可配置**：`labels.statuses` / `columns` 只为旧配置兼容保留；改工作流阶段要改代码契约，不改项目配置。旧项目里已有的 `in_progress` / `review` 仍按 legacy 映射显示，新流程不再写 `review`。
- **节点图（只读投影）**：`web/workflow.mjs` 的 `TOPOLOGY` 是拓扑的唯一声明，`graphOf(issue, run)` 把一次 run 投影成节点状态与回边（门禁/审查未过 → 回到执行）。拓扑只读：要改流程改 `engine/run.mjs`，不提供连线编辑器；点节点只能改它自己的配置（AI 节点的提示词与预设、收尾节点的提交/推送/PR 与基准分支），不能改拓扑。没有 run 时这张图就是模板形状（全 idle），设置页与卡片页共用同一张图。

## 6. 目录

```
AGENTS.md
wf.mjs             # 唯一入口：board / stop / work / trace / new，只做分发
project.mjs        # 项目层：打开目录、补齐 .hlwd/、配置与提示词读写
package.json       # 只有 scripts，没有依赖
.hlwd/ .beads/     # 本仓库自己作为项目时的配置与工单
web/               # 页面 + beads 适配层
  prefs.mjs        # 用户偏好：列表列 / 列宽 / 排序 / 筛选预设（~/.hlwd/prefs/<用户>.json）
  beads.mjs        # WorkSource 适配层：全项目唯一调用 bd 的文件
  workflow.mjs     # 固定工作流阶段：从最新 run.json 推导「AI 进度」与只读节点图
  tags.mjs         # 标签库：目录 + 使用数 + 改名级联 / 归档 / 删除
  runs.mjs         # 只读端口：把 <项目>/.hlwd/runs 与 journal 给看板
  sessions.mjs     # 只读端口：把每轮 agent 的 events.jsonl 归一成消息流（会话页 / SSE）
  server.mjs       # HTTP JSON 接口 + 静态页，零依赖（node:http）
  app/             # 单页看板：index.html / app.js / graph.js / markdown.js / style.css，无构建
                   #   graph.js：节点图渲染器（卡片页看回放、设置页改节点），拓扑由服务端发
                   #   看板 / （/issue/<id>）工单页：工单 / 流程 / 会话 三个 tab
                   #   工单页是独立地址，可直接分享；评论与字段靠 SSE 实时更新
engine/            # 流程编排
  run.mjs          # 入口：接一张单走完流程，一次只跑一张（--project 指定项目）
  lib.mjs          # 跑命令 / 渲染提示词 / 调 agent-run / 跑门禁
  git.mjs          # 分支 / 提交 / 推送 / PR（gh）的唯一实现；只返回结果，不写 beads
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
- `work` 的参数原样透传：`--dry` / `--id <卡片>` / `--attempts N` / `--allow-dirty` / `--fresh`（忽略「发布失败只重试收尾」的捷径）。
- 脚本 / 冒烟测试用一次性项目时，加 `WF_NO_REMEMBER=1`：这次调用不改「上次打开的项目」（否则下次 `node wf.mjs` 会指向临时目录）。
- `engine` 一次只跑一张，跑完就退；要连续跑就外面套循环。
- 退出码：`0` 完成或没有就绪单；`1` 执行失败 / 审查不通过；`2` 工作区不干净或参数错。
- 依赖解析：要用能找到的 `bd` 与 AI CLI；`agent-tools` 用仓库自带的 `vendor/agent-tools`（`AGENT_TOOLS_BIN` 可覆盖）。
- 首次打开空项目：`bd init` 会建 `.beads/` 并 `git init` + 提交一次（bd 基于 git 工作），项目的 `.gitignore` 也是它写的。
- 看板只是 beads 的一层视图：关掉它不影响数据与流程。看板每 5s 自动刷新，搜索盖标题/描述/评论。
- 看板四列是固定工作流（待接 / 执行中 / 审查中 / 已完成），不能拖列改状态；工单本身只有 open/closed + 标签。人工只能在工单页「关闭 / 重新打开」。
- 列表视图：表头点一下排序、按住表头拖换列序、拖右边界改列宽；「列」里勾选显示哪些列（含「进度」），「筛选」按字段组合过滤（同时作用于看板和列表），常看的条件「存为预设」。这些都存在 `~/.hlwd/prefs/<你>.json` 的项目那一段，换项目各是各的。
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

- **动手前先读**：工单开关与标签、最新工作流进度、已有评论、当前项目（`node wf.mjs` 第一行就写着）。
- **一次只推进一步**：接单就只接单，执行就只执行，审查就只审查。跳阶段等于伪造记录。
- **改动最小**：能改一个函数不新建文件，能改配置不加抽象层。新增抽象要说清它挡住了什么。
- **不留暗门**：不做「先注释掉」「临时硬编码」；临时方案写进工单评论并标回滚条件。
- **完成 = 可复现**：关闭工单时，触发它的人工步骤必须是看板上点一下或 `wf` 的一条命令。
- **不确定就停**：需求含糊、契约要变、要动 beads schema —— 停下来问，不要猜。

## 9. 复用到别的项目

本来就是多项目的：`node wf.mjs --project <目录>` 打开即用，工具不用改。
想让某项目有不同的行为，改**那个项目**的 `.hlwd/config.json` 或 `.hlwd/prompts/`，不要改工具代码。
若某项目需要第四种模块，先证明现有模块吸收不了。
