import type { Db } from "mongodb";
import { readRestoreEvidence } from "../../../../shared/restore-maintenance";
import { safeError } from "../core/redaction";

const ACTIONS = [
  "maintenance_closed", "reopen_requested", "restore_started",
  "restore_completed_maintenance_closed", "restore_failed_maintenance_closed",
] as const;

function milliseconds(value: unknown): number | null {
  const parsed = value instanceof Date ? value.getTime()
    : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const identifier = (value: unknown) => typeof value === "string" ? value.slice(0, 200) : null;

/** Project the shared restore reader's bounded evidence; the caller must authorize the workspace owner. */
export async function boundedRestoreEvidence(db: Db) {
  const rows = await readRestoreEvidence(db);
  return rows.filter((row) => ACTIONS.includes(row.action)).slice(0, 20).map((row) => ({
    action: row.action as typeof ACTIONS[number], atMilliseconds: milliseconds(row.at),
    ...(row.owner && typeof row.owner === "object" ? { owner: {
      id: identifier(row.owner.id), email: identifier(row.owner.email),
      role: ["owner", "admin", "editor"].includes(row.owner.role) ? row.owner.role as string : null,
    } } : {}),
    epoch: count(row.epoch), restoreId: identifier(row.restoreId),
    archiveHash: typeof row.archiveHash === "string" && /^[a-f0-9]{64}$/i.test(row.archiveHash) ? row.archiveHash : null,
    governanceRollback: typeof row.governanceRollback === "boolean" ? row.governanceRollback : null,
    sourceCreatedAt: milliseconds(row.sourceCreatedAt) === null ? null : new Date(milliseconds(row.sourceCreatedAt)!).toISOString(),
    collections: Array.isArray(row.collections)
      ? row.collections.filter((name): name is string => typeof name === "string" && name.length <= 200).slice(0, 1000) : [],
    ...(row.result && typeof row.result === "object" ? { result: {
      collections: count(row.result.collections), documents: count(row.result.documents), artifactFiles: count(row.result.artifactFiles),
    } } : {}),
    ...(typeof row.detail === "string" ? { detail: safeError(row.detail) } : {}),
  }));
}
