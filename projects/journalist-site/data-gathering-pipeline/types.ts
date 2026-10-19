import type { ConfiguredSource } from "@/auth";

export const sourceStages = ["gather", "normalize"] as const;
export const editionStages = ["rank", "write", "publish"] as const;
export type SourceStage = (typeof sourceStages)[number];
export type EditionStage = (typeof editionStages)[number];
export type PipelineStage = SourceStage | EditionStage;
export type StageStatus = "pending" | "running" | "completed" | "failed";

export type StageRecord = {
  status: StageStatus;
  started_at?: Date;
  completed_at?: Date;
  error?: string;
  drive_file_id?: string;
};

export type PipelineRun = {
  _id: string;
  channel_id: string;
  drive_folder_id: string;
  kind: "source" | "edition";
  source_id?: string;
  source_name?: string;
  source_kind?: ConfiguredSource["kind"];
  source_config?: ConfiguredSource;
  region?: string;
  location_id: string;
  location_name: string;
  period_start: string;
  period_end: string;
  status: "ready" | "running" | "failed" | "completed";
  stage_started_at?: Date;
  current_stage: PipelineStage | null;
  stages: Partial<Record<PipelineStage, StageRecord>>;
  source_run_ids?: string[];
  created_at: Date;
  updated_at: Date;
};

export type PipelineItem = {
  id: string;
  title: string;
  description: string;
  event_date: string;
  source_url: string | null;
  venue: string | null;
  kind: string;
  source_id: string;
  source_name: string;
  section?: string;
  local: boolean;
  rank?: number;
  score?: number;
};

export type RawPipelineItem = Omit<PipelineItem, "local" | "section"> & {
  published_at?: string;
};
