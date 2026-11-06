// Adapted from skills/exec-review/scripts/runners/pi.mjs.
// Role-neutral: no executor/reviewer permissions; the caller picks sandbox.
import { spawnStreamTurn } from './spawn-agent-turn.mjs'

/**
 * @param {{
 *   bin?: string,
 *   model?: string,
 *   provider?: string,
 *   thinking?: string,
 *   sandbox?: string,
 *   approve?: boolean,
 * }} opts
 */
export function createPiRunner(opts = {}) {
  const bin = opts.bin || process.env.PI_BIN || 'pi'
  const defaultModel = opts.model || ''
  const defaultProvider = opts.provider || ''
  const defaultThinking = opts.thinking || ''
  const defaultSandbox = opts.sandbox || 'workspace-write'
  const approve = opts.approve !== false

  return {
    name: 'pi',
    bin,
    /** pi `--session-id` creates or resumes, so it is the most complete tier. */
    sessionMode: 'create-or-resume',
    /**
     * @param {object} turn
     * @param {string} turn.workdir
     * @param {string} turn.prompt
     * @param {string} turn.promptFile path to the already-written prompt file
     * @param {string} turn.outFile
     * @param {string} turn.logFile
     * @param {string} [turn.session] session reference; resume when given
     * @param {string} [turn.eventsFile]
     * @param {string} [turn.schemaFile] unsupported; rejected if set
     * @param {string} [turn.sandbox]
     * @param {string} [turn.model]
     * @param {string} [turn.provider]
     * @param {string} [turn.thinking]
     * @param {boolean} [turn.dryRun]
     * @param {number} [turn.timeoutMs]
     * @param {AbortSignal} [turn.signal]
     */
    runTurn(turn) {
      // pi has no --output-schema; silently dropping it would fake enforcement.
      if (turn.schemaFile) {
        throw new Error('pi runner 不支持 --output-schema；请在 prompt 中要求 JSON，或改用 codex')
      }
      const sandbox = turn.sandbox || defaultSandbox
      const model = turn.model || defaultModel
      const provider = turn.provider || defaultProvider
      const thinking = turn.thinking || defaultThinking
      // A resumed turn must not carry --no-session or it will not land in the session.
      const args = turn.session
        ? ['-p', '--session-id', String(turn.session), '--mode', 'json']
        : ['-p', '--no-session', '--mode', 'json']

      if (approve) args.push('--approve')
      else args.push('--no-approve')

      if (provider) args.push('--provider', provider)
      if (model) args.push('--model', model)
      if (thinking) args.push('--thinking', thinking)

      if (sandbox === 'read-only') {
        args.push('--exclude-tools', 'write,edit', '--tools', 'read,grep,find,ls', '--no-extensions', '--no-mcp')
      }

      if (turn.promptFile) {
        args.push(`@${turn.promptFile}`)
      } else {
        args.push(turn.prompt)
      }

      return spawnStreamTurn({
        bin,
        knownName: 'pi',
        runner: 'pi',
        workdir: turn.workdir,
        args,
        outFile: turn.outFile,
        logFile: turn.logFile,
        eventsFile: turn.eventsFile,
        onEvent: turn.onEvent,
        writeOutFile: true,
        dryRun: turn.dryRun,
        timeoutMs: turn.timeoutMs,
        signal: turn.signal,
      })
    },
  }
}
