# lib/web-ui

两个只读看板共用的皮肤和浏览器积木：agent runs（`lib/run-runtime/board.mjs`）与 tapd-loop（`skills/tapd-loop/scripts/page.mjs`）。改一次，两边同时生效。

## 文件

- `theme.css` 调色板与全部通用组件：表格、筛选、markdown、时间线、面板、弹窗（含下钻布局：区块自己滚、时间线吃掉剩下的高度）、diff。
- `markdown.mjs` `esc` / `inlineM` / `md`。图片默认关，TAPD 页面传 `{images:true}`。
- `format.mjs` `dur` / `clock` / `rel` / `msText` / `project`。
- `events.mjs` 时间线事件的唯一形状，以及 progress / pi 两种来源的归一化。纯函数，浏览器也能 import。
- `client.mjs` 浏览器侧渲染：`describeEvent`、`timelineHtml`、`paneHtml`、`diffHtml`、`wireModal`（返回/点空白/Esc 翻成回调）、localStorage 小工具。
- `assets.mjs` 服务端白名单、`pageHead` 和 `modalShell`（下钻弹窗的骨架 HTML）。请求路径只在字面量表里查，永远不拼文件路径。

## 边界

共享层只认识时间线事件、弹窗外壳和中立词汇，不认识 run、card、TAPD、端口、家目录。这些留在各自页面：

- `lib/run-runtime/board-app.js`：run 行、输入面板、用时每秒自走、深链 `?run=` / `?arm=`，栈底是 run、上层是子代理。
- `skills/tapd-loop/scripts/page-app.js`：卡片行、工单/brief/verify/diff/log 面板、子臂下钻、`images/` 改写。
- `skills/tapd-loop/scripts/control.js` + `auth.js`：控制面板（跑/停/定时接单）和看板密钥。它们能触发真跑、要看鉴权，只属于这张页面，不进共享层。

两个页面的详情都是**同一个覆盖层弹窗**（`modalShell()` + `wireModal()` + `theme.css` 里的 `#modal`），不是表格下方展开。展示成什么样由栈决定，开关与层级由共享层保证两边一致。

事件形状：

```
{ t, kind, text?, name?, detail?, ms?, arm?, status?, reason?, tokens?, error? }
kind: say | think | tool | tool_end | arm_start | arm_end | note
```

## 页面怎么拿到这些文件

两个服务都提供：

- `GET /assets/theme.css`
- `GET /assets/client.mjs`
- `GET /assets/events.mjs`
- `GET /assets/markdown.mjs`
- `GET /assets/format.mjs`
- `GET /app.js`：该页面自己的 app 模块

tapd-loop 的页面还多两个只属于它的模块：`GET /control.js`（控制面板）与 `GET /auth.js`（密钥与带 header 的 fetch）。共享层不认识它们。

页面骨架用 `pageHead(title, extraHead)` 加 `${modalShell()}`，然后 `<script type="module" src="/app.js">`。浏览器模块只用相对 URL（`/assets/client.mjs`），不要出现 `node:`、`process`、`require`；`tests/web-ui/units.test.mjs` 会拦。

## 迭代规则

- 视觉/格式/时间线/面板/弹窗/diff 的改动只改这里，两边一起看。
- 只属于一张页面的排版（表格列宽、卡片行里几个格子）写回该页面的 `<style>`，不要塞进共享层。
- 弹窗外壳只能改 `modalShell()` 与 `theme.css` 的 `#modal`：两张页面挂的是同一份骨架，改一处两边一起变。
- 页面骨架必须在请求时现拼（`pageHtml()`），不能烘成模块级常量：`app.js` 和 `/assets/*` 都是读盘的，常驻进程里只有 HTML 会被冻住。两边错位时点卡片不会报错也不会开弹窗 —— 旧进程发旧骨架、新 `app.js` 摸不到 `#modal`。改完外壳还得 `board stop` + `board ensure` 一次。
- 新事件来源在 `events.mjs` 里加一个归一化函数，不要在页面里判断上游字段。
- 改完跑 `node scripts/test-components.mjs web-ui`，再用真浏览器点一遍（`node --test` 不做视觉断言）：列表 → 开弹窗 → 下钻 → 返回 → Esc。
