"use client";

import { useNewsroomTask } from "../newsroom-tasks";
import type { NewsroomTask } from "../newsroom-routes";

/** Views the layout's edition workspace or Settings draws itself; they switch at once, so no skeleton. */
const WORKSPACE_VIEWS = new Set<NewsroomTask>(["overview", "new-edition", "editions", "activity", "writing", "settings"]);

/** A quiet page outline (title, a row of cards, a table) while a server-rendered view loads. */
export function NewsroomPageSkeleton() {
  const task = useNewsroomTask();
  if (WORKSPACE_VIEWS.has(task)) return null;
  return <div className="jw-skeleton" aria-hidden="true">
    <span className="jw-skeleton-line is-eyebrow" />
    <span className="jw-skeleton-line is-title" />
    <span className="jw-skeleton-line is-text" />
    <div className="jw-skeleton-cards"><span /><span /><span /></div>
    <span className="jw-skeleton-block" />
  </div>;
}
