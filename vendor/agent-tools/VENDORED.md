# vendor/agent-tools

这个目录是 [`@yogioo/agent-tools`](https://github.com/Yogioo/agent-skills) 的**副本**，为的是让 `hlwd-workflow` 开箱能用：不用先全局安装一个私有工具包。

| 项 | 值 |
|---|---|
| 上游 | `git@github.com:Yogioo/agent-skills.git`（public） |
| 版本 | `@yogioo/agent-tools@0.1.0` |
| 上游 commit | `9fb4ba8`（2026-11-05） |
| 复制内容 | `bin/`、`lib/`、`tools/`、`package.json`、上游 `README.md`（未复制 `skills/`、`tests/`、`scripts/`） |
| 依赖 | 无（上游零外部依赖，只用 Node 标准库） |
| 许可 | 上游 package.json 标 `UNLICENSED`；这里是作者本人代码的副本，随本仓库以 [MIT](../../LICENSE) 发布 |

## 怎么用

`engine/lib.mjs` 的解析顺序：

1. `AGENT_TOOLS_BIN` 环境变量（想换成全局安装或自己的包装脚本时用）
2. **本目录**（`vendor/agent-tools/bin/agent-tools.mjs`，用当前 node 跑）
3. `agent-tools`（PATH 里的全局安装）

自检：

```bash
node vendor/agent-tools/bin/agent-tools.mjs agent-run capabilities
```

## 上游更新时

```bash
# 从上游仓库或 npm 全局安装目录重新复制
cp -r <agent-skills>/bin <agent-skills>/lib <agent-skills>/tools vendor/agent-tools/
cp <agent-skills>/package.json <agent-skills>/README.md vendor/agent-tools/
# 更新上面的 commit/版本号，然后跑 npm test
```

只依赖 `agent-run` 这一个子命令，但整包复制以保留 CLI 的分发结构与相对导入。
