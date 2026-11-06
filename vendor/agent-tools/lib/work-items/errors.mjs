/**
 * Shared error type. `exitCode` lets the CLI separate invalid input (2) from
 * operational failures (1). Malformed records from a source are invalid input.
 */
export class WorkItemsError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'WorkItemsError'
    this.exitCode = exitCode
  }
}

export function invalidRecord(message) {
  return new WorkItemsError(message, 2)
}
