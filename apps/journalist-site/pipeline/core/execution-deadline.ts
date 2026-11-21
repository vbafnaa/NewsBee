import { AsyncLocalStorage } from "node:async_hooks";
import { ExecutionBlocked } from "./execution-errors";

const deadlines = new AsyncLocalStorage<number>();
export const SETTLEMENT_MS = 15_000;
export const MIN_DISPATCH_MS = 1_000;

/** A pre-dispatch yield, not an uncertain provider timeout or a credential failure. */
export class ExecutionDeadline extends ExecutionBlocked {
  constructor(readonly retryAt?: number) { super("Execution deadline reached; resume the recorded work in another job."); }
}

export function executionDeadline() { return deadlines.getStore(); }

export function withExecutionDeadline<T>(deadline: number, work: () => T): T {
  return deadlines.run(Math.min(deadline, deadlines.getStore() ?? Infinity), work);
}

export function executionTimeout(preferred = 300_000) {
  const deadline = deadlines.getStore();
  if (deadline === undefined) return preferred;
  const remaining = deadline - Date.now() - SETTLEMENT_MS;
  if (remaining < MIN_DISPATCH_MS) throw new ExecutionDeadline();
  return Math.min(preferred, remaining);
}

export async function executionWait(ms: number) {
  if (ms + MIN_DISPATCH_MS > executionTimeout(Infinity)) throw new ExecutionDeadline(Date.now() + ms);
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
  executionTimeout();
}
