import { useId } from "react";
import type { JobActivity } from "../run-progress";

export default function JobProgress({ label, activity, refreshError }: {
  label: string;
  activity: JobActivity;
  refreshError?: string;
}) {
  const statusId = useId();
  const state = refreshError ? "unknown" : activity.state;
  const text = refreshError ? `Status refresh failed. Last confirmed: ${activity.text}` : activity.text;
  return <div className="job-progress" data-state={state}>
    <span id={statusId} className="job-progress-status" role="status">{text}</span>
    <div className="job-progress-track" role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={state === "completed" ? 100 : undefined}
      aria-valuetext={text} aria-describedby={statusId}>
      <span className="job-progress-fill" />
    </div>
  </div>;
}
