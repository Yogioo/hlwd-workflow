# AGENTS.md

公司内部工作流站点。人建单、AI 干活：**接单 → 执行 → 审查 → 完成工单**。
只做「把工单派给 AI 并验收」这件事，不做业务系统、不做研发脚手架。

## 1. 三条铁律

1. **唯一真相源是 beads。** 不另建数据库、不缓存工单状态、不在代码里藏待办清单。任何字段都能用 `bd` 读回。
2. **只有黑盒，没有共享内部。** 三个模块互相只通过 §3 的契约通信；跨模块 `import` 内部实现一律视为破坏。
3. **依赖只往一个方向长。** `web`、`engine` 都依赖 beads 适配层；`web` 不认识 `engine`，`engine` 不认识 `web`。

## 2. 三个黑盒

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `beads` | 工单存储与状态（`.beads/`，`bd` CLI） | 不跑 AI、不判验收 |
| `web` | 建单、看板、详情、改单 | 不跑 AI、不写 git、不绕开适配层 |
| `engine` | 拉单 → 执行 → 审查 → 回写结论 | 不渲染页面、不定义工单字段 |

数据流：`人 → web → beads → engine → beads → web → 人`。
两个模块之间没有直接调用，beads 就是消息总线。

## 3. 契约（改这里要先改文档）

**WorkSource**（beads 适配层，`web` 与 `engine` 共用同一份实现）

```
list(filter) -> Issue[]        # 只读
get(id) -> Issue               # 只读
create(fields) -> Issue
update(id, patch) -> Issue     # 含状态迁移
comment(id, text) -> void
```

- `Issue` 是最小字段集：`id, title, body, status, labels, assignee, created, updated`。加字段先加到 `bd` 的 schema，再改这里，一次只加一个。
- 适配层内部只能用 `bd` CLI（或 beads 官方 HTTP 接口）。禁止直连 `.beads/*.db` 写数据。

**AgentRunner**（AI 执行，`engine` 内部，对外只暴露一个函数）

```
run(promptFile, workdir, sandbox) -> {status, outDir, events}
```

- 实现直接复用 `agent-tools agent-run`（技能 `agent-run`），**不要自己拼 CLI、不要 fork 一份**。升级/换 runner 改配置，不改 `engine` 代码。
- `status` 只表示这一轮跑没跑起来（`ok|empty|error|timeout|aborted`），**永远不代表「做完了」或「审查通过」**。

**验收归 engine。** 是否通过由 §4 状态机 + 执行产物（commit/测试输出）决定，不由 runner 退出码决定。

**RunTrace**（只读端口：`web` 读 engine 的运行记录）

```
.engine/runs/<cardId>-<ts>/run.json   # 一次运行：卡片快照 / attempts / verdict / commit / outcome
.engine/journal.ndjson                # 全部运行的事件流，append-only，一行一事件
```

- 这两处是**产物，不是状态**：真相源仍然只有 beads。删掉它们，工单照样成立（只是追溯变模糊）。
- 写方只有 `engine`（append-only，不改历史）；读方只有 `web`。`web` 不读 engine 的代码，只读这两个路径。
- 归档/清理是人的事，engine 不自动删。

## 4. 状态机（就这四个，别加）

```
open ──ready-for-agent──> in_progress ──> review ──> closed
                              │              │
                              └──失败/超时──> open（回退，附原因评论）
                                            └──审查不通过──> in_progress（同一工作区继续改）
```

- 状态用 beads 原生 `status` 承载；`review` 是自定义状态，靠 `bd config set status.custom "review:wip"` 注册，不新增字段。
- `ready-for-agent` 用 label 表达，与 `status` 正交：它回答「能不能派给 AI」，不回答「处在哪一步」。
- 每次迁移必须留一条 `comment`：谁改的、为什么、产物路径。
- 卡住的单只能靠评论解释，不允许「人工下线」这种暗门。

## 5. 目录

```
AGENTS.md
package.json       # 只有 scripts，没有依赖
.beads/            # 唯一真相源，进版本库
web/               # 页面 + beads 适配层
  beads.mjs        # WorkSource 适配层：全项目唯一调用 bd 的文件
  runs.mjs         # 只读端口：把 .engine/runs/*/run.json 给看板
  server.mjs       # HTTP JSON 接口 + 静态页，零依赖（node:http）
  app/             # 单页看板：index.html / app.js / style.css，无构建
engine/            # 流程编排：claim / execute / review / complete
  run.mjs          # 入口：接一张单走完流程，一次只跑一张
  lib.mjs          # 跑命令 / 渲染提示词 / 调 agent-run（不碰 beads）
  manifest.mjs     # 写 run.json 与 journal.ndjson（可追溯）
  config.json      # runner / sandbox / 重试次数，改这里不改代码
  flows/           # 一个阶段一个文件，一个文件一个职责
    claim.mjs      #   接单：open + ready → in_progress
    execute.mjs    #   执行：渲染 prompt → 一次 agent 回合
    review.mjs     #   审查：另一回合 → 读 verdict JSON
    complete.mjs   #   收尾：提交+关闭，或回退并说明原因
  prompts/         # 喂给 AgentRunner 的提示词模板（execute / review）
  skills/agent-run # 复制维护的 agent-run 技能（上游可覆盖）
```

运行产物写 `.engine/runs/<卡片id>-<时间戳>/`，已 gitignore：里面是 prompt、`verdict-N.json`、每次 agent 回合的 events，以及人类读的 `run.json`。提交信息带 `Card:` / `Run:` 两个 trailer，反查用 `git log --grep='^Card: <id>'`。

新目录出现前先问：它是不是上面三个模块之一？不是就别建。模块内的分层（`flows/` 怎么拆）由该模块自己的 `AGENTS.md` 决定，本文件不越界。

## 6. 给 AI 的作业守则

- **动手前先 `bd` 读一遍**：工单当前状态、已有评论、是否被人认领。别人在跑的单不要碰。
- **一次只推进一步**：接单就只接单，执行就只执行，审查就只审查。跳过阶段等于伪造记录。
- **改动最小**：能改一个函数不新建文件，能改配置不加抽象层。新增抽象必须能用一句话说清它挡住了什么。
- **不留暗门**：不做「先注释掉」「临时硬编码」；临时方案写进工单评论并标明回滚条件。
- **完成 = 可复现**：工单关闭时，触发它的人工步骤必须是 `web` 上点一下或 `engine` 的一条命令，不接受口头结论。
- **不确定就停**：需求含糊、跨模块契约要变、需要动 beads schema —— 停下来问，不要猜。

## 7. 跑起来

```bash
npm start                             # 看板 → http://127.0.0.1:3100（PORT 可改）
npm run engine                        # 接一张就绪单，走完 接单→执行→审查→完成
node engine/run.mjs --dry             # 只看会接哪张，不动任何数据
node engine/run.mjs --id <卡片id>     # 指定单（已被接单后重启用）
bd ready                              # 看就绪工单
bd show <id>                          # 看详情与评论
agent-tools work-items list --source beads --workdir . --ready --ready-label ready-for-agent
agent-tools agent-run capabilities    # 确认执行端可用
```

- `engine` 一次只跑一张，跑完就退；要连续跑就外面套循环，调度不写进 engine。
- 退出码：`0` 完成或没有就绪单；`1` 执行失败 / 审查不通过；`2` 工作区不干净或参数错。
- 依赖解析：`web/beads.mjs` 需能找到 `bd`（Windows 用 `bd.exe`），`engine/lib.mjs` 需能找到 `agent-tools`；找不到时分别设 `BD_BIN` / `AGENT_TOOLS_BIN`。

- 看板只是 beads 的一层视图：关掉 `npm start` 不影响任何数据与流程。
- `web/beads.mjs` 默认自动找 `bd`；找不到时设 `BD_BIN` 指向 bd 可执行文件（Windows 用 `bd.exe`）。

`engine` 只在工作区干净时启动；脏工作区的改动会被算进当前这张单的提交里，必须先处理干净。

## 8. 复用到别的项目

这套骨架与业务无关。换项目时只改三处，别改结构：

1. `.beads/` 指向新项目的工单库；
2. `engine/prompts/` 换成该项目「什么叫做完」的定义；
3. `web/` 的字段标签换成该项目的说法。

其余（三黑盒、契约、五状态、铁律）保持不变。若某项目需要第四种模块，先证明它不能被现有三个模块吸收。
