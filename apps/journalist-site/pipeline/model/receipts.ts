import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { executionTimeout } from "../core/execution-deadline";
import { ExecutionBlocked } from "../core/execution-errors";
import { runContext } from "../core/run-options";
import { logger } from "../core/log";
import { LostLeaseError } from "../orchestration/jobs";
import { ModelOutcomeUncertain, UsageAccountingError, type JsonSchema, type ModelRuntime, type StructuredGeneration, type StructuredOptions } from "./runtime";

export const MODEL_RECEIPTS = "model_operation_receipts";
type Receipt = { _id: string; scope: string; run_id?: string; location_id?: string; status: "started" | "completed"; at: number; result?: StructuredGeneration; served_model?: string | null };

/** Run-scoped receipts are private recovery evidence, never a cross-run prompt cache. */
export function receiptRuntime(db: Db, runtime: ModelRuntime, scope: string, context: { runId: string; locationId: string } | null | undefined = runContext()): ModelRuntime {
  let servedModel = runtime.servedModel ?? runtime.model;
  return {
    get provider() { return runtime.provider; },
    get model() { return runtime.model; },
    get servedModel() { return servedModel; },
    health: () => runtime.health(),
    generate: prompt => runtime.generate(prompt),
    async generateStructured(prompt: string, schema: JsonSchema, options: StructuredOptions = {}) {
      const { timeoutMs: _timeout, ...policy } = options;
      const key = createHash("sha256").update(JSON.stringify([scope, runtime.provider, runtime.model, prompt, schema, policy])).digest("hex");
      const collection = db.collection<Receipt>(MODEL_RECEIPTS);
      const previous = await collection.findOne({ _id: key });
      if (previous?.status === "completed" && previous.result) {
        servedModel = previous.served_model ?? runtime.model;
        logger("model.receipts").info("model_operation_replayed", { run_id: context?.runId, location_id: context?.locationId, operation_id: key });
        return previous.result;
      }
      if (previous) throw new ModelOutcomeUncertain("An interrupted model operation has no durable result; reconcile its provider/accounting evidence before retrying.");
      executionTimeout();
      try { await collection.insertOne({ _id: key, scope, run_id: context?.runId, location_id: context?.locationId, status: "started", at: Date.now() / 1000 }); }
      catch (error) {
        if ((error as { code?: number }).code === 11000) throw new ExecutionBlocked("This model operation is already claimed; no duplicate request was sent.");
        throw error;
      }
      let result: StructuredGeneration;
      try {
        result = await runtime.generateStructured(prompt, schema, { ...options, timeoutMs: executionTimeout(options.timeoutMs) });
        servedModel = runtime.servedModel ?? runtime.model;
      } catch (error) {
        if (!(error instanceof UsageAccountingError) && !(error instanceof LostLeaseError)) {
          await collection.deleteOne({ _id: key, status: "started" });
        }
        throw error;
      }
      try {
        const saved = await collection.updateOne({ _id: key, status: "started" }, { $set: { status: "completed", result, served_model: servedModel } });
        if (saved.matchedCount !== 1) throw new Error("Model operation receipt lost");
      } catch {
        throw new ModelOutcomeUncertain("Model operation completed but its result could not be recorded; do not retry automatically.");
      }
      return result;
    },
  };
}
