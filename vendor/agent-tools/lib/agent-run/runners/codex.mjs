// Adapted from skills/exec-review/scripts/runners/codex.mjs.
// Role-neutral: no executor/reviewer permissions; the caller picks sandbox.
import { spawnStreamTurn } from './spawn-agent-turn.mjs'

/**
 * @param {{ bin?: string, model?: string, thinking?: string, sandbox?: string, approve?: boolean }} opts
 */
export function createCodexRunner(opts = {}) {
  const bin = opts.bin || process.env.CODEX_BIN || 'codex'
  const defaultModel = opts.model || ''
  const defaultThinking = opts.thinking || ''
  const defaultSandbox = opts.sandbox || 'workspace-write'

  return {
    name: 'codex',
    bin,
    /** `codex exec resume` only continues an existing session; it cannot create one. */
    sessionMode: 'resume',
    /** codex is the only adapter with a native output schema. */
    outputSchema: true,
    /**
     * @param {object} turn
     * @param {string} turn.workdir
     * @param {string} turn.prompt
     * @param {string} turn.outFile
     * @param {string} turn.logFile
     * @param {string} [turn.session] session reference; must already exist
     * @param {string} [turn.eventsFile]
     * @param {string} [turn.schemaFile]
     * @param {string} [turn.sandbox]
     * @param {string} [turn.model]
     * @param {string} [turn.thinking]
     * @param {boolean} [turn.dryRun]
     * @param {number} [turn.timeoutMs]
     * @param {AbortSignal} [turn.signal]
     */
    runTurn(turn) {
      if (turn.session && (turn.sandbox !== undefined || opts.sandbox !== undefined)) {
        throw new Error('codex resume cannot apply a sandbox override; it uses session settings')
      }
      if (turn.provider || opts.provider) throw new Error('codex runner does not support a provider override')
      const sandbox = turn.sandbox || defaultSandbox
      const model = turn.model || defaultModel
      const thinking = turn.thinking || defaultThinking
      // resume accepts neither -C nor -s nor --color: cwd comes from spawn, and
      // there is no sandbox flag on the resume path.
      const args = turn.session
        ? ['exec', 'resume', String(turn.session), '-o', turn.outFile, '--json']
        : ['exec', '-C', turn.workdir, '-s', sandbox, '-o', turn.outFile, '--json', '--color', 'never']
      if (turn.schemaFile) args.push('--output-schema', turn.schemaFile)
      if (model) args.push('-m', model)
      if (thinking) args.push('-c', `model_reasoning_effort=${thinking}`)
      // prompts always go through stdin; `-` reads stdin on both paths
      args.push('-')

      return spawnStreamTurn({
        bin,
        knownName: 'codex',
        runner: 'codex',
        workdir: turn.workdir,
        args,
        stdinText: turn.prompt,
        outFile: turn.outFile,
        logFile: turn.logFile,
        eventsFile: turn.eventsFile,
        onEvent: turn.onEvent,
        writeOutFile: false,
        dryRun: turn.dryRun,
        timeoutMs: turn.timeoutMs,
        signal: turn.signal,
      })
    },
  }
}
