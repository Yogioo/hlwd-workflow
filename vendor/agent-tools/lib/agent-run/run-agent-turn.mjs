// Programmatic entry point for a single agent turn. Role-neutral: it never
// enforces an executor/reviewer pipeline and never decides task acceptance.
import { createRunner } from './runners/index.mjs'

/**
 * Run exactly one turn and report invocation facts.
 * @param {object} options
 * @param {'pi'|'codex'|'agent'} [options.runner='agent']
 * @param {string} [options.bin]
 * @param {string} options.workdir
 * @param {string} [options.prompt]
 * @param {string} [options.promptFile]
 * @param {string} options.outFile
 * @param {string} options.eventsFile
 * @param {string} options.logFile
 * @param {string} [options.model]
 * @param {string} [options.provider]
 * @param {string} [options.thinking]
 * @param {string} [options.sandbox]
 * @param {boolean} [options.approve]
 * @param {boolean} [options.streamPartialOutput]
 * @param {string} [options.session]
 * @param {string} [options.schemaFile]
 * @param {boolean} [options.dryRun]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void} [options.onEvent] 归一化事件回调（观察用，异常被吞）
 * @returns {Promise<{runner: string, exitCode: number, timedOut: boolean, aborted: boolean,
 *   outputFile: string, eventsFile: string, logFile: string}>}
 */
export async function runAgentTurn(options = {}) {
  const {
    runner = 'agent',
    bin,
    workdir,
    prompt,
    promptFile,
    outFile,
    eventsFile,
    logFile,
    model,
    provider,
    thinking,
    sandbox,
    approve,
    streamPartialOutput,
    session,
    schemaFile,
    dryRun,
    timeoutMs,
    signal,
    onEvent,
  } = options

  const adapter = createRunner(runner, { bin, model, provider, thinking, sandbox, approve, streamPartialOutput })
  const result = await adapter.runTurn({
    workdir,
    prompt,
    promptFile,
    outFile,
    eventsFile,
    logFile,
    session,
    schemaFile,
    dryRun,
    timeoutMs,
    signal,
    onEvent,
  })

  return {
    runner: adapter.name,
    exitCode: result.code,
    timedOut: result.timedOut === true,
    aborted: result.aborted === true,
    outputFile: outFile,
    eventsFile,
    logFile,
  }
}
