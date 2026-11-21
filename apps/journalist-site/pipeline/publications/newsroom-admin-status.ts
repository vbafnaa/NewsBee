/**
 * Newsroom admin's service cards (frame 13). Each card reads the same records as an Operations page, so a status is
 * never invented: "active" and "attention" come from configuration or recorded state, and "unchecked" means there is
 * nothing recorded to judge. Nothing here makes a live provider call or exposes a secret, so anyone in the newsroom
 * may see it.
 *
 * Card                      Source                                                     Operations page
 * Collector service         scheduler heartbeat (schedulerState)                       /health
 * Article generation        managed model configuration (safeManagedHealthSettings)    /health?view=usage
 * Video renderer            managed Desktop Video key, recent story-video failures     /health?view=video
 * Publishing service        failed pipeline jobs                                       /health
 * Source snapshots          storage mode and pipeline folder (drive diagnostics)       /drive-diagnostics
 * Archive backups           site maintenance state                                     /site-backup
 * Import source map         site maintenance state (writes open)                       /site-backup
 * Export publication data   site maintenance state                                     /site-backup
 * Collection API            managed search provider keys                               /account
 * Generation provider       managed model configuration                                /account
 * Video production API      managed fal.ai / Desktop Video keys                        /account
 * Reader application        NEWSBEE_READER_SITE_URL                                    /account
 */
import type { Db } from "mongodb";
import { safeManagedHealthSettings } from "../accounts/execution";
import { loadSettings } from "../core/config";
import { schedulerState } from "../orchestration/scheduler";
import { COLLECTIONS } from "../storage/mongo";
import { maintenanceState } from "../../../../shared/restore-maintenance";

export type ServiceState = "active" | "attention" | "unchecked";
export type ServiceCard = { name: string; state: ServiceState; detail: string; href: string };
export type ServiceSection = {
  id: "system" | "storage" | "transfer" | "environment";
  eyebrow?: string; title: string; description: string; docs: string | null; ownerOnly?: boolean; cards: ServiceCard[];
};

const DOCS = "https://github.com/g2minhle/Newsbee/blob/main/";
const DAY = 24 * 60 * 60;

function minutesAgo(seconds: number) {
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

export async function newsroomServiceStatus(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<ServiceSection[]> {
  const settings = loadSettings();
  const managed = safeManagedHealthSettings({ runTimeoutSeconds: null }, settings);
  const flags = managed.integrationFlags ?? {};
  const now = Date.now() / 1000;
  const [scheduler, failedJobs, failedVideos, maintenance] = await Promise.all([
    schedulerState(db).catch(() => null),
    db.collection(COLLECTIONS.jobs).countDocuments({ status: "failed" }).catch(() => null),
    db.collection(COLLECTIONS.videoJobs).countDocuments({ status: { $in: ["failed", "upload_failed"] }, created_at: { $gte: (now - 7 * DAY) * 1000 } }).catch(() => null),
    maintenanceState(db).catch(() => null),
  ]);

  const collector: ServiceCard = !scheduler || scheduler.last_tick_at === null
    ? { name: "Collector service", state: "unchecked", detail: "No scheduler run recorded yet", href: "/health" }
    : scheduler.status === "ok" && !scheduler.issues.length
      ? { name: "Collector service", state: "active", detail: `Scheduler ran ${minutesAgo(scheduler.seconds_since_tick ?? 0)}`, href: "/health" }
      : { name: "Collector service", state: "attention", detail: scheduler.issues.length ? `${scheduler.issues.length} scheduler issue${scheduler.issues.length === 1 ? "" : "s"}` : `Last scheduler run ${minutesAgo(scheduler.seconds_since_tick ?? 0)}`, href: "/health" };
  const modelReady = managed.modelProviders.some((provider) => provider.configured);
  const videoReady = Boolean(flags.desktopVideo);
  const searchReady = ["tavily", "serpapi", "searchapi", "brightdata", "exa", "scrapingbee", "jina"].some((name) => flags[name]);
  const readerUrl = env.NEWSBEE_READER_SITE_URL?.trim();
  let readerHost: string | null = null;
  try { readerHost = readerUrl ? new URL(readerUrl).host : null; } catch { readerHost = null; }
  const cloud = settings.mode === "cloud";
  const storage: ServiceCard = !cloud
    ? { name: "Source snapshots", state: "active", detail: "Local storage on this machine", href: "/drive-diagnostics" }
    : settings.pipelineDriveFolderId
      ? { name: "Source snapshots", state: "active", detail: "Google Drive folder configured", href: "/drive-diagnostics" }
      : { name: "Source snapshots", state: "attention", detail: "No pipeline Drive folder configured", href: "/drive-diagnostics" };
  const open = maintenance?.phase === "open";
  const maintenanceDetail = !maintenance ? "Maintenance state unavailable" : open ? "Site open for writes" : `Site ${maintenance.phase}`;
  const maintenanceState_: ServiceState = !maintenance ? "unchecked" : open ? "active" : "attention";

  return [
    { id: "system", eyebrow: "Newsbee operations", title: "System", description: "Monitor Newsbee services and pipeline operations.",
      docs: `${DOCS}docs/operations-inventory.md`, cards: [
        collector,
        { name: "Article generation", state: modelReady ? "active" : "attention", detail: modelReady ? "Managed model configured" : "No managed model configured", href: "/health?view=usage" },
        { name: "Video renderer", state: !videoReady ? "attention" : failedVideos ? "attention" : "active",
          detail: !videoReady ? "Desktop Video isn't configured" : failedVideos ? `${failedVideos} failed video${failedVideos === 1 ? "" : "s"} this week` : "Desktop Video configured", href: "/health?view=video" },
        failedJobs === null
          ? { name: "Publishing service", state: "unchecked", detail: "Job queue unavailable", href: "/health" }
          : { name: "Publishing service", state: failedJobs ? "attention" : "active", detail: failedJobs ? `${failedJobs} failed job${failedJobs === 1 ? "" : "s"} in the queue` : "No failed jobs", href: "/health" },
      ] },
    { id: "storage", title: "Storage", description: "Manage media, article, and source data.", docs: `${DOCS}docs/collected-item-retention.md`, cards: [
      storage,
      { name: "Archive backups", state: maintenanceState_, detail: maintenanceDetail, href: "/site-backup" },
    ] },
    { id: "transfer", title: "Import & export", description: "Move location data and configuration securely.", ownerOnly: true,
      docs: `${DOCS}knowledge/development-and-deployment.md`, cards: [
        { name: "Import source map", state: maintenanceState_, detail: maintenanceDetail, href: "/site-backup" },
        { name: "Export publication data", state: maintenanceState_, detail: maintenanceDetail, href: "/site-backup" },
      ] },
    { id: "environment", eyebrow: "Newsbee operations", title: "Environment & API", description: "Configure integrations, secrets, and pipeline endpoints.",
      docs: `${DOCS}docs/deployment.md`, cards: [
        { name: "Collection API", state: searchReady ? "active" : "attention", detail: searchReady ? "Managed search configured" : "No managed search provider", href: "/account" },
        { name: "Generation provider", state: modelReady ? "active" : "attention", detail: modelReady ? "Managed model configured" : "No managed model configured", href: "/account" },
        { name: "Video production API", state: flags.fal || videoReady ? "active" : "attention",
          detail: flags.fal || videoReady ? [videoReady && "Desktop Video", flags.fal && "fal.ai"].filter(Boolean).join(" and ") + " configured" : "No managed video provider", href: "/account" },
        readerHost
          ? { name: "Reader application", state: "active", detail: `Reader site at ${readerHost}`, href: "/account" }
          : { name: "Reader application", state: "unchecked", detail: "No reader URL configured", href: "/account" },
      ] },
  ];
}
