# Yogioo's Agent Skills

Personal agent skills plus a private local toolkit, `@yogioo/agent-tools`.

Three layers live here and are installed differently:

| Layer | Where | What it is |
|-------|-------|------------|
| Library | `lib/` | Reusable ESM modules with explicit inputs; import via package subpaths |
| CLI | `tools/`, `bin/` | Executable Node CLIs behind one `agent-tools` dispatcher |
| Skills | `skills/` | Thin routing instructions for an agent, not implementation |

The runtime is a single private Node package (Node >= 20, no external
dependencies). It is never published to a registry; install it from this repo or
from a locally packed tarball.

## Layout

```
package.json          private @yogioo/agent-tools
bin/agent-tools.mjs   one dispatcher: agent-tools <component> [options]
lib/                  reusable modules (the source of truth)
tools/<name>/         executable CLIs (import lib/, never skills/)
skills/               SKILL.md routing wrappers + legacy workflows
tests/<component>/    component and packaging tests
scripts/sync-links.ps1  local dev junctions
```

## Install the runtime

CLI use, global install from a local checkout or packed tarball:

```powershell
# from the repo
npm install -g C:\projects\agent-skills
# or pack once and install the artifact
npm pack            # produces yogioo-agent-tools-0.1.0.tgz
npm install -g .\yogioo-agent-tools-0.1.0.tgz
agent-tools --help
```

Library use, add it to a project so subpath imports resolve:

```powershell
npm install C:\projects\agent-skills               # local path
npm install .\yogioo-agent-tools-0.1.0.tgz         # packed tarball
```

```js
import { runAgentTurn } from '@yogioo/agent-tools/agent-run'
import { runArms, parseRoleTable, classifyTurn } from '@yogioo/agent-tools/subagent'
import { capabilities } from '@yogioo/agent-tools/agent-run/runners'
import { normalizeEvent } from '@yogioo/agent-tools/agent-events'
import { acquireLease, mergeConfigFiles } from '@yogioo/agent-tools/runtime'
import { captureWorkspace, diff } from '@yogioo/agent-tools/workspace-diff'
import { assemblePrompt } from '@yogioo/agent-tools/prompt-compose'
import { writeEvent, ackEvent } from '@yogioo/agent-tools/event-inbox'
import { createRequirement } from '@yogioo/agent-tools/requirement-store'
import { parseQuestionnaire } from '@yogioo/agent-tools/questionnaire'
import { createWorkSource } from '@yogioo/agent-tools/work-items'
```

Each component's exact options and exit codes are authoritative in its CLI help:

```powershell
agent-tools agent-run --help
agent-tools subagent --help
agent-tools work-items --help
agent-tools questionnaire serve --help   # or: poll --help
agent-tools xlsx-cell-diff --help
```

## Runners

`agent-tools subagent` runs each arm on a CLI: `pi`, `codex`, or `agent` (Cursor).
A role names its own runner in the role table, so one table can spread work across
several quota pools:

```
# runner: pi
how explorer: opencode-go/grok-4.7-xhigh
judgment and prose: cursor:auto
swarm workers: codex:gpt-5.1-codex-xhigh
```

For Cursor, `cursor:auto` is the whole story: it is Cursor's own default model, so
nothing has to be chosen or kept in step with a subscription.

Adding a fourth CLI means one entry in `CAPABILITIES`
(`lib/agent-run/runners/index.mjs`) and a `createRunner` case. Everything else
reads that declaration: the aliases that name the runner, whether reasoning effort
is a separate parameter or part of the model id, whether it has providers, and how
it lists its own models. `lib/subagent` receives the declaration as an argument, so
it hardcodes no runner names.

`agent-tools subagent doctor` checks every value against its own runner's model
list, and `probe` spends one cheap read-only turn per distinct target to find out
which ones actually answer. An id that exists is not an id that works: a provider
with no subscription answers 403.

## Watching a run

A `subagent run` takes minutes and whoever started it is usually talking to an
agent, not watching a terminal. So the runtime keeps one always-on, read-only
board per machine, and every run registers itself in it:

```
agent-tools run-runtime board ensure    # idempotent; prints {"url": ...}
agent-tools run-runtime board status
agent-tools run-runtime board stop
```

The board scans `<AFK home>/runs/*.json`, so it shows every project at once and
survives any single run. `subagent run` calls `ensure` for you and puts
`{"board":{"url","runId"}}` in its result — that URL is what to hand a human.
It also prints it to stderr with a `?run=<runId>` deep link that preselects the run,
and writes the same link to `<out-dir>/board.url`, because nobody reads a JSON
result looking for a URL. It listens on `0.0.0.0` and prints the LAN address, so a
teammate can open it; the port is remembered in `<AFK home>/board/state.json` so the
link keeps working. It reads no config and exposes no write endpoint. A run whose
process died without finishing is marked **中断**, never shown as running.

Runs are **history, not a live list**: finishing marks the record `endedAt` and
leaves it in place, so yesterday's run is still there today. The page defaults to
a 7-day window (`近 1 天 / 近 7 天 / 近 30 天 / 全部`, plus `只看运行中`), and the
window only filters what is served — the records stay on disk. Deleting is always
explicit:

```
agent-tools run-runtime runs list --days 7 | --all | --alive
agent-tools run-runtime runs adopt  --out-dir <dir> --workdir <dir>   # backfill a dir (and its prompts) into history
agent-tools run-runtime runs forget --run-id <id>
agent-tools run-runtime runs prune  --older-than 30                    # days, default 30
```

Each run also writes `<out-dir>/progress.jsonl` with only `arm_start`, `think`,
`say`, `tool` and `arm_end` — a turn's `events.jsonl` runs to megabytes and is not
a progress feed. `arm_start` carries the input it was given (first 700 chars of the
brief, its length and its path) plus runner/model/thinking, so the page can say
what the run is *about*; `think` and `say` hold one truncated line per completed
reasoning block and assistant message (streaming deltas are dropped — one turn
emits ~50k of them); `tool` lines carry a `detail` (the file relative to the
workdir, the command, the pattern) so the page can say *读 …/TerrainConfigPage.cs*
instead of `name=read`. The board renders all of it as a timeline: wall-clock
time, offset from the arm's start, the action, and how long the tool took.

The prompt and each arm's knobs are also copied into the run **record** (`inputs`
and `arms`: runner/cli, model, thinking, provider — one entry per arm),
not only into `progress.jsonl`: the board only reads the tail of the progress file,
so on a long run the opening `arm_start` falls out of the window exactly when the
finished run is most interesting. `runs adopt` rebuilds the prompt from each arm's
`events.jsonl` (the first `role: user` message, bounded to a 4MB head read) and the
knobs from the first line of its `log.txt` (the command line subagent actually ran),
and picks the original brief path back out of the `<file name="...">` wrapper pi adds.
A record written *before* those fields existed is backfilled on the fly from the head
of `progress.jsonl` (first 64KB, cached by runId), which is why a run that is still
running shows its brief even though nobody re-registered it.

## Skills

Skills are routing instructions for an agent. The toolkit wrappers call the
installed `agent-tools` command; they contain no implementation and assume the
runtime is installed separately. A copied wrapper alone does **not** include the
runtime.

Install each wrapper by name (the runtime still comes from the local package
above):

```bash
npx skills add Yogioo/agent-skills --skill questionnaire -g -y
```

| Skill | Routes to |
|-------|-----------|
| [agent-run](./skills/agent-run/SKILL.md) | one agent turn + event normalization |
| [subagent-run](./skills/subagent-run/SKILL.md) | one or more turns from a pstack role table |
| [setup-yogioo](./skills/setup-yogioo/SKILL.md) | post-install setup: pstack models, then doctor |
| [work-items](./skills/work-items/SKILL.md) | beads / GitHub / TAPD work items |
| [questionnaire](./skills/questionnaire/SKILL.md) | local web form, one submission |
| [xlsx-cell-diff](./skills/xlsx-cell-diff/SKILL.md) | xlsx display-value diff / merge |
| [yogioo-mode](./skills/yogioo-mode/SKILL.md) | a full workflow: its own playbooks and principles, arms through the toolkit |

The last one is not a wrapper and calls no CLI of its own beyond `agent-tools`. It
is a self-contained workflow: playbooks, principles and reply rules live under
`skills/yogioo-mode/`, and every delegated step runs as an `agent-tools subagent`
arm because Pi has no native subagent tool.

The six legacy workflow skills keep their existing implementations and
configuration. They are unrelated to the toolkit runtime and are not migrated by
it: [afk-init](./skills/afk-init/SKILL.md), [afk-run](./skills/afk-run/SKILL.md),
[afk-watch](./skills/afk-watch/SKILL.md),
[afk-requirement-assistant](./skills/afk-requirement-assistant/SKILL.md),
[exec-review](./skills/exec-review/SKILL.md),
[to-questionnaire-web](./skills/to-questionnaire-web/SKILL.md).

## Local development (live junctions)

Junction the active skills into the agents directory so the agent reads this repo
directly. `-Prune` removes only retired junctions that point exactly at this
repo's `skills/<name>` and no longer contain `SKILL.md`; foreign links and real
directories are never touched.

```powershell
cd C:\projects\agent-skills
pwsh -File .\scripts\sync-links.ps1
pwsh -File .\scripts\sync-links.ps1 -Prune
pwsh -File .\scripts\sync-links.ps1 -Force            # replace a real directory
pwsh -File .\scripts\sync-links.ps1 -WhatIf           # show, change nothing
pwsh -File .\scripts\sync-links.ps1 -Destination $env:TEMP\agents-skills   # isolated target
```

## Tests

```powershell
npm test
node scripts/test-components.mjs agent-run subagent work-items questionnaire xlsx-cell-diff
node scripts/test-components.mjs components layers
node scripts/test-components.mjs packaging
```

Component and packaging tests use local fakes for remote transports and never
call remote services.
