# AGENTS.md

一个**本地工具**：看板 + AI 工作流。它自己不存业务数据——数据都在被打开的那个**项目目录**里。
人建单、AI 干活：**接单 → 执行 → 审查 → 完成工单**。

## 1. 三条铁律

1. **唯一真相源是项目里的 beads。** 不另建数据库、不缓存工单状态、不在代码里藏待办清单。任何字段都能用 `bd` 读回。
2. **只有黑盒，没有共享内部。** 模块之间只通过 §4 的契约通信；跨模块 `import` 内部实现一律视为破坏。
3. **工具与项目分离。** 工具（本仓库）只提供能力；`<项目>/.hlwd/`（配置、提示词、运行记录）与 `<项目>/.beads/`（工单）属于项目，换项目就换一整套数据。

## 2. 模块

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `beads`（`bd`） | 工单存储与状态，每个项目一份 | 不跑 AI、不判验收 |
| `web` | 看板、建单、改单、改项目配置、切项目 | 不跑 AI、不写 git、不绕开适配层 |
| `engine` | 接单 → 执行 → 审查 → 回写结论 | 不渲染页面、不定义工单字段 |
| `project.mjs` | 打开项目：补齐 `.hlwd/`、缺 `.beads/` 就 `bd init` | 不存状态、不调 AI |

数据流：`人 → web → beads → engine → beads → web → 人`。web 与 engine 互不调用，beads 是消息总线。
当前打开哪个项目，只记在全局 `~/.hlwd/state.json`（**不是**项目配置）。

## 3. 产物布局

```
工具（本仓库）                     项目（被开发的目标目录）
  wf.mjs                             .hlwd/config.json     状态/优先级中文名 + engine 配置
  project.mjs                        .hlwd/prompts/*.md    项目定制的提示词
  web/  engine/                      .hlwd/runs/           每次运行一个目录（gitignore）
  .hlwd/  .beads/  ← 它自己也是        .hlwd/journal.ndjson  事件流（gitignore）
     一个可以被打开的项目             .beads/               工单
```

`.hlwd/.gitignore` 由工具生成，只排 `runs/` 与 `journal.ndjson`——配置和提示词要进版本库。

## 4. 契约（改这里要先改文档）

**Project**（`project.mjs`，web 与 engine 共用）

```
ensureProject(dir) -> {dir, created[], config}   # 补齐 .hlwd/、prompts、runs、.beads
readProjectConfig(dir) / saveProjectConfig(dir, patch)
readPrompts(dir) / savePrompts(dir, {execute, review})
```

- 打开项目是**幂等**的：已存在的一律不覆盖，只在返回值里说明补了什么。
- 配置写入必须校验：不认识的 runner / 非 1–5 的 attempts / 空名称一律拒绝，宁可不保存。

**WorkSource**（beads 适配层，`web` 与 `engine` 共用一份实现）

```
setWorkdir(dir)                # 之后所有 bd 命令都在这个项目下跑
list(filter) -> Issue[]
get(id) -> Issue
create(fields) -> Issue
update(id, patch) -> Issue     # 含状态迁移
comment(id, text) -> void
```

- `Issue` 最小字段集：`id, title, body, status, labels, assignee, created, updated`。
- 只能用 `bd` CLI（或 beads 官方 HTTP 接口）。禁止直连 `.beads/*.db` 写数据。

**AgentRunner**（`engine` 内部，对外只暴露一个函数）

```
run(promptFile, workdir, sandbox) -> {status, outDir, events}
```

- 复用 `agent-tools agent-run`（技能 `agent-run`），**不要自己拼 CLI、不要 fork**；换 runner 改配置，不改代码。
- `status` 只表示这一轮跑没跑起来，**永远不代表「做完了」或「审查通过」**。

**验收归 engine。** 是否通过由 §5 状态机 + 执行产物（commit/测试输出）决定，不由 runner 退出码决定。

**RunTrace**（`web` 只读）

```
<项目>/.hlwd/runs/<cardId>-<ts>/run.json   # 卡片快照 / attempts / verdict / commit / outcome
<项目>/.hlwd/journal.ndjson                # append-only，一行一事件
```

- 这两处是**产物，不是状态**：删掉它们工单照样成立，只是追溯变模糊。
- 写方只有 `engine`；读方只有 `web`。`web` 不读 engine 的代码，只读这两个路径。

**Config / Prompts**（`<项目>/.hlwd/`）

```
config.json: labels.statuses / labels.priorities / columns / engine.*
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
- `ready-for-agent` 用 label 表达，与 `status` 正交：它回答「能不能派给 AI」。
- 每次迁移留一条评论，**只写一句 AI 结论**（例：`AI 已完成并提交 1a2b3c4。`）；验证命令、耗时、原始事件进 `run.json` / 全链路。

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
  server.mjs       # HTTP JSON 接口 + 静态页，零依赖（node:http）
  app/             # 单页看板：index.html / app.js / markdown.js / style.css，无构建
                   #   工单页（人看，markdown）/ 全链路页（程序看，含原始 JSON）
engine/            # 流程编排
  run.mjs          # 入口：接一张单走完流程，一次只跑一张（--project 指定项目）
  lib.mjs          # 跑命令 / 渲染提示词 / 调 agent-run
  manifest.mjs     # 写 run.json 与 journal.ndjson
  flows/           # 一个阶段一个文件：claim / execute / review / complete
  prompts/         # 默认提示词模板（项目没定制时用它）
  skills/agent-run # 复制维护的 agent-run 技能（上游可覆盖）
```

新目录出现前先问：它属于工具、还是属于项目？两边都不属于就别建。

## 7. 跑起来

```bash
node wf.mjs                       # 我现在该干什么：当前项目 + 工单概况 + 下一步
node wf.mjs board [--bg]          # 看板（npm start = --bg）
node wf.mjs stop                  # 停掉后台看板（npm run stop）
node wf.mjs work                  # 让 AI 干下一张就绪单（npm run engine）
node wf.mjs trace <卡片id>        # 终端看一张单的全链路
node wf.mjs new "标题" [描述]     # 建单，自动打可派标签

node wf.mjs --project D:\code\foo ...   # 任何动词都可以指定项目
```

- 不给 `--project` 就用上次打开的项目；首次打开会自动建 `.hlwd/` 与 `.beads/`。
- `work` 的参数原样透传：`--dry` / `--id <卡片>` / `--attempts N` / `--allow-dirty`。
- `engine` 一次只跑一张，跑完就退；要连续跑就外面套循环。
- 退出码：`0` 完成或没有就绪单；`1` 执行失败 / 审查不通过；`2` 工作区不干净或参数错。
- 依赖解析：要用能找到的 `bd` 与 `agent-tools`，找不到时设 `BD_BIN` / `AGENT_TOOLS_BIN`。
- 看板只是 beads 的一层视图：关掉它不影响数据与流程。看板每 5s 自动刷新，搜索盖标题/描述/评论。

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
