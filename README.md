# hlwd-workflow

> 一个**本地**工具：网页看板 + AI 工作流。
> 人建单 → AI 接单 → 执行 → **门禁** → 审查 → 提交关单，全过程可追溯。

它自己不存业务数据：工单在你打开的**项目目录**里（beads 数据库），运行记录在项目的 `.hlwd/`。换项目就换一整套数据，工具本身不用改。

- 零依赖：只用 Node 标准库，没有 npm 依赖、没有构建步骤
- 单页看板：建单 / 改单 / 一键派单 / 看全链路 / 内网分享
- 门禁可编程：每个项目自带 `.hlwd/gate.mjs`，返回值决定「这一轮算不算过关」
- 自动流水线：开了之后有就绪单就自己干，不用守终端

---

## 1. 前置依赖

| 依赖 | 用途 | 安装 |
|---|---|---|
| Node.js **≥ 20** | 跑工具本身 | https://nodejs.org |
| `bd`（beads） | 工单存储，每个项目一份 | `npm i -g @beads/bd` |
| AI CLI 一个 | 真正干活（`pi` / `codex` / `cursor-agent`） | 自己装，能命令行跑通就行 |
| `agent-tools` | 把一次 agent 回合规范化 | **已随仓库自带**，不用装 |

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

## 2. 30 秒上手

```bash
git clone https://github.com/Yogioo/hlwd-workflow.git
cd hlwd-workflow

node wf.mjs --project /path/to/your/project    # 打开你的项目（会自动建 .hlwd/ 与 .beads/）
node wf.mjs board --bg                         # 起看板，浏览器打开 http://127.0.0.1:3100
node wf.mjs new "把登录页的错误提示改清楚"       # 建一张单（自动打上可派标签）
node wf.mjs work                               # 让 AI 干这一张
```

或者更省事：看板右上角点 **「自动流水线：开」**，之后在面板里点 **「让 AI 干这个」**，剩下的它自己做——不用守终端。

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
| 工单面板 | 改状态 / 优先级 / 加标签 / 评论 / **一键派单** |
| 一键派单 | 没标签就加 `ready-for-agent`；已关闭的顺手改回「待接」；已打的变成「取消派单」 |
| 全链路 | 接单 → 执行 → 门禁 → 审查 → 提交，带耗时、原因、原始 JSON |
| 设置 | 状态/优先级中文名、AI 执行参数、提示词、门禁、自动流水线 |

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
