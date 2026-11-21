"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import RetainedDisclosure from "../components/retained-disclosure";
import { newsroomTaskForHash, newsroomTaskForPath, type NewsroomTask } from "./newsroom-routes";

export { newsroomTaskForHash, type NewsroomTask } from "./newsroom-routes";

export function focusNewsroomTarget(target: HTMLElement) {
  if (target.tagName === "DETAILS") (target as HTMLDetailsElement).open = true;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
  }
  target.scrollIntoView?.({ block: "start" });
  const heading = target.hasAttribute("data-editorial-correction")
    ? target.querySelector<HTMLElement>('[data-required-field="true"]:not(:disabled)')
      ?? target.querySelector<HTMLElement>('input[type="url"]:not(:disabled)')
      ?? target.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)")
      ?? target.closest("details")?.querySelector<HTMLElement>("summary") ?? target
    : target.matches(":disabled") ? target.closest("details")?.querySelector<HTMLElement>("summary")
      ?? target.closest<HTMLElement>("article") ?? target
    : target.matches("[tabindex], input, textarea, select, button, a[href], h2, h3, summary") ? target
      : target.querySelector<HTMLElement>("summary, h2, h3") ?? target;
  if (!heading.matches("input, textarea, select, button, a[href], summary")) heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

type TaskState = { task: NewsroomTask; workspace: string; hash: string; path: string };
const TaskContext = createContext<TaskState>({ task: "overview", workspace: "", hash: "", path: "" });

function taskFor(workspace: string, initialTask: NewsroomTask) {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  const fromPath = newsroomTaskForPath(path, workspace);
  return fromPath ?? (path === workspace ? newsroomTaskForHash(window.location.hash) : initialTask);
}

/**
 * Tracks which journalist view is open. The path picks the view (`/editions`, `/settings`, …);
 * on the newsroom's own path an older hash link still picks it, so bookmarks keep working
 * until the Overview redirects them.
 */
export function NewsroomTasks({ workspace, initialTask = "overview", children }: {
  workspace: string; initialTask?: NewsroomTask; children: ReactNode;
}) {
  const pathname = usePathname();
  const [state, setState] = useState<TaskState>(() => ({
    task: (pathname && newsroomTaskForPath(pathname.replace(/\/$/, ""), workspace)) || initialTask,
    workspace, hash: "", path: pathname ?? workspace,
  }));
  useEffect(() => {
    const sync = () => setState({
      task: taskFor(workspace, initialTask), workspace, hash: window.location.hash, path: window.location.pathname,
    });
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, [workspace, initialTask, pathname]);
  useEffect(() => {
    if (!state.hash) return;
    let observer: MutationObserver | undefined;
    const focusTarget = () => {
      const exact = document.getElementById(state.hash.slice(1));
      const target = exact
        ?? document.querySelector<HTMLElement>(`[data-newsroom-task="${state.task}"]`);
      if (!target || target.closest("[hidden], [inert]")) return false;
      focusNewsroomTarget(target);
      return Boolean(exact);
    };
    const timer = window.requestAnimationFrame(() => {
      if (focusTarget()) return;
      // The exact selected editor may still be loading when a deep link opens.
      observer = new window.MutationObserver(() => {
        const target = document.getElementById(state.hash.slice(1));
        if (target && !target.closest("[hidden], [inert]") && focusTarget()) observer?.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "inert"] });
    });
    return () => { window.cancelAnimationFrame(timer); observer?.disconnect(); };
  }, [state]);
  return <TaskContext.Provider value={state}>{children}</TaskContext.Provider>;
}

export const useNewsroomTask = () => useContext(TaskContext).task;
export const useNewsroomWorkspace = () => useContext(TaskContext).workspace;
export const useNewsroomPath = () => useContext(TaskContext).path;

export function NewsroomDestinations({ children }: { children: ReactNode }) {
  const { hash } = useContext(TaskContext);
  return <RetainedDisclosure title="Newsroom coverage" className="panel publication-settings-disclosure"
    id="audience" revealKey={hash === "#delivery" || hash === "#audience" ? hash : undefined}>
    <section id="delivery" aria-label="Newsroom coverage">{children}</section>
  </RetainedDisclosure>;
}

/** Keeps the chooser's other query values when a newsroom is picked from `/newsroom`. */
export function NewsroomChooserFields() {
  const searchParams = useSearchParams();
  const query = [...searchParams.entries()];
  return <>
    {query.filter(([key]) => key !== "publicationId")
      .map(([key, value], index) => <input key={index} type="hidden" name={key} value={value} />)}
  </>;
}

/**
 * One view of the newsroom. Views stay mounted once visited, so unsaved editor and settings
 * input survives moving between Editions, Settings and the editor.
 */
export function NewsroomTaskPanel({ task, children, lazy = false }: { task: NewsroomTask | NewsroomTask[]; children: ReactNode; lazy?: boolean }) {
  const current = useNewsroomTask();
  const tasks = Array.isArray(task) ? task : [task];
  const open = tasks.includes(current);
  const [visited, setVisited] = useState(open);
  useEffect(() => { if (open) setVisited(true); }, [open]);
  if (lazy && !visited && !open) return null;
  return <div className="newsroom-task-panel" data-newsroom-task={tasks[0]}
    hidden={!open} inert={!open} aria-hidden={!open}>
    {children}
  </div>;
}
