import { listConfiguredSources } from "@/auth";
import { randomUUID } from "node:crypto";
import { pipelineRunFolder, readJson, saveJson } from "./drive";
import { gatherSource } from "./gather";
import { getCompletedSourceRunsById } from "./store";
import { normalizeForState } from "./states";
import { rankItems, writeEdition } from "./ai";
import type { ConfiguredSource } from "@/auth";
import type { PipelineItem, PipelineRun, PipelineStage, RawPipelineItem } from "./types";

function sourceForRun(sources: ConfiguredSource[], run: PipelineRun) {
  const source = run.source_config ?? sources.find((candidate) => candidate.id === run.source_id);
  if (!source) throw new Error(`Configured source ${run.source_id ?? "(missing)"} no longer exists`);
  return source;
}

async function sourceRunFolder(run: PipelineRun) {
  if (!run.source_id) throw new Error("Source run is missing its source identifier");
  return pipelineRunFolder(run);
}

async function editionRunFolder(run: PipelineRun) {
  return pipelineRunFolder(run);
}

export async function executeStage(run: PipelineRun, stage: PipelineStage) {
  if (run.kind === "source") {
    const source = run.source_config ?? sourceForRun(await listConfiguredSources(), run);
    const folder = await sourceRunFolder(run);
    if (stage === "gather") {
      const gathered = await gatherSource(source, run);
      return { driveFileId: await saveJson(folder, "gathered.json", gathered), nextStage: "normalize" as const };
    }
    if (stage === "normalize") {
      const gatheredId = run.stages.gather?.drive_file_id;
      if (!gatheredId) throw new Error("Gather stage artifact is missing");
      const gathered = await readJson<{ items: RawPipelineItem[] }>(gatheredId);
      if (!Array.isArray(gathered.items)) throw new Error("Gather stage artifact is malformed");
      const normalized = normalizeForState(
        source,
        run.location_id,
        run.location_name,
        gathered.items.filter((item) =>
          item.event_date >= run.period_start && item.event_date <= run.period_end),
      );
      const fileId = await saveJson(folder, "normalized.json", {
        source_id: source.id,
        location_id: run.location_id,
        period_start: run.period_start,
        period_end: run.period_end,
        normalized_at: new Date().toISOString(),
        items: normalized,
      });
      return { driveFileId: fileId, nextStage: null };
    }
    throw new Error(`Stage ${stage} is not valid for a source run`);
  }

  const folder = await editionRunFolder(run);
  if (stage === "rank") {
    const sourceRuns = await getCompletedSourceRunsById(
      run.channel_id,
      run.location_id,
      [...new Set(run.source_run_ids ?? [])],
    );
    const bySource = new Map<string, PipelineRun>();
    for (const sourceRun of sourceRuns) {
      if (sourceRun.source_id && !bySource.has(sourceRun.source_id)) bySource.set(sourceRun.source_id, sourceRun);
    }
    const all: PipelineItem[] = [];
    for (const sourceRun of bySource.values()) {
      const fileId = sourceRun.stages.normalize?.drive_file_id;
      if (!fileId) continue;
      const normalized = await readJson<{ items: PipelineItem[] }>(fileId);
      if (!Array.isArray(normalized.items)) throw new Error(`Normalized artifact for ${sourceRun.source_name} is malformed`);
      all.push(...normalized.items);
    }
    const unique = new Map<string, PipelineItem>();
    for (const item of all) {
      const previous = unique.get(item.id);
      if (!previous || item.local) unique.set(item.id, item);
    }
    const ranked = await rankItems([...unique.values()]);
    const fileId = await saveJson(folder, "ranked.json", {
      location_id: run.location_id,
      period_start: run.period_start,
      period_end: run.period_end,
      ranked_at: new Date().toISOString(),
      items: ranked,
    });
    return { driveFileId: fileId, nextStage: "write" as const };
  }

  if (stage === "write") {
    const rankedId = run.stages.rank?.drive_file_id;
    if (!rankedId) throw new Error("Rank stage artifact is missing");
    const ranked = await readJson<{ items: PipelineItem[] }>(rankedId);
    if (!Array.isArray(ranked.items)) throw new Error("Rank stage artifact is malformed");
    const editionId = randomUUID();
    const copy = await writeEdition(ranked.items, run.location_name, run.period_start, run.period_end);
    const items = ranked.items.map((item) => {
      const draft = copy.drafts.get(item.id);
      if (!draft) throw new Error(`AI writing output is missing story ${item.id}`);
      return {
        story_id: item.id,
        headline: draft.headline.trim(),
        blurb: draft.blurb.trim(),
        when_where: [item.event_date, item.venue].filter(Boolean).join(" · "),
        event_date: item.event_date,
        source_url: item.source_url,
        rank: item.rank,
        kind: item.kind,
        source_name: item.source_name,
        section: item.section ?? null,
        local: item.local,
      };
    });
    const edition = {
      id: editionId,
      location_id: run.location_id,
      location_name: run.location_name,
      window_start: run.period_start,
      window_end: run.period_end,
      published_at: 0,
      headline: copy.headline,
      intro: copy.intro,
      items,
      coverage: [...new Set(ranked.items.map((item) => item.source_name))],
      corrections: [],
    };
    const fileId = await saveJson(folder, "edition-draft.json", edition);
    return { driveFileId: fileId, nextStage: "publish" as const };
  }

  if (stage === "publish") {
    const draftId = run.stages.write?.drive_file_id;
    if (!draftId) throw new Error("Write stage artifact is missing");
    const edition = await readJson<Record<string, unknown>>(draftId);
    const published = { ...edition, published_at: Date.now() / 1000 };
    const fileId = await saveJson(run.drive_folder_id, `${run.location_id}-${run._id}.json`, published);
    return { driveFileId: fileId, nextStage: null };
  }
  throw new Error(`Stage ${stage} is not valid for an edition run`);
}
