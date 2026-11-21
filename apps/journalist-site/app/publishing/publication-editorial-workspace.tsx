"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { adminApi, ApiError } from "@/lib/admin-client";
import type { PublicationReaderMetadata } from "../../../../shared/publication-preview";
import Link from "next/link";
import { focusNewsroomTarget, type NewsroomTask } from "../newsroom/newsroom-tasks";
import { newsroomHref, newsroomReleaseHref } from "../newsroom/newsroom-routes";
import { Icon, StatusPill, editionStatusKey, formatEditionWindow } from "../newsroom/newsroom-ui";
import { storySources } from "../../../../shared/source-attribution";
import StoryEvidence from "@/app/components/story-evidence";
import { editionEssentials } from "./edition-guidance";
import type {
  PublicationDraftImage,
  PublicationInterviewNote,
  PublicationDraftPatch,
  PublicationStoryEvidence,
} from "@/pipeline/publications/editorial";
import type {
  PublicationDraft,
  PublicationEditorialSource,
  PublicationPresentationStory,
} from "@/pipeline/publications/generation";
import {
  generatedPublicationStory,
  includedPublicationStories,
  publicationHoldIsReviewable,
  publicationStoryIncluded,
  publicationStorySafetyError,
} from "@/pipeline/publications/inclusion";

type Workspace = {
  draft: PublicationDraft;
  evidence: PublicationStoryEvidence[];
  images: PublicationDraftImage[];
} & PublicationReaderMetadata;

type ReleaseSummary = {
  draftId: string;
  releaseId: string;
  title: string;
  windowStart: string;
  windowEnd: string;
  publishedAt: number;
  contentHash: string;
  locations: Array<{ id: string; name: string }>;
  correction: { supersedes_release_id: string; reason: string } | null;
  action: { action: "withdraw" | "restore"; reason: string; at: number } | null;
  sourceChanges: Array<{
    action: "source_withdrawal" | "source_restore";
    reason: string;
    at: number;
    source: { location_id: string; story_id: string };
  }>;
  correctionRequired: boolean;
};

type SaveState =
  | { state: "saved" }
  | { state: "unsaved" }
  | { state: "saving" }
  | { state: "conflict"; detail: string; retry: () => void }
  | { state: "error"; detail: string; retry?: () => void };

type Scheduled = {
  timer: ReturnType<typeof setTimeout>;
  operation: PublicationDraftPatch;
};

type PendingSave = {
  operation: PublicationDraftPatch;
  syncPresentation: boolean;
};

function originalStoryOperation(story: PublicationPresentationStory): PublicationDraftPatch {
  return {
    type: "add_original_story", storyId: story.id,
    story: { headline: story.headline, body: story.body, byline: story.byline, sectionId: story.section_id,
      locationTags: story.location_tags, sourceMetadata: story.source_metadata },
  };
}

function sameSaveTarget(left: PublicationDraftPatch, right: PublicationDraftPatch) {
  return left.type === right.type
    && (left.type === "story" || left.type === "add_original_story" || left.type === "remove_original_story" || left.type === "inclusion" ? "storyId" in right && left.storyId === right.storyId
      : left.type === "section" ? "sectionId" in right && left.sectionId === right.sectionId : true);
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function rejectedWorkflowMessage(operation: PublicationDraftPatch, error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  if (operation.type === "ready_for_approval") {
    return `Not marked ready for approval. ${error.message} Correct the draft and try again.`;
  }
  if (operation.type === "reopen_for_editing") return `Draft was not reopened. ${error.message}`;
  return null;
}

function move<T>(values: T[], index: number, direction: -1 | 1) {
  const next = index + direction;
  if (next < 0 || next >= values.length) return values;
  const copy = [...values];
  [copy[index], copy[next]] = [copy[next], copy[index]];
  return copy;
}

export function rebasePendingDraft(latest: PublicationDraft, pending: PendingSave[]) {
  let presentation = structuredClone(latest.presentation);
  for (const { operation } of pending) {
    if (operation.type === "draft") {
      presentation = {
        ...presentation,
        ...("headline" in operation && typeof operation.headline === "string" ? { headline: operation.headline } : {}),
        ...("intro" in operation && typeof operation.intro === "string" ? { intro: operation.intro } : {}),
      };
    } else if (operation.type === "bee_game") {
      presentation.save_the_bee = operation.game;
    } else if (operation.type === "section" && typeof operation.sectionId === "string" && typeof operation.title === "string") {
      const title = operation.title;
      presentation.sections = presentation.sections.map((section) =>
        section.id === operation.sectionId ? { ...section, title } : section);
    } else if (operation.type === "section_order" && Array.isArray(operation.sectionIds)) {
      presentation.section_order = operation.sectionIds.filter((id): id is string => typeof id === "string");
    } else if (operation.type === "story_order" && Array.isArray(operation.storyIds)) {
      presentation.story_order = operation.storyIds.filter((id): id is string => typeof id === "string");
    } else if (operation.type === "remove_original_story" && typeof operation.storyId === "string") {
      presentation.stories = presentation.stories.filter((story) => story.id !== operation.storyId);
      presentation.story_order = presentation.story_order.filter((storyId) => storyId !== operation.storyId);
    } else if (operation.type === "add_original_story" && typeof operation.storyId === "string"
      && operation.story && typeof operation.story === "object" && !Array.isArray(operation.story)) {
      if (presentation.stories.some((story) => story.id === operation.storyId)) continue;
      const value = operation.story as Record<string, unknown>;
      const story: PublicationPresentationStory = {
        id: operation.storyId, origin: "original", generated_story_id: null, included: true, image_id: null,
        headline: typeof value.headline === "string" ? value.headline : "",
        body: typeof value.body === "string" ? value.body : "",
        byline: typeof value.byline === "string" ? value.byline : "",
        section_id: typeof value.sectionId === "string" ? value.sectionId : "",
        location_tags: Array.isArray(value.locationTags) ? value.locationTags.filter((id): id is string => typeof id === "string") : [],
        source_metadata: Array.isArray(value.sourceMetadata) ? value.sourceMetadata as PublicationEditorialSource[] : [],
      };
      presentation.stories.push(story);
      presentation.story_order.push(story.id);
    } else if (operation.type === "story" && typeof operation.storyId === "string") {
      presentation.stories = presentation.stories.map((story) => {
        if (story.id !== operation.storyId) return story;
        return {
          ...story,
          ...("headline" in operation && typeof operation.headline === "string" ? { headline: operation.headline } : {}),
          ...("body" in operation && typeof operation.body === "string" ? { body: operation.body } : {}),
          ...("byline" in operation && typeof operation.byline === "string" ? { byline: operation.byline } : {}),
          ...("sectionId" in operation && typeof operation.sectionId === "string" ? { section_id: operation.sectionId } : {}),
          ...("locationTags" in operation && Array.isArray(operation.locationTags)
            ? { location_tags: operation.locationTags.filter((id): id is string => typeof id === "string") }
            : {}),
          ...("sourceMetadata" in operation && Array.isArray(operation.sourceMetadata)
            ? { source_metadata: operation.sourceMetadata as PublicationEditorialSource[] }
            : {}),
          ...("imageId" in operation && (operation.imageId === null || typeof operation.imageId === "string")
            ? { image_id: operation.imageId }
            : {}),
        };
      });
    }
  }
  return { ...latest, presentation };
}

export default function PublicationEditorialWorkspace({
  publicationId,
  draftId,
  beforeDraftChange,
  onSelectDraft,
  task,
  onDraftChange,
  canWrite,
}: {
  publicationId: string;
  draftId: string;
  beforeDraftChange?: MutableRefObject<(() => Promise<boolean>) | null>;
  onSelectDraft?: (draftId: string) => Promise<void>;
  task?: NewsroomTask | "reporting";
  onDraftChange?: (draft: PublicationDraft) => void;
  canWrite: boolean;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const currentStories = useRef<PublicationPresentationStory[]>([]);
  currentStories.current = workspace?.draft.presentation.stories ?? [];
  const [loadError, setLoadError] = useState("");
  const [readerRetryError, setReaderRetryError] = useState("");
  const [readerRetryBusy, setReaderRetryBusy] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ state: "saved" });
  const [releaseBusy, setReleaseBusy] = useState("");
  const [structuralBusy, setStructuralBusy] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  const [releaseNotice, setReleaseNotice] = useState("");
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [webPreview, setWebPreview] = useState<{ url: string; revision: number } | null>(null);
  const revision = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const scheduled = useRef(new Map<string, Scheduled>());
  const blocked = useRef(false);
  const pendingRetries = useRef<PendingSave[]>([]);
  const queuedSaves = useRef<PendingSave[]>([]);
  const editor = useRef<HTMLElement | null>(null);
  const dirtyForms = useRef(new Set<HTMLFormElement>());
  const actionBusy = useRef(false);
  const auxiliaryFailure = useRef(false);
  const auxiliaryStates = useRef(new Map<string, SaveState>());
  const saveFailure = useRef<SaveState | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const restoreFocusContext = useRef<{ story?: string; section?: string }>({});
  const [positionNotice, setPositionNotice] = useState("");
  const [activeStoryId, setActiveStoryId] = useState<string | null>(null);
  // Editor chrome (frames 10-12): which block the side panel edits, its tab, the canvas width and preview mode.
  const [panelTarget, setPanelTarget] = useState<"story" | "edition">("story");
  const [panelTab, setPanelTab] = useState<"content" | "layout">("content");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [previewMode, setPreviewMode] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const extrasRef = useRef<HTMLDetailsElement | null>(null);
  const [correctiveTarget, setCorrectiveTarget] = useState<{ id: string } | null>(null);
  const newStory = useRef<{ story: PublicationPresentationStory; submitted: boolean } | null>(null);
  const creationRejected = useRef(false);
  const focusStory = useRef(false);
  const writeAllowed = useRef(canWrite);
  writeAllowed.current = canWrite;
  const loadRequest = useRef<AbortController | null>(null);
  const path = `publications/${encodeURIComponent(publicationId)}/drafts/${encodeURIComponent(draftId)}`;
  const releasesPath = `publications/${encodeURIComponent(publicationId)}/releases`;
  const taskHidden = task !== undefined && task !== "writing" && task !== "editions" && task !== "reporting";
  const editionsHidden = taskHidden;
  const reportingHidden = taskHidden;

  useEffect(() => {
    if (!focusStory.current || taskHidden) return;
    focusStory.current = false;
    editor.current?.querySelector<HTMLInputElement>('.editorial-story:not([hidden]) input[data-story-headline]')?.focus();
  }, [activeStoryId, taskHidden]);

  const revealAnchor = useCallback((hash: string) => {
      if (hash === "#edition-headline" || hash === "#edition-intro") {
        setPreviewMode(false);
        setPanelTarget("edition");
        setCorrectiveTarget({ id: hash.slice(1) });
      }
      const correction = /^#edition-(sources|section|locations|byline|image)-(.+)$/.exec(hash);
      if (hash.startsWith("#edition-story-") || correction) {
        const storyId = correction?.[2] ?? hash.slice("#edition-story-".length);
        const story = currentStories.current.find((candidate) => encodeURIComponent(candidate.id) === storyId);
        if (story) {
          setPreviewMode(false);
          setPanelTarget("story");
          setPanelTab(correction && ["section", "locations"].includes(correction[1]) ? "layout" : "content");
          setActiveStoryId(story.id);
          if (correction) setCorrectiveTarget({ id: hash.slice(1) });
        }
      }
  }, []);

  useEffect(() => {
    const reveal = () => revealAnchor(window.location?.hash ?? "");
    reveal();
    window.addEventListener("hashchange", reveal);
    window.addEventListener("popstate", reveal);
    return () => { window.removeEventListener("hashchange", reveal); window.removeEventListener("popstate", reveal); };
  }, [workspace?.draft._id, revealAnchor]);

  useEffect(() => {
    if (!correctiveTarget || taskHidden) return;
    const target = document.getElementById(correctiveTarget.id);
    if (target && !target.closest("[hidden], [inert]")) focusNewsroomTarget(target);
  }, [correctiveTarget, activeStoryId, taskHidden]);

  useEffect(() => {
    if (workspace) onDraftChange?.(workspace.draft);
  }, [workspace?.draft, onDraftChange]);

  useEffect(() => {
    if (structuralBusy || releaseBusy || taskHidden) return;
    let target = restoreFocus.current;
    restoreFocus.current = null;
    if (target && (!target.isConnected || target.matches(":disabled"))) {
      const { story, section } = restoreFocusContext.current;
      target = [...editor.current!.querySelectorAll<HTMLElement>("[data-story-id]")]
        .find((element) => element.dataset.storyId === story)
        ?? [...editor.current!.querySelectorAll<HTMLElement>("[data-section-id]")]
          .find((element) => element.dataset.sectionId === section)?.querySelector<HTMLElement>(".editorial-section-heading")
        ?? editor.current?.querySelector<HTMLElement>("#editorial-workspace-title") ?? null;
    }
    if (target?.isConnected && !target.matches(":disabled") && !target.closest("[hidden]")) target.focus();
  }, [structuralBusy, releaseBusy, taskHidden]);

  const refreshSaveState = useCallback(() => {
    const auxiliary = [...auxiliaryStates.current.values()];
    const failure = saveFailure.current ?? auxiliary.find((state) => state.state === "error" || state.state === "conflict");
    setSaveState(failure ?? (scheduled.current.size || queuedSaves.current.length || pendingRetries.current.length
      || auxiliary.some((state) => state.state === "saving") || blocked.current
      ? { state: "saving" } : auxiliary.find((state) => state.state === "unsaved")
        ?? ([...dirtyForms.current].some((form) => form.isConnected) ? { state: "unsaved" } : { state: "saved" })));
  }, []);

  const reportAuxiliaryState = useCallback((key: string, state: SaveState | null) => {
    if (state) auxiliaryStates.current.set(key, state);
    else auxiliaryStates.current.delete(key);
    auxiliaryFailure.current = [...auxiliaryStates.current.values()].some((value) => value.state === "error" || value.state === "conflict");
    refreshSaveState();
  }, [refreshSaveState]);

  const reportBeeFormDirty = useCallback((dirty: boolean) => {
    reportAuxiliaryState("bee-form", dirty ? { state: "unsaved" } : null);
  }, [reportAuxiliaryState]);

  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const controller = new AbortController();
    loadRequest.current = controller;
    try {
      const current = await adminApi<Workspace>(path, { signal: controller.signal });
      if (controller.signal.aborted) return current;
      setWorkspace(current);
      revision.current = current.draft.revision;
      setLoadError("");
      refreshSaveState();
      return current;
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(errorText(error));
      throw error;
    }
  }, [path, refreshSaveState]);

  useEffect(() => {
    void load().catch(() => undefined);
    return () => loadRequest.current?.abort();
  }, [load]);
  async function retryReaderLinks() {
    setReaderRetryBusy(true);
    setReaderRetryError("");
    try {
      const metadata = await adminApi<Workspace>(path);
      // Refresh only optional links: never replace edits, save failures, or the selected revision.
      setWorkspace((current) => current && {
        ...current, readerBaseUrl: metadata.readerBaseUrl, readerLink: metadata.readerLink,
      });
    } catch (error) {
      setReaderRetryError(errorText(error));
    } finally {
      setReaderRetryBusy(false);
    }
  }
  const loadReleases = useCallback(async () => {
    const result = await adminApi<{ releases: ReleaseSummary[] }>(releasesPath);
    setReleases(result.releases);
  }, [releasesPath]);
  useEffect(() => { void loadReleases().catch((error) => setReleaseError(errorText(error))); }, [loadReleases]);
  useEffect(() => () => {
    for (const pending of scheduled.current.values()) clearTimeout(pending.timer);
  }, []);

  const applyServerDraft = useCallback((draft: PublicationDraft, syncPresentation: boolean) => {
    revision.current = draft.revision;
    const rebased = syncPresentation ? rebasePendingDraft(draft, [
      ...pendingRetries.current,
      ...queuedSaves.current,
      ...[...scheduled.current.values()].map(({ operation }) => ({ operation, syncPresentation: false })),
    ]).presentation : null;
    if (rebased && newStory.current && !rebased.stories.some((story) => story.id === newStory.current!.story.id)) {
      rebased.stories.push(newStory.current.story);
      rebased.story_order.push(newStory.current.story.id);
    }
    setWorkspace((current) => current && {
      ...current,
      draft: {
        ...current.draft,
        revision: draft.revision,
        editorial_status: draft.editorial_status,
        updated_at: draft.updated_at,
        updated_by: draft.updated_by,
        ready_for_approval_at: draft.ready_for_approval_at,
        ready_for_approval_by: draft.ready_for_approval_by,
        ...(rebased ? { presentation: rebased } : {}),
      },
    });
  }, []);

  const requestSave = useCallback(async (operation: PublicationDraftPatch, syncPresentation: boolean) => {
    if (!writeAllowed.current) throw new Error("Write access is unavailable or support has expired. Your attempted edits are preserved.");
    if (operation.type === "add_original_story") creationRejected.current = false;
    let result: { draft: PublicationDraft };
    try {
      result = await adminApi<{ draft: PublicationDraft }>(path, {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: revision.current, operation }),
      });
    } catch (error) {
      if (operation.type === "add_original_story" && error instanceof ApiError && error.status === 422) creationRejected.current = true;
      throw error;
    }
    if (operation.type === "add_original_story") newStory.current = null;
    applyServerDraft(result.draft, syncPresentation || operation.type === "add_original_story");
  }, [applyServerDraft, path]);

  const remember = useCallback((pending: PendingSave) => {
    const operation = pending.operation;
    const previous = pendingRetries.current.findIndex((candidate) => sameSaveTarget(candidate.operation, operation));
    if (previous < 0) pendingRetries.current.push(pending);
    else pendingRetries.current[previous] = {
      operation: { ...pendingRetries.current[previous].operation, ...operation } as PublicationDraftPatch,
      syncPresentation: pending.syncPresentation || pendingRetries.current[previous].syncPresentation,
    };
  }, []);

  const retryPending = useCallback(() => {
    for (const scheduledSave of scheduled.current.values()) {
      clearTimeout(scheduledSave.timer);
      remember({ operation: scheduledSave.operation, syncPresentation: false });
    }
    scheduled.current.clear();
    queue.current = queue.current.then(async () => {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      restoreFocusContext.current = {};
      setStructuralBusy(true);
      setSaveState({ state: "saving" });
      let pending = [...pendingRetries.current];
      if (creationRejected.current && newStory.current) {
        const story = newStory.current.story;
        // Only a definitive validation rejection permits changing the creation payload.
        // Unknown outcomes must replay the original payload before later story patches.
        pending = pending.filter(({ operation }) => !(operation.type === "story" && operation.storyId === story.id))
          .map((item) => item.operation.type === "add_original_story" && item.operation.storyId === story.id
            ? { ...item, operation: originalStoryOperation(story) } : item);
      }
      pendingRetries.current = [];
      queuedSaves.current.push(...pending);
      let index = 0;
      try {
        const latest = await adminApi<Workspace>(path);
        revision.current = latest.draft.revision;
        blocked.current = false;
        const rebased = rebasePendingDraft(latest.draft, [
          ...pendingRetries.current,
          ...queuedSaves.current,
          ...[...scheduled.current.values()].map(({ operation }) => ({ operation, syncPresentation: false })),
        ]);
        if (newStory.current) {
          const attemptedStory = newStory.current.story;
          rebased.presentation.stories = rebased.presentation.stories.map((story) => story.id === attemptedStory.id ? attemptedStory : story);
        }
        setWorkspace({ ...latest, draft: rebased });
        for (; index < pending.length; index += 1) {
          try {
            await requestSave(pending[index].operation, pending[index].syncPresentation);
          } catch (error) {
            const rejection = rejectedWorkflowMessage(pending[index].operation, error);
            if (!rejection) throw error;
            setReleaseError(rejection);
          }
          queuedSaves.current = queuedSaves.current.filter((item) => item !== pending[index]);
        }
        saveFailure.current = null;
      } catch (error) {
        blocked.current = true;
        for (const remaining of pending.slice(index)) remember(remaining);
        saveFailure.current = error instanceof ApiError && error.status === 409
          ? { state: "conflict", detail: error.message, retry: retryPending }
          : { state: "error", detail: errorText(error), retry: retryPending };
      } finally {
        queuedSaves.current = queuedSaves.current.filter((item) => !pending.includes(item));
        refreshSaveState();
        setStructuralBusy(false);
      }
    });
  }, [path, requestSave, remember, refreshSaveState]);

  const save = useCallback((operation: PublicationDraftPatch, syncPresentation = false) => {
    if (operation.type === "add_original_story" && newStory.current) newStory.current.submitted = true;
    const queued = { operation, syncPresentation };
    queuedSaves.current.push(queued);
    const execute = async () => {
      const previous = pendingRetries.current.find((candidate) => sameSaveTarget(candidate.operation, operation));
      if (previous) {
        operation = { ...previous.operation, ...operation } as PublicationDraftPatch;
        queued.operation = operation;
        pendingRetries.current = pendingRetries.current.filter((candidate) => candidate !== previous);
        blocked.current = pendingRetries.current.length > 0;
      }
      if (blocked.current) {
        remember({ operation, syncPresentation });
        return false;
      }
      refreshSaveState();
      try {
        await requestSave(operation, syncPresentation);
        if (!pendingRetries.current.length) saveFailure.current = null;
        return true;
      } catch (error) {
        const rejection = rejectedWorkflowMessage(operation, error);
        if (rejection) {
          setReleaseError(rejection);
          if (!pendingRetries.current.length) saveFailure.current = null;
          return false;
        }
        blocked.current = true;
        remember({ operation, syncPresentation });
        saveFailure.current = error instanceof ApiError && error.status === 409
          ? { state: "conflict", detail: error.message, retry: retryPending }
          : { state: "error", detail: errorText(error), retry: retryPending };
        return false;
      }
    };
    const result = queue.current.then(execute).finally(() => {
      queuedSaves.current = queuedSaves.current.filter((item) => item !== queued);
      refreshSaveState();
    });
    queue.current = result.then(() => undefined);
    return result;
  }, [requestSave, retryPending, remember, refreshSaveState]);

  const schedule = useCallback((key: string, operation: PublicationDraftPatch) => {
    const previous = scheduled.current.get(key);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      scheduled.current.delete(key);
      void save(operation);
    }, 650);
    scheduled.current.set(key, { timer, operation });
    refreshSaveState();
  }, [save, refreshSaveState]);

  const flush = useCallback(async () => {
    do {
      const pending = [...scheduled.current.values()];
      scheduled.current.clear();
      for (const item of pending) {
        clearTimeout(item.timer);
        void save(item.operation);
      }
      const currentQueue = queue.current;
      await currentQueue;
      if (blocked.current || pendingRetries.current.length) {
        throw new Error("Edits are not saved. Resolve the save error and retry before continuing.");
      }
      if (currentQueue === queue.current && !scheduled.current.size) return;
    } while (true);
  }, [save]);

  const canLeave = useCallback(async () => {
    if (actionBusy.current || editor.current?.querySelector('[aria-busy="true"]')) {
      setReleaseError("Wait for the current editorial action before switching drafts.");
      return false;
    }
    try {
      await flush();
      if (actionBusy.current || editor.current?.querySelector('[aria-busy="true"]')) {
        throw new Error("Wait for the current editorial action before switching drafts.");
      }
      if (auxiliaryFailure.current) throw new Error("Resolve the image save error before switching drafts.");
      if ([...dirtyForms.current].some((form) => form.isConnected)) {
        throw new Error("Save or explicitly cancel unfinished reporting, image, or private-note forms before switching drafts.");
      }
      return true;
    } catch (error) {
      setReleaseError(errorText(error));
      return false;
    }
  }, [flush]);

  useEffect(() => {
    if (beforeDraftChange) beforeDraftChange.current = canLeave;
    return () => {
      if (beforeDraftChange?.current === canLeave) beforeDraftChange.current = null;
    };
  }, [beforeDraftChange, canLeave]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (blocked.current || pendingRetries.current.length || scheduled.current.size
        || actionBusy.current || auxiliaryFailure.current || queuedSaves.current.length || editor.current?.querySelector('[aria-busy="true"]')
        || [...dirtyForms.current].some((form) => form.isConnected) || saveState.state === "saving") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [saveState.state]);

  const structuralSave = useCallback(async (operation: PublicationDraftPatch) => {
    if (!writeAllowed.current) {
      setReleaseError("Write access is unavailable or support has expired. Your attempted input is preserved.");
      return false;
    }
    restoreFocus.current ??= document.activeElement as HTMLElement | null;
    restoreFocusContext.current = {
      story: restoreFocus.current?.closest<HTMLElement>("[data-story-id]")?.dataset.storyId,
      section: restoreFocus.current?.closest<HTMLElement>("[data-section-id]")?.dataset.sectionId,
    };
    actionBusy.current = true;
    setStructuralBusy(true);
    setReleaseError("");
    const previous = pendingRetries.current.find((candidate) => sameSaveTarget(candidate.operation, operation));
    if (previous) {
      operation = { ...previous.operation, ...operation } as PublicationDraftPatch;
      pendingRetries.current = pendingRetries.current.filter((candidate) => candidate !== previous);
      blocked.current = pendingRetries.current.length > 0;
    }
    try {
      await flush();
      if (operation.type === "ready_for_approval" && (newStory.current || auxiliaryFailure.current
        || editor.current?.querySelector('[aria-busy="true"]')
        || [...dirtyForms.current].some((form) => form.isConnected))) {
        setReleaseError("Save unfinished reporting, image, or private-note work before marking this draft ready. Start typing or remove an empty new story.");
        return false;
      }
      return await save(operation, true);
    } catch (error) {
      if (operation.type === "section_order" || operation.type === "story_order" || operation.type === "story") {
        remember({ operation, syncPresentation: true });
      }
      setReleaseError(errorText(error));
      return false;
    } finally {
      actionBusy.current = false;
      setStructuralBusy(false);
    }
  }, [flush, save, remember]);

  const updatePresentation = useCallback((change: (draft: PublicationDraft) => PublicationDraft) => {
    setWorkspace((current) => current && { ...current, draft: change(current.draft) });
  }, []);

  async function releaseAction(label: string, action: () => Promise<unknown>, notice: string) {
    if (!writeAllowed.current) {
      setReleaseError("Write access is unavailable or support has expired.");
      return;
    }
    actionBusy.current = true;
    setReleaseBusy(label);
    setReleaseError("");
    setReleaseNotice("");
    try {
      await flush();
      if (auxiliaryFailure.current || editor.current?.querySelector('[aria-busy="true"]')) {
        throw new Error("Resolve pending image or private-note work before continuing.");
      }
      if ([...dirtyForms.current].some((form) => form.isConnected)) {
        throw new Error("Save or explicitly cancel unfinished reporting, image, or private-note forms before continuing.");
      }
      await action();
      if (!editor.current) return;
      await Promise.all([load(), loadReleases()]);
      setReleaseNotice(notice);
    } catch (error) {
      setReleaseError(errorText(error));
    } finally {
      actionBusy.current = false;
      setReleaseBusy("");
    }
  }

  async function openWebPreview() {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setReleaseBusy("preview");
    setReleaseError("");
    setWebPreview(null);
    try {
      await flush();
      if (newStory.current || auxiliaryFailure.current || editor.current?.querySelector('[aria-busy="true"]')
        || [...dirtyForms.current].some((form) => form.isConnected)) {
        throw new Error("Save or explicitly cancel unfinished reporting, image, or private-note work before previewing.");
      }
      const selectedRevision = revision.current;
      const result = await adminApi<{ preview_url: string }>(`${path}/preview?revision=${selectedRevision}`);
      setWebPreview({ url: result.preview_url, revision: selectedRevision });
    } catch (error) {
      setReleaseError(errorText(error));
    } finally {
      actionBusy.current = false;
      setReleaseBusy("");
    }
  }

  if (!workspace && !loadError) return <section className="panel" hidden={taskHidden} inert={taskHidden}><p role="status">Loading editorial workspace…</p></section>;
  if (!workspace) return <section className="panel" hidden={taskHidden} inert={taskHidden}><p className="alert" role="alert">{loadError}</p><button type="button" onClick={() => void load()}>Retry</button></section>;

  const { draft } = workspace;
  const readerPath = workspace.readerLink?.state !== "unavailable" && workspace.readerBaseUrl
    ? `${workspace.readerBaseUrl}/publications/${encodeURIComponent(publicationId)}` : null;
  const editing = draft.editorial_status === "editing";
  const published = draft.editorial_status === "published";
  const selectedRelease = published
    ? releases.find((release) => release.releaseId === draft.release?.release_id) : undefined;
  const studioHref = selectedRelease && selectedRelease.action?.action !== "withdraw" && !selectedRelease.correctionRequired
    ? newsroomReleaseHref(publicationId, selectedRelease.releaseId) : null;
  const includedCount = includedPublicationStories(draft).length;
  const missingEssentials = editionEssentials(draft);
  const visiblePreview = workspace.readerLink?.state !== "unavailable"
    && webPreview?.revision === draft.revision && saveState.state === "saved" ? webPreview : null;
  const storyById = new Map(draft.presentation.stories.map((story) => [story.id, story]));
  const evidenceByStory = new Map(workspace.evidence.map((entry) => [entry.story_id, entry]));
  const selectedStoryId = storyById.has(activeStoryId ?? "") ? activeStoryId : draft.presentation.story_order[0] ?? null;

  function outlineStatus(story: PublicationPresentationStory) {
    const generated = generatedPublicationStory(draft, story);
    const evidenceFlags = story.generated_story_id ? evidenceByStory.get(story.generated_story_id)?.review.flags.length : 0;
    return [
      !publicationStoryIncluded(draft, story) ? "Excluded" : "",
      missingEssentials.some((issue) => ["story", "sources", "section", "locations", "byline", "image"]
        .some((field) => issue.href === `#edition-${field}-${encodeURIComponent(story.id)}`)) ? "Needs attention" : "",
      publicationStorySafetyError(draft, story) || generated?.review.status === "held" || generated?.review.flags.length || evidenceFlags ? "Holds / flags" : "",
    ].filter(Boolean).join(" · ");
  }

  function updateStory(storyId: string, change: Partial<PublicationPresentationStory>) {
    if (newStory.current?.story.id === storyId) {
      newStory.current.story = { ...newStory.current.story, ...change };
    }
    updatePresentation((current) => ({
      ...current,
      presentation: {
        ...current.presentation,
        stories: current.presentation.stories.map((story) => story.id === storyId ? { ...story, ...change } : story),
      },
    }));
  }

  function scheduleStory(key: string, operation: PublicationDraftPatch) {
    if (newStory.current && !newStory.current.submitted && "storyId" in operation && operation.storyId === newStory.current.story.id) {
      const story = newStory.current.story;
      schedule(`create:${story.id}`, originalStoryOperation(story));
    } else schedule(key, operation);
  }

  function addStory() {
    const unfinished = newStory.current?.story;
    if (unfinished) {
      focusStory.current = true;
      setActiveStoryId(unfinished.id);
      editor.current?.querySelector<HTMLInputElement>(`[data-story-id="${unfinished.id}"] input[data-story-headline]`)?.focus();
      return;
    }
    const story: PublicationPresentationStory = {
      id: crypto.randomUUID(), origin: "original", generated_story_id: null, headline: "", body: "", byline: "",
      section_id: draft.presentation.sections.length === 1 ? draft.presentation.sections[0].id : "",
      location_tags: draft.locations.length === 1 ? [draft.locations[0].id] : [],
      source_metadata: [], image_id: null, included: true,
    };
    newStory.current = { story, submitted: false };
    updatePresentation((current) => ({ ...current, presentation: { ...current.presentation,
      stories: [...current.presentation.stories, story], story_order: [...current.presentation.story_order, story.id] } }));
    focusStory.current = true;
    setActiveStoryId(story.id);
  }

  const approveRevision = () => void releaseAction("approve", () =>
    adminApi(`${path}/approve`, { method: "POST", body: JSON.stringify({ expectedRevision: draft.revision }) }),
  "Exact draft revision approved.");
  const publishApproved = () => void releaseAction("publish", () =>
    adminApi(`${path}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: draft.approval!.revision, expectedContentHash: draft.approval!.content_hash }),
    }),
  "Immutable publication release published to the Reader.");
  const stageAction = !canWrite ? null
    : editing ? { label: "Mark ready for approval", run: () => void structuralSave({ type: "ready_for_approval" }) }
      : draft.editorial_status === "ready_for_approval" ? { label: "Approve", run: approveRevision }
        : draft.editorial_status === "approved" && draft.approval ? { label: "Publish", run: publishApproved }
          : null;
  const canReopen = canWrite && (draft.editorial_status === "ready_for_approval" || draft.editorial_status === "approved");
  const statusKey = editionStatusKey(draft.editorial_status, {
    withdrawn: selectedRelease?.action?.action === "withdraw", correction: Boolean(draft.correction),
  });
  const locationNames = (ids: string[]) => ids.map((id) => draft.locations.find((location) => location.id === id)?.name ?? id).join(", ");
  const selectStory = (id: string) => {
    setPanelTarget("story");
    setActiveStoryId(id);
  };
  const openExtras = () => {
    setAddMenuOpen(false);
    if (extrasRef.current) {
      extrasRef.current.open = true;
      extrasRef.current.scrollIntoView?.({ block: "start" });
      extrasRef.current.querySelector<HTMLElement>("summary")?.focus();
    }
  };

  return <section ref={editor} className="editorial-workspace workflow-stack jw-editor" aria-labelledby="editorial-workspace-title"
    hidden={taskHidden} inert={taskHidden || releaseBusy !== "" || structuralBusy}
    onInputCapture={(event) => {
      setWebPreview(null);
      const form = (event.target as HTMLElement).closest("form");
      if (form) dirtyForms.current.add(form);
      refreshSaveState();
    }}
    onChangeCapture={(event) => {
      setWebPreview(null);
      const form = (event.target as HTMLElement).closest("form");
      if (form) dirtyForms.current.add(form);
      refreshSaveState();
    }}
    onSubmitCapture={(event) => dirtyForms.current.add(event.target as HTMLFormElement)}
    onClickCapture={(event) => {
      const target = event.target as HTMLElement;
      const form = target.closest("form");
      if (form && target.closest("button")) dirtyForms.current.add(form);
    }}
    onResetCapture={(event) => { dirtyForms.current.delete(event.target as HTMLFormElement); refreshSaveState(); }}
    onBlur={() => { void flush().catch((error) => setReleaseError(errorText(error))); }}>
    <header className="jw-editor-header newsroom-step-panel">
      {task !== undefined && <nav className="card-actions editorial-return" aria-label="Edition navigation">
        <Link href={newsroomHref(publicationId, "editions")}>All editions</Link>
        <Link href={newsroomHref(publicationId, "activity")}>Generation activity</Link>
      </nav>}
      <div className="jw-editor-titlebar">
        <div className="jw-editor-title">
          <div className="jw-editor-title-row">
            <h2 id="editorial-workspace-title" tabIndex={-1} aria-description={draft.presentation.headline || draft.title}>Edition editor</h2>
            <StatusPill status={statusKey} />
          </div>
          <p className="jw-editor-subtitle">{draft.title || "Weekly edition"} · {formatEditionWindow(draft.window)} · {draft.locations.map((location) => location.name).join(", ") || "No communities"}</p>
        </div>
        <div className="jw-editor-actions">
          <div className="editorial-save-state" data-state={saveState.state}>{saveState.state === "saved" && <Icon name="check" size={13} />}
            <span role="status" aria-live="polite" aria-atomic="true" className={`status-badge tone-${saveState.state === "saved" ? "ok" : saveState.state === "saving" ? "running" : "failed"}`}>
              {saveState.state === "saved" ? published ? "Published · read-only" : newStory.current && !newStory.current.submitted ? "Start typing to save" : "Saved" : saveState.state === "saving" ? "Saving…" : saveState.state === "conflict" ? "Conflict" : "Not saved"}
            </span>
          </div>
          <button type="button" className="secondary" aria-pressed={previewMode} onClick={() => setPreviewMode((value) => !value)}>
            <Icon name="eye" size={16} />{previewMode ? "Exit preview" : "Preview"}</button>
          {canReopen && <button type="button" className="secondary" disabled={releaseBusy !== ""} onClick={() => void structuralSave({ type: "reopen_for_editing" })}>Reopen</button>}
          {stageAction && <button type="button" disabled={releaseBusy !== ""} onClick={stageAction.run}>{stageAction.label}</button>}
        </div>
      </div>
      <div className="edition-guide" aria-label="Selected edition guide">
        <p>{draft.window.join(" to ")} · {draft.editorial_status.replaceAll("_", " ")} · revision {draft.revision} · {includedCount} included {includedCount === 1 ? "story" : "stories"}</p>
        <nav className="card-actions" aria-label="Selected edition stages">
          <a className="button secondary" href={published && readerPath && draft.release ? `${readerPath}/releases/${encodeURIComponent(draft.release.release_id)}` : editing ? "#editorial-review-title" : "#editorial-publish-title"}>
            {published && readerPath && draft.release ? "View live" : editing ? "Review edition" : !canWrite ? "Inspect publication status"
              : draft.editorial_status === "ready_for_approval" ? `Approve revision ${draft.revision}`
                : draft.editorial_status === "approved" ? "Publish approved revision"
                  : draft.editorial_status === "publishing" ? "Finalize publication" : "Publication details"}</a>
          {studioHref && <a className="button secondary" href={studioHref}>Video Studio</a>}
          {draft.editorial_status === "publishing" || draft.editorial_status === "published"
            ? <a href="#publication-release-history-title">Release history</a>
            : <a href="#editorial-preview-title">Private preview (optional)</a>}
        </nav>
      </div>
      {(saveState.state === "conflict" || saveState.state === "error") && <p className="alert">
        {saveState.detail} {saveState.retry && <button type="button" className="run-inspect-link" disabled={!canWrite} onClick={saveState.retry}>Retry my edit</button>}
      </p>}
      {workspace.readerLink?.state === "unavailable" && <div className="alert" role="status">
        {workspace.readerLink.detail} <button type="button" className="secondary" disabled={readerRetryBusy}
          onClick={() => void retryReaderLinks()}>Retry Reader links</button>
      </div>}
      {readerRetryError && <p className="alert" role="alert">{readerRetryError}</p>}
      <p role="status" aria-live="polite" aria-atomic="true">{positionNotice}</p>
      {releaseError && <p className="alert" role="alert">{releaseError}</p>}
      {releaseNotice && <p className="notice" role="status">{releaseNotice}</p>}
      {!canWrite && <p className="notice" role="status">Read-only: write access is unavailable or support has expired. Attempted input stays here; no changes can be saved.</p>}
    </header>
    <section className="editorial-story-panel jw-editor-workspace" aria-labelledby="story-workspace-title" hidden={reportingHidden} inert={reportingHidden}>
      <div className="jw-editor-toolbar">
        <div className="jw-editor-toolbar-title">
          <h3 id="story-workspace-title" tabIndex={-1}>Stories</h3>
          <p className="chart-caption">{published ? "Published copy is read-only. Create a correction to make changes." : editing ? "Unfinished copy autosaves." : "This revision is locked for publication."}</p>
        </div>
        <label className="editorial-mobile-chooser">Active story
          <select aria-label="Active story" value={selectedStoryId ?? ""} onChange={(event) => {
            const storyId = event.target.value;
            selectStory(storyId);
            window.location.hash = `edition-story-${encodeURIComponent(storyId)}`;
          }}>
            {!draft.presentation.story_order.length && <option value="">No stories yet</option>}
            {draft.presentation.story_order.map((id) => {
              const story = storyById.get(id);
              const status = story && outlineStatus(story);
              return story && <option value={id} key={id}>{story.headline || "Untitled story"}{status ? ` · ${status}` : ""}</option>;
            })}
          </select>
        </label>
        <div className="jw-segmented" role="group" aria-label="Canvas width">
          <button type="button" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}>Desktop</button>
          <button type="button" aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")}>Mobile</button>
        </div>
        {editing && <div className="jw-add-content">
          <button type="button" aria-expanded={addMenuOpen} aria-controls="editorial-add-content" disabled={!canWrite}
            onClick={() => setAddMenuOpen((open) => !open)}><Icon name="plus" size={16} />Add content</button>
          <ul id="editorial-add-content" className="jw-add-menu" hidden={!addMenuOpen} aria-label="Add content">
            <li><span className="jw-add-icon"><Icon name="edition" size={16} /></span><span><button id="editorial-original-reporting-title" type="button" className="jw-add-item" disabled={!canWrite}
              onClick={() => { setAddMenuOpen(false); setPreviewMode(false); setPanelTarget("story"); setPanelTab("content"); addStory(); }}>Add story</button>
              <small>Original reporting with sources</small></span></li>
            <li><span className="jw-add-icon"><Icon name="sparkle" size={16} /></span><span><button type="button" className="jw-add-item" onClick={openExtras}>Save the Bee</button>
              <small>Optional word game for this edition</small></span></li>
            <li><span className="jw-add-icon"><Icon name="external" size={16} /></span><span><Link className="jw-add-item" href={`${newsroomHref(publicationId, "settings")}#sponsor-placements`}>Sponsor placements</Link>
              <small>Managed in Settings, shown on every edition</small></span></li>
          </ul>
        </div>}
      </div>
      <div className="jw-editor-body" data-preview={previewMode ? "true" : undefined}>
        <div className="jw-canvas-scroll">
          <article className="jw-canvas" data-device={device} aria-label="Edition canvas">
            <header className="jw-canvas-masthead">
              <span>{formatEditionWindow(draft.window)}</span>
              <strong>Newsbee</strong>
              <span>{draft.locations.map((location) => location.name).join(" · ")}</span>
            </header>
            <button type="button" className={`jw-canvas-front${!previewMode && panelTarget === "edition" ? " selected" : ""}`}
              aria-pressed={panelTarget === "edition"} disabled={previewMode} onClick={() => setPanelTarget("edition")}>
              <span className="jw-canvas-eyebrow">{formatEditionWindow(draft.window)}</span>
              <span className="jw-canvas-headline">{draft.presentation.headline || <em>Add a publication headline</em>}</span>
              <span className="jw-canvas-intro">{draft.presentation.intro || <em>Add an introduction</em>}</span>
              <span className="jw-canvas-meta">Weekly edition · {includedCount} {includedCount === 1 ? "story" : "stories"}</span>
            </button>
            <nav className="editorial-desktop-outline jw-canvas-blocks" aria-label="Edition stories">
              {draft.presentation.story_order.map((id, index) => {
                const story = storyById.get(id);
                if (!story) return null;
                const section = draft.presentation.sections.find((candidate) => candidate.id === story.section_id);
                const status = outlineStatus(story);
                const generatedCopy = generatedPublicationStory(draft, story);
                const image = workspace.images.find((candidate) => candidate._id === story.image_id)?.image.image;
                const summary = generatedCopy?.snapshot.summary || story.body.split(/\n\s*\n/)[0] || "";
                const sources = story.origin === "original" ? story.source_metadata.map((source) => source.name).filter(Boolean)
                  : (generatedCopy?.snapshot.sources ?? []).map((source) => source.name).filter(Boolean);
                const lead = index === 0;
                return <a key={id} href={`#edition-story-${encodeURIComponent(id)}`}
                  aria-current={!previewMode && panelTarget === "story" && id === selectedStoryId ? "true" : undefined}
                  className={`jw-block${lead ? " jw-block-lead" : ""}${publicationStoryIncluded(draft, story) ? "" : " jw-block-excluded"}`}
                  onClick={() => selectStory(id)}>
                  {lead && <CanvasImage key={image ?? "none"} src={image ?? null} />}
                  <span className="jw-block-text">
                    <span className="jw-canvas-eyebrow">{[section?.title || "Choose section", locationNames(story.location_tags)].filter(Boolean).join(" · ")}</span>
                    <strong>{index + 1}. {story.headline || "Untitled story"}</strong>
                    {summary && <span className="jw-block-summary">{summary.length > 240 ? `${summary.slice(0, 240)}…` : summary}</span>}
                    {sources.length > 0 && <span className="jw-block-source">Source: {sources.slice(0, 3).join(" · ")}</span>}
                    <small>{story.origin === "generated" ? "Generated" : "Original"}{status ? ` · ${status}` : ""}</small>
                  </span>
                </a>;
              })}
            </nav>
            {editing && <button type="button" className="jw-add-block" disabled={!canWrite || previewMode}
              onClick={() => { setPanelTarget("story"); setPanelTab("content"); addStory(); }}><Icon name="plus" size={16} />Add another block</button>}
            <footer className="jw-canvas-footer"><strong>Newsbee</strong><span>Local news from primary sources.</span></footer>
          </article>
        </div>
        <aside className="jw-editor-panel" aria-label="Selected block" hidden={previewMode}>
          <div className="jw-panel-tabs" role="tablist" aria-label="Block settings" hidden={panelTarget !== "story"}>
            <button type="button" role="tab" id="editorial-tab-content" aria-selected={panelTab === "content"} aria-controls="editorial-panel-body" onClick={() => setPanelTab("content")}>Content</button>
            <button type="button" role="tab" id="editorial-tab-layout" aria-selected={panelTab === "layout"} aria-controls="editorial-panel-body" onClick={() => setPanelTab("layout")}>Layout</button>
          </div>
          <div id="editorial-panel-body" role="tabpanel" aria-labelledby={panelTab === "content" ? "editorial-tab-content" : "editorial-tab-layout"}>
          <div className="jw-panel-edition" hidden={panelTarget !== "edition"}>
            <div className="jw-panel-selected"><span className="jw-list-icon"><Icon name="edition" /></span><span><strong>Edition front</strong><small>Headline and introduction</small></span></div>
            {published && <div><h4>{draft.presentation.headline}</h4><p style={{ whiteSpace: "pre-wrap" }}>{draft.presentation.intro}</p></div>}
    <fieldset disabled={!canWrite} className="newsroom-step-panel editorial-front-panel" hidden={editionsHidden || published} inert={editionsHidden || published}>
      <div className="editorial-front">
        <label>Publication headline
          <input id="edition-headline" required aria-describedby="edition-required-copy" disabled={!editing} maxLength={240} value={draft.presentation.headline} onChange={(event) => {
            const headline = event.target.value;
            updatePresentation((current) => ({ ...current, presentation: { ...current.presentation, headline } }));
            schedule("draft:headline", { type: "draft", headline });
          }} />
        </label>
        <label>Introduction
          <textarea id="edition-intro" required aria-describedby="edition-required-copy" disabled={!editing} rows={4} maxLength={4000} value={draft.presentation.intro} onChange={(event) => {
            const intro = event.target.value;
            updatePresentation((current) => ({ ...current, presentation: { ...current.presentation, intro } }));
            schedule("draft:intro", { type: "draft", intro });
          }} />
        </label>
      </div>
      <p id="edition-required-copy" className="chart-caption">{published ? "Saved headline and introduction for this published edition." : "Publication headline and introduction are required before approval. Add an introduction to this edition even when generated stories are already ready."}</p>
    </fieldset>
            <button type="button" className="secondary" onClick={() => setPanelTarget("story")}>Back to stories</button>
          </div>
      <fieldset className="editorial-sections" disabled={!canWrite} aria-label="Story editor" hidden={panelTarget !== "story"}>
      {!draft.presentation.stories.length && <p>No stories yet. Add a story to start writing in this editor.</p>}
      {draft.presentation.section_order.map((sectionId, sectionIndex) => {
        const section = draft.presentation.sections.find((candidate) => candidate.id === sectionId);
        if (!section) return null;
        return <section className="editorial-section" key={section.id} data-section-id={section.id}
          hidden={panelTab !== "layout" || storyById.get(selectedStoryId ?? "")?.section_id !== sectionId} inert={panelTab !== "layout" || storyById.get(selectedStoryId ?? "")?.section_id !== sectionId}>
          <details className="editorial-section-settings" hidden={!section.id || published}>
          <summary>Section settings: {section.title}</summary>
          <div className="editorial-section-heading" tabIndex={-1} role="group" aria-label={`${section.title} section`}>
            <label>Section title<input aria-label={`Section title for ${section.title}`} disabled={!editing} value={section.title} maxLength={120} onChange={(event) => {
              const title = event.target.value;
              updatePresentation((current) => ({
                ...current,
                presentation: {
                  ...current.presentation,
                  sections: current.presentation.sections.map((candidate) => candidate.id === sectionId ? { ...candidate, title } : candidate),
                },
              }));
              schedule(`section:${sectionId}`, { type: "section", sectionId, title });
            }} /></label>
            {editing && <div className="card-actions">
              <button type="button" className="secondary" aria-label={`Move section ${section.title} up`} disabled={sectionIndex === 0} onClick={(event) => {
                restoreFocus.current = event.currentTarget.closest<HTMLElement>(".editorial-section-heading");
                const sectionIds = move(draft.presentation.section_order, sectionIndex, -1);
                updatePresentation((current) => ({ ...current, presentation: { ...current.presentation, section_order: sectionIds } }));
                void structuralSave({ type: "section_order", sectionIds }).then(() =>
                  setPositionNotice(`${section.title}: section ${sectionIndex} of ${sectionIds.length}.`));
              }}>Move up</button>
              <button type="button" className="secondary" aria-label={`Move section ${section.title} down`} disabled={sectionIndex === draft.presentation.section_order.length - 1} onClick={(event) => {
                restoreFocus.current = event.currentTarget.closest<HTMLElement>(".editorial-section-heading");
                const sectionIds = move(draft.presentation.section_order, sectionIndex, 1);
                updatePresentation((current) => ({ ...current, presentation: { ...current.presentation, section_order: sectionIds } }));
                void structuralSave({ type: "section_order", sectionIds }).then(() =>
                  setPositionNotice(`${section.title}: section ${sectionIndex + 2} of ${sectionIds.length}.`));
              }}>Move down</button>
            </div>}
          </div>
          </details>
        </section>;
      })}
          {draft.presentation.story_order.map((id) => {
            const story = storyById.get(id);
            if (!story) return null;
            const section = draft.presentation.sections.find((candidate) => candidate.id === story.section_id) ?? { id: "", title: "Unassigned" };
            const stories = draft.presentation.story_order.map((storyId) => storyById.get(storyId))
              .filter((candidate): candidate is PublicationPresentationStory => Boolean(candidate && candidate.section_id === story.section_id));
            const storyIndex = stories.findIndex((candidate) => candidate.id === story.id);
            const globalIndex = draft.presentation.story_order.indexOf(story.id);
            const moveStory = (direction: -1 | 1, target: HTMLElement) => {
              const neighbor = stories[storyIndex + direction];
              if (!neighbor) return;
              const storyIds = [...draft.presentation.story_order];
              const neighborIndex = storyIds.indexOf(neighbor.id);
              [storyIds[globalIndex], storyIds[neighborIndex]] = [storyIds[neighborIndex], storyIds[globalIndex]];
              restoreFocus.current = target.closest<HTMLElement>("article");
              updatePresentation((current) => ({ ...current, presentation: { ...current.presentation, story_order: storyIds } }));
              void structuralSave({ type: "story_order", storyIds }).then(() =>
                setPositionNotice(`${story.headline}: position ${storyIndex + direction + 1} of ${stories.length} in ${section.title}.`));
            };
            const generatedEvidence = story.generated_story_id ? evidenceByStory.get(story.generated_story_id) : undefined;
            const attachedImage = workspace.images.find((image) => image._id === story.image_id);
            const included = publicationStoryIncluded(draft, story);
            const generated = generatedPublicationStory(draft, story);
            const reviewableHold = generated?.review.status === "held" && publicationHoldIsReviewable(generated);
            const safetyError = publicationStorySafetyError(draft, story);
            const creating = newStory.current?.story.id === story.id;
            return <article className="editorial-story" id={`edition-story-${encodeURIComponent(story.id)}`} key={story.id} data-story-id={story.id} data-story-section={story.section_id} tabIndex={-1}
              hidden={story.id !== selectedStoryId} inert={story.id !== selectedStoryId} aria-label={`${story.headline || "Untitled story"} in ${section.title}`}>
              <div className="jw-panel-selected"><span className="jw-list-icon"><Icon name="edition" /></span>
                <span><strong>{story.origin === "generated" ? "Generated story" : "Original reporting"}</strong><small>Selected content block</small></span></div>
              <div className="editorial-story-fields">
                <div className="jw-panel-layout" hidden={panelTab !== "layout"}>
                  {editing && <div className="editorial-story-actions">
                    <p className="jw-eyebrow">Position and inclusion</p>
                  <div className="card-actions">
                    <button type="button" className="secondary" aria-label={`Move story ${story.headline} up in ${section.title}`}
                      disabled={creating || storyIndex === 0} onClick={(event) => moveStory(-1, event.currentTarget)}>Move up</button>
                    <button type="button" className="secondary" aria-label={`Move story ${story.headline} down in ${section.title}`}
                      disabled={creating || storyIndex === stories.length - 1} onClick={(event) => moveStory(1, event.currentTarget)}>Move down</button>

                  </div>
                  {editing && <button type="button" className="secondary" aria-label={`${included ? "Exclude story" : reviewableHold ? "Resolve hold and include story" : "Include story"} ${story.headline}`} disabled={creating || !included && Boolean(safetyError) && !reviewableHold}
                    onClick={() => {
                      const reason = !included && reviewableHold ? window.prompt("Explain how you resolved these reviewable quality holds. Hard safety holds cannot be overridden.") : undefined;
                      if (reason === null) return;
                      void structuralSave({ type: "inclusion", storyId: story.id, included: !included, ...(reason !== undefined ? { reason } : {}) });
                    }}>{included ? "Exclude story" : reviewableHold ? "Resolve hold and include" : "Include story"}</button>}
                  </div>}
                <div hidden={published} className="jw-panel-group">
                  <p className="jw-eyebrow">Section and locations{!story.section_id || !story.location_tags.length ? " · required" : ""}</p>
                <div className="filters">
                  <label>Section<select id={`edition-section-${encodeURIComponent(story.id)}`} aria-label={`Section for ${story.headline}`} disabled={!editing} value={story.section_id} onChange={(event) => {
                    const sectionId = event.target.value;
                    updateStory(story.id, { section_id: sectionId });
                    if (creating) scheduleStory(`story:${story.id}:section`, { type: "story", storyId: story.id, sectionId });
                    else void structuralSave({ type: "story", storyId: story.id, sectionId });
                  }}><option value="" disabled>Choose section</option>{draft.presentation.section_order.map((id) => {
                    const option = draft.presentation.sections.find((candidate) => candidate.id === id);
                    return option && <option key={id} value={id}>{option.title}</option>;
                  })}</select></label>
                </div>
                <fieldset id={`edition-locations-${encodeURIComponent(story.id)}`} data-editorial-correction className="editorial-locations" disabled={!editing}>
                  <legend>Locations for {story.headline}</legend>
                  {draft.locations.map((location) => <label key={location.id}><input type="checkbox" checked={story.location_tags.includes(location.id)} onChange={(event) => {
                    const locationTags = event.target.checked
                      ? [...story.location_tags, location.id]
                      : story.location_tags.filter((id) => id !== location.id);
                    updateStory(story.id, { location_tags: locationTags });
                    scheduleStory(`story:${story.id}:locations`, { type: "story", storyId: story.id, locationTags });
                  }} /> {location.name}</label>)}
                </fieldset>
                </div>
                </div>
                <div className="jw-panel-content" hidden={panelTab !== "content"}>
                {!included && <small>Excluded from output; edits and evidence retained</small>}
                {!included && safetyError && <p className="notice">{safetyError}</p>}
                {story.hold_resolution && <p className="chart-caption">Reviewed by {story.hold_resolution.by.email}: {story.hold_resolution.reason}</p>}
                {published ? <div className="published-story-copy">
                  <h4>{story.headline}</h4>
                  {story.byline && <p className="chart-caption">{story.byline}</p>}
                  <p style={{ whiteSpace: "pre-wrap" }}>{story.body}</p>
                  <p className="chart-caption">{section.title} · {story.location_tags.map((id) => draft.locations.find((location) => location.id === id)?.name ?? id).join(", ")}</p>
                </div> : <><label>Headline<input data-story-headline aria-label={`Headline for ${story.headline || "Untitled story"}`} disabled={!editing} maxLength={240} value={story.headline} onChange={(event) => {
                  const headline = event.target.value;
                  updateStory(story.id, { headline });
                  scheduleStory(`story:${story.id}:headline`, { type: "story", storyId: story.id, headline });
                }} /></label>
                <label>Story body<textarea aria-label={`Story body for ${story.headline || "Untitled story"}`} disabled={!editing} rows={14} maxLength={20_000} value={story.body} onChange={(event) => {
                  const body = event.target.value;
                  updateStory(story.id, { body });
                  scheduleStory(`story:${story.id}:body`, { type: "story", storyId: story.id, body });
                }} /></label>
                <div className="filters">
                  <label>Byline<input id={`edition-byline-${encodeURIComponent(story.id)}`} aria-label={`Byline for ${story.headline}`} disabled={!editing} maxLength={240} value={story.byline} onChange={(event) => {
                    const byline = event.target.value;
                    updateStory(story.id, { byline });
                    scheduleStory(`story:${story.id}:byline`, { type: "story", storyId: story.id, byline });
                  }} /></label>
                </div></>}
                {story.origin === "original" && <details>
                  <summary>Sources{!story.source_metadata.length || story.source_metadata.some((source) => !source.name.trim() || ["web", "document"].includes(source.type) && !source.url) ? " · required" : ` · ${story.source_metadata.length}`}</summary>
                <OriginalSources story={story} disabled={!editing} onChange={(sourceMetadata) => {
                  updateStory(story.id, { source_metadata: sourceMetadata });
                  scheduleStory(`story:${story.id}:sources`, { type: "story", storyId: story.id, sourceMetadata });
                }} /></details>}
                {story.image_review?.status === "needs_review" && <p className="alert" role="alert">
                  Image needs review: {story.image_review.reason}
                </p>}
                {editing && !attachedImage && (story.image_id || story.image_review?.status === "needs_review") &&
                  <button type="button" className="secondary" aria-label={`Use no image for ${story.headline}`} onClick={() => void structuralSave({ type: "story", storyId: story.id, imageId: null })}>Use no image</button>}
                {creating ? <p className="chart-caption">Start writing and confirm the first save before adding images or private notes.</p> : <><ImageEditor publicationPath={path} story={story} image={attachedImage} revision={revision}
                  beforeSave={async () => { if (!writeAllowed.current) throw new Error("Write access is unavailable or support has expired."); await flush(); }}
                  onSaving={() => reportAuxiliaryState(`image:${story.id}`, { state: "saving" })}
                  editing={editing} onSaved={(result) => {
                    revision.current = result.draft.revision;
                    setWorkspace((current) => current && {
                      ...current,
                      draft: {
                        ...current.draft,
                        revision: result.draft.revision,
                        updated_at: result.draft.updated_at,
                        updated_by: result.draft.updated_by,
                        presentation: {
                          ...current.draft.presentation,
                          stories: current.draft.presentation.stories.map((candidate) => candidate.id === story.id
                            ? { ...candidate, image_id: result.image?._id ?? null,
                              image_review: result.draft.presentation.stories.find((saved) => saved.id === story.id)?.image_review }
                            : candidate),
                        },
                      },
                      images: result.image ? [...current.images.filter((candidate) => candidate._id !== result.image!._id), result.image] : current.images.filter((candidate) => candidate._id !== story.image_id),
                    });
                    reportAuxiliaryState(`image:${story.id}`, null);
                  }} onError={(error, retry) => {
                    const retryWithLatest = () => {
                      void (async () => {
                        await flush();
                        if (error instanceof ApiError && error.status === 409) {
                          const latest = await adminApi<Workspace>(path);
                          revision.current = latest.draft.revision;
                        }
                        await retry();
                      })().catch((cause) => {
                        reportAuxiliaryState(`image:${story.id}`, { state: "error", detail: errorText(cause), retry: retryWithLatest });
                      });
                    };
                    reportAuxiliaryState(`image:${story.id}`, error instanceof ApiError && error.status === 409
                      ? { state: "conflict", detail: error.message, retry: retryWithLatest }
                      : error instanceof ApiError && error.status === 422
                        ? { state: "error", detail: error.message }
                        : { state: "error", detail: errorText(error), retry: retryWithLatest });
                  }} />
                <PrivateNotes publicationPath={path} storyId={story.id} editing={editing}
                  draftRevision={revision} beforeSave={async () => { if (!writeAllowed.current) throw new Error("Write access is unavailable or support has expired."); await flush(); }}
                  onPersistenceChange={reportAuxiliaryState}
                  onDraftSaved={(savedDraft) => applyServerDraft(savedDraft, false)} /></>}
                {editing && <div className="jw-panel-remove">
                    {story.origin === "original" && <button type="button" className="jw-button-danger" aria-label={`Remove story ${story.headline || "Untitled story"}`} onClick={() => {
                      if (creating && !newStory.current?.submitted) {
                        const pending = scheduled.current.get(`create:${story.id}`);
                        if (pending) clearTimeout(pending.timer);
                        scheduled.current.delete(`create:${story.id}`);
                        newStory.current = null;
                        updatePresentation((current) => ({ ...current, presentation: { ...current.presentation,
                          stories: current.presentation.stories.filter((candidate) => candidate.id !== story.id),
                          story_order: current.presentation.story_order.filter((id) => id !== story.id) } }));
                        refreshSaveState();
                      } else void structuralSave({ type: "remove_original_story", storyId: story.id });
                    }}>Remove story</button>}
                </div>}
                </div>
              </div>
              <div hidden={panelTab !== "content"}>
              {story.origin === "generated" && <aside className="editorial-story-evidence" aria-label={`Evidence for ${story.headline}`}>
                <details open={Boolean(safetyError || generated?.review.status === "held" || generated?.review.flags.length || generatedEvidence?.review.flags.length)}>
                  <summary>Generated evidence and flags</summary>
                  {safetyError && <p className="alert">{safetyError}</p>}
                  <StoryEvidence flags={[...new Set([...(generated?.review.flags ?? []), ...(generatedEvidence?.review.flags ?? [])])]}
                      sources={generatedEvidence?.sources} items={generatedEvidence?.items}
                      empty="No enriched evidence packet is stored for this generated story." />
                </details>
              </aside>}
              </div>
            </article>;
          })}
      </fieldset>
          </div>
        </aside>
      </div>
      {!editing && <section aria-labelledby="editorial-original-reporting-title">
        <h3 id="editorial-original-reporting-title" tabIndex={-1}>{published ? "Published edition" : "Original reporting (optional)"}</h3>
        {draft.editorial_status === "published"
            ? <p>This published release is immutable. Use <a href="#publication-release-history-title">Publication releases</a> to start a correction, or add reporting to a new edition.</p>
            : draft.editorial_status === "publishing"
              ? <p>Publication is being finalized. Reporting cannot be changed while publication is in progress.</p>
              : <p>Reopen for editing to add original reporting. This clears any existing approval.</p>}
      </section>}
    </section>

    <details className="panel editorial-extras" id="editorial-extras" ref={extrasRef}>
      <summary>Optional extras</summary>
      {published && <p>{draft.presentation.save_the_bee ? `Save the Bee included. Hint: ${draft.presentation.save_the_bee.clue}` : "No Save the Bee game included."} Changes require a correction.</p>}
    <fieldset disabled={!canWrite || !editing} className="newsroom-step-panel" hidden={editionsHidden || published} inert={editionsHidden || published}>
      <legend>Save the Bee (optional)</legend>
      <p>{published ? "Saved game for this edition. Changes require a correction." : "Choose your own word and hint for this edition. Saving the game does not approve or publish it."}</p>
      <PublicationBeeEditor key={JSON.stringify([draft._id, draft.presentation.save_the_bee ?? null])}
        game={draft.presentation.save_the_bee ?? null}
        onDirty={reportBeeFormDirty}
        onSave={(game) => structuralSave({ type: "bee_game", game })} />
    </fieldset>
    </details>
    <section className="panel newsroom-step-panel editorial-preview" aria-labelledby="editorial-preview-title" hidden={editionsHidden || published} inert={editionsHidden || published}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Preview</p>
          <h3 id="editorial-preview-title">Check the web presentation</h3>
          <p>Previews use the current saved draft. Private preview is recommended but optional, not an approval requirement. Publishing remains a separate explicit action.</p>
        </div>
        <div className="card-actions">
          <button type="button" className="secondary" aria-pressed={Boolean(visiblePreview)}
            disabled={draft.editorial_status === "publishing" || draft.editorial_status === "published"}
            onClick={() => visiblePreview ? setWebPreview(null) : void openWebPreview()}>Preview web</button>
        </div>
      </div>
      {visiblePreview && <div className="draft-preview web">
        <p className="eyebrow">Private draft preview · revision {visiblePreview.revision} · not published</p>
        <a href={visiblePreview.url} target="_blank" rel="noopener noreferrer">Open this revision in the Reader</a>
        <iframe src={visiblePreview.url} title={`Private Reader preview of draft revision ${visiblePreview.revision}`}
          referrerPolicy="same-origin" style={{ width: "100%", height: "70vh", border: 0 }} />
      </div>}
    </section>

    <fieldset disabled={!canWrite} className="panel newsroom-step-panel editorial-ready editorial-publish" hidden={editionsHidden} inert={editionsHidden}>
      <div>
        <h3 id="editorial-publish-title" tabIndex={-1}>{editing ? "Ready for approval" : draft.editorial_status === "ready_for_approval" ? "Approve this exact revision" : draft.editorial_status === "approved" ? "Approved and ready for explicit web publication" : draft.editorial_status === "publishing" ? "Publication is being finalized" : "Published immutable release"}</h3>
        {published ? <p>This edition has been published. Its release cannot be edited or approved again. Use release history to create a correction or withdraw it.</p>
          : <p>Every assigned journalist may approve, including their own work. Approval is bound to the displayed revision. Reopening for a material edit clears approval. It does not publish, distribute, email or write reader JSON. Web publication remains a separate explicit action.</p>}
      </div>
      <section id="editorial-review-title" tabIndex={-1} aria-label="Review edition">
        {!published && <><h3>Review edition</h3>
        {missingEssentials.length > 0
          ? <ul className="edition-issues">{missingEssentials.map((item) => <li key={`${item.href}:${item.label}`}><a href={item.href} onClick={() => revealAnchor(item.href)}>{item.label}</a></li>)}</ul>
          : <p>{editing ? "No copy issues listed. Request readiness for authoritative checks." : "No copy issues listed for this saved revision."}</p>}
        <p className="chart-caption">The server checks completeness, safety, sources, media, access and the exact saved revision. Preview is optional.</p></>}
      </section>
      {editing && <button type="button" onClick={() => void structuralSave({ type: "ready_for_approval" })}>Mark ready for approval</button>}
      {draft.editorial_status === "ready_for_approval" && <>
        <button type="button" disabled={releaseBusy !== ""} onClick={() => void releaseAction("approve", () =>
          adminApi(`${path}/approve`, { method: "POST", body: JSON.stringify({ expectedRevision: draft.revision }) }),
        "Exact draft revision approved.")}>{releaseBusy === "approve" ? "Approving…" : `Approve revision ${draft.revision}`}</button>
        <button type="button" className="secondary" disabled={releaseBusy !== ""} onClick={() => void structuralSave({ type: "reopen_for_editing" })}>Reopen for editing</button>
      </>}
      {draft.editorial_status === "approved" && draft.approval && <>
        <p className="chart-caption">Approved by {draft.approval.approved_by.email} · {new Date(draft.approval.approved_at * 1000).toLocaleString()} · content <code>{draft.approval.content_hash.slice(0, 16)}</code></p>
        <button type="button" disabled={releaseBusy !== ""} onClick={() => void releaseAction("publish", () =>
          adminApi(`${path}/publish`, {
            method: "POST",
            body: JSON.stringify({
              expectedRevision: draft.approval!.revision,
              expectedContentHash: draft.approval!.content_hash,
            }),
          }),
        "Immutable publication release published to the Reader.")}>{releaseBusy === "publish" ? "Publishing…" : "Publish to web"}</button>
        <button type="button" className="secondary" disabled={releaseBusy !== ""} onClick={() => void structuralSave({ type: "reopen_for_editing" })}>Reopen and invalidate approval</button>
      </>}
      {draft.editorial_status === "publishing" && draft.approval && <>
        <p className="chart-caption">The immutable release claim is preserved so a failed artifact or manifest write can be retried safely.</p>
        <button type="button" disabled={releaseBusy !== ""} onClick={() => void releaseAction("publish", () =>
          adminApi(`${path}/publish`, {
            method: "POST",
            body: JSON.stringify({
              expectedRevision: draft.approval!.revision,
              expectedContentHash: draft.approval!.content_hash,
            }),
          }),
        "Immutable publication release finalized.")}>{releaseBusy === "publish" ? "Finalizing…" : "Retry publication finalization"}</button>
      </>}
      {published && !readerPath && <span>Live Reader link unavailable</span>}
    </fieldset>
    <section className="panel newsroom-step-panel publication-release-history" aria-labelledby="publication-release-history-title" hidden={editionsHidden} inert={editionsHidden}>
      <div className="section-heading">
        <div><p className="eyebrow">Immutable history</p><h3 id="publication-release-history-title">Publication releases</h3></div>
        {readerPath ? <a className="button secondary" href={`${readerPath}/archive`}>Reader archive</a> : <span>Reader archive unavailable</span>}
      </div>
      <p>Choose Video Studio on a published release to create a video from one of its stories. Opening the Studio starts no generation. Videos remain separate from the Reader edition and do not send email.</p>
      <p className="chart-caption">Newsroom editions can include a Save the Bee game chosen in Optional extras before publication. Community games are not imported automatically. Email delivery is unavailable.</p>
      {!releases.length ? <p>No combined publication release has been published yet.</p> : <ol className="edition-list">
        {releases.map((release) => {
          const withdrawn = release.action?.action === "withdraw";
          return <li key={release.releaseId}>
            <div>
              <strong>{release.title}</strong>
              <p className="chart-caption">{release.windowStart} to {release.windowEnd} · {release.locations.map((location) => location.name).join(", ")} · <code>{release.contentHash.slice(0, 16)}</code>{withdrawn ? " · withdrawn" : ""}</p>
              {release.correction && <p>Correction of {release.correction.supersedes_release_id}: {release.correction.reason}</p>}
              {withdrawn && <p className="alert">{release.action?.reason}</p>}
              {release.correctionRequired && <div className="alert">
                <strong>Correction required:</strong>
                <ul>{release.sourceChanges.filter((change) => change.action === "source_withdrawal").map((change) =>
                  <li key={`${change.source.location_id}:${change.source.story_id}`}>
                    {change.source.location_id} / {change.source.story_id}: {change.reason}
                  </li>)}</ul>
              </div>}
              {!release.correctionRequired && release.sourceChanges.some((change) => change.action === "source_restore") &&
                <p className="notice">Previously changed source references are currently restored.</p>}
              <div className="card-actions">
                {readerPath ? <a className="button secondary" href={`${readerPath}/releases/${encodeURIComponent(release.releaseId)}`}>Open release</a>
                  : <span>Reader release link unavailable</span>}
                {!withdrawn && !release.correctionRequired && <a className="button secondary" href={newsroomReleaseHref(publicationId, release.releaseId)}>{canWrite ? "Video Studio" : "Inspect Video Studio"}</a>}
                {!withdrawn && <button type="button" className="secondary" disabled={!canWrite || releaseBusy !== ""} onClick={() => {
                  const reason = window.prompt("Public correction reason");
                  if (reason) void releaseAction(`correct:${release.releaseId}`, () =>
                    adminApi<{ draft: PublicationDraft }>(`${releasesPath}/${encodeURIComponent(release.releaseId)}/corrections`, {
                      method: "POST",
                      body: JSON.stringify({ reason }),
                    }).then(async (result) => {
                      const { draft: correction } = result;
                      if (onSelectDraft) {
                        actionBusy.current = false;
                        await onSelectDraft(correction._id);
                      } else setReleaseNotice(`Correction draft created: ${correction._id}`);
                    }),
                  "Correction draft created.");
                }}>Create correction</button>}
                <button type="button" className={withdrawn ? "secondary" : "danger"} disabled={!canWrite || releaseBusy !== ""} onClick={() => {
                  const action = withdrawn ? "restore" : "withdraw";
                  const reason = window.prompt(`${withdrawn ? "Restore" : "Withdrawal"} reason`);
                  if (reason) void releaseAction(`${action}:${release.releaseId}`, () =>
                    adminApi(`${releasesPath}/${encodeURIComponent(release.releaseId)}/actions`, {
                      method: "POST",
                      body: JSON.stringify({ action, reason }),
                    }),
                  `Release ${action === "withdraw" ? "withdrawn" : "restored"}.`);
                }}>{withdrawn ? "Restore" : "Withdraw"}</button>
              </div>
            </div>
          </li>;
        })}
      </ol>}
    </section>
  </section>;
}

/** The lead block's picture, or a placeholder when the story has none or it can't be loaded. */
function CanvasImage({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="jw-block-image jw-block-placeholder" role="img" aria-label={src ? "Image could not be loaded" : "No image yet"}>
    <Icon name="image" size={28} /><small>{src ? "Image couldn't load" : "No image yet"}</small>
  </span>;
  return <img className="jw-block-image" src={src} alt="" onError={() => setFailed(true)} />;
}

function OriginalSources({
  story,
  disabled,
  onChange,
}: {
  story: PublicationPresentationStory;
  disabled: boolean;
  onChange: (sources: PublicationEditorialSource[]) => void;
}) {
  return <fieldset id={`edition-sources-${encodeURIComponent(story.id)}`} data-editorial-correction disabled={disabled}>
    <legend>Original story sources for {story.headline}</legend>
    {story.source_metadata.map((source, index) => <div className="editorial-source" key={source.id}>
      <select aria-label={`Source type ${index + 1} for ${story.headline}`} value={source.type} onChange={(event) => {
        const sources = story.source_metadata.map((candidate) => candidate.id === source.id
          ? { ...candidate, type: event.target.value as PublicationEditorialSource["type"], url: ["web", "document"].includes(event.target.value) ? candidate.url : null }
          : candidate);
        onChange(sources);
      }}>
        <option value="web">Web</option><option value="document">Document</option><option value="interview">Interview</option><option value="observation">Observation</option>
      </select>
      <input data-required-field={!source.name.trim()} aria-label={`Source name ${index + 1} for ${story.headline}`} maxLength={240} placeholder="Source name" value={source.name} onChange={(event) => onChange(story.source_metadata.map((candidate) => candidate.id === source.id ? { ...candidate, name: event.target.value } : candidate))} />
      {["web", "document"].includes(source.type) && <input data-required-field={!storySources([{ name: source.name, url: source.url ?? "" }]).length} aria-label={`Source URL ${index + 1} for ${story.headline}`} maxLength={4096} type="url" placeholder="https://" value={source.url ?? ""} onChange={(event) => onChange(story.source_metadata.map((candidate) => candidate.id === source.id ? { ...candidate, url: event.target.value } : candidate))} />}
      <input aria-label={`Source note ${index + 1} for ${story.headline}`} maxLength={1000} placeholder="Context or verification note" value={source.note ?? ""} onChange={(event) => onChange(story.source_metadata.map((candidate) => candidate.id === source.id ? { ...candidate, note: event.target.value } : candidate))} />
      <button type="button" className="secondary" onClick={() => onChange(story.source_metadata.filter((candidate) => candidate.id !== source.id))}>Remove source {index + 1}</button>
    </div>)}
    <button type="button" className="secondary"
      onClick={() => onChange([...story.source_metadata, { id: crypto.randomUUID(), type: "web", name: "", url: null, note: null }])}>Add source</button>
  </fieldset>;
}

function PublicationBeeEditor({ game, onSave, onDirty }: {
  game: PublicationDraft["presentation"]["save_the_bee"];
  onSave: (game: NonNullable<PublicationDraft["presentation"]["save_the_bee"]> | null) => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
}) {
  const [included, setIncluded] = useState(Boolean(game));
  const [busy, setBusy] = useState(false);
  useEffect(() => () => onDirty(false), [onDirty]);
  return <form aria-label="Optional Save the Bee" aria-busy={busy} inert={busy}
    onInput={() => onDirty(true)} onChange={() => onDirty(true)}
    onReset={() => { setIncluded(Boolean(game)); onDirty(false); }}
    onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      setBusy(true);
      try {
        if (await onSave(included ? { word: String(values.get("word") ?? ""), clue: String(values.get("clue") ?? "") } : null)) {
          form.reset();
        }
      } finally { setBusy(false); }
    }}>
    <label><input type="checkbox" checked={included} onChange={(event) => setIncluded(event.target.checked)} /> Include Save the Bee in this edition</label>
    <div hidden={!included}>
      <label>Game word<input name="word" defaultValue={game?.word ?? ""} disabled={!included} required={included}
        minLength={3} maxLength={12} pattern="[A-Za-z]{3,12}" autoComplete="off" /></label>
      <label>Game hint<textarea name="clue" defaultValue={game?.clue ?? ""} disabled={!included} required={included}
        minLength={8} maxLength={180} rows={2} /></label>
      <p>Use 3-12 letters and an 8-180 character hint without the answer. Players reveal letters through the existing game.</p>
    </div>
    <div className="card-actions">
      <button type="submit" disabled={busy}>{busy ? "Saving game..." : "Save game choice"}</button>
      <button type="reset" className="secondary" disabled={busy}>Cancel game changes</button>
    </div>
  </form>;
}

function ImageEditor({
  publicationPath,
  story,
  image,
  revision,
  beforeSave,
  editing,
  onSaved,
  onError,
  onSaving,
}: {
  publicationPath: string;
  story: PublicationPresentationStory;
  image?: PublicationDraftImage;
  revision: MutableRefObject<number>;
  beforeSave: () => Promise<void>;
  editing: boolean;
  onSaved: (result: { draft: PublicationDraft; image?: PublicationDraftImage }) => void;
  onError: (error: unknown, retry: () => Promise<void>) => void;
  onSaving: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async (payload: Record<string, unknown>) => {
    onSaving();
    setBusy(true);
    try {
      await beforeSave();
      const result = await adminApi<{ draft: PublicationDraft; image: PublicationDraftImage }>(`${publicationPath}/images`, {
        method: "POST",
        body: JSON.stringify({ storyId: story.id, expectedRevision: revision.current, image: payload }),
      });
      onSaved(result);
    } catch (error) {
      onError(error, () => submit(payload));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    onSaving();
    setBusy(true);
    try {
      await beforeSave();
      const result = await adminApi<{ draft: PublicationDraft }>(`${publicationPath}/images`, {
        method: "DELETE",
        body: JSON.stringify({ imageId: image!._id, expectedRevision: revision.current }),
      });
      onSaved(result);
    } catch (error) {
      onError(error, remove);
    } finally {
      setBusy(false);
    }
  };
  return <details id={`edition-image-${encodeURIComponent(story.id)}`} data-editorial-correction className="editorial-image" aria-label={`Image for ${story.headline}`} aria-busy={busy}>
    <summary>{image ? `Image: ${image.image.image_credit}` : "Add a rights-cleared image"}</summary>
    {image ? <>
      <img src={image.image.image} alt={image.image.image_alt ?? image.image.image_caption ?? ""} />
      <p>{image.image.image_caption} · {image.image.image_credit} · {image.image.image_license}</p>
      {editing && <button type="button" className="secondary" aria-label={`Remove image for ${story.headline}`} disabled={busy} onClick={() => void remove()}>{busy ? "Removing…" : "Remove image"}</button>}
    </> : editing ? <form inert={busy} onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      void submit({
        image: form.get("image"),
        image_source_url: form.get("source"),
        image_credit: form.get("credit"),
        image_caption: form.get("caption"),
        image_alt: form.get("alt"),
        image_date: form.get("date"),
        image_license: form.get("license"),
        image_license_url: form.get("licenseUrl") || undefined,
        authority: form.get("authority") === "on",
        people_permissions: form.get("peoplePermissions") === "on",
        permission: {
          editorial: form.get("editorial") === "on",
          archive: form.get("archive") === "on",
          crop: form.get("crop") === "on",
        },
      });
    }}>
      <div className="filters">
        <label>Image URL<input aria-label={`Image URL for ${story.headline}`} name="image" type="url" required placeholder="https://" /></label>
        <label>Source URL<input aria-label={`Image source URL for ${story.headline}`} name="source" type="url" required placeholder="https://" /></label>
        <label>Credit<input aria-label={`Image credit for ${story.headline}`} name="credit" required maxLength={240} /></label>
        <label>Capture date<input aria-label={`Image capture date for ${story.headline}`} name="date" type="date" required /></label>
        <label>License<input aria-label={`Image license for ${story.headline}`} name="license" required defaultValue="Used with permission" maxLength={100} /></label>
        <label>License URL<input aria-label={`Image license URL for ${story.headline}`} name="licenseUrl" type="url" placeholder="Required for licensed images" /></label>
      </div>
      <label>Factual caption<input aria-label={`Image caption for ${story.headline}`} name="caption" required maxLength={500} /></label>
      <label>Alt text<input aria-label={`Image alt text for ${story.headline}`} name="alt" required maxLength={500} /></label>
      <div className="editorial-rights">
        <label><input name="authority" type="checkbox" required /> I own or am authorized to use this image.</label>
        <label><input name="peoplePermissions" type="checkbox" required /> Required permissions from depicted people are confirmed.</label>
        <label><input name="editorial" type="checkbox" required /> Editorial use</label>
        <label><input name="archive" type="checkbox" required /> Archive use</label>
        <label><input name="crop" type="checkbox" required /> Resize/crop</label>
      </div>
      <button type="submit" aria-label={`Save and attach image for ${story.headline}`} disabled={busy}>{busy ? "Saving image…" : "Save and attach image"}</button>
    </form> : <p>No image is attached.</p>}
  </details>;
}

function PrivateNotes({
  publicationPath,
  storyId,
  editing,
  draftRevision,
  beforeSave,
  onDraftSaved,
  onPersistenceChange,
}: {
  publicationPath: string;
  storyId: string;
  editing: boolean;
  draftRevision: MutableRefObject<number>;
  beforeSave: () => Promise<void>;
  onDraftSaved: (draft: PublicationDraft) => void;
  onPersistenceChange: (key: string, state: SaveState | null) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [notes, setNotes] = useState<PublicationInterviewNote[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const result = await adminApi<{ notes: PublicationInterviewNote[] }>(`${publicationPath}/notes?storyId=${encodeURIComponent(storyId)}`);
      setNotes(result.notes);
      setLoaded(true);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return <details className="editorial-notes" aria-busy={busy} onToggle={(event) => {
    if (event.currentTarget.open && !loaded) void load();
  }}>
    <summary>Private interview notes</summary>
    <p className="chart-caption">Private notes are stored separately and never enter preview, release JSON or default generation inputs.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    {!loaded && !error && <p>Open to load private notes.</p>}
    {notes.map((note) => <InterviewNoteEditor key={`${note._id}:${note.revision}`} note={note} disabled={!editing}
      onSaved={(updated) => setNotes((current) => current.map((candidate) => candidate._id === updated._id ? updated : candidate))}
      onDeleted={() => setNotes((current) => current.filter((candidate) => candidate._id !== note._id))}
      path={publicationPath} storyId={storyId} draftRevision={draftRevision}
      beforeSave={beforeSave} onDraftSaved={onDraftSaved} onPersistenceChange={onPersistenceChange} />)}
    {editing && <form className="editorial-note-form" inert={busy} onSubmit={async (event) => {
      event.preventDefault();
      const element = event.currentTarget;
      const form = new FormData(element);
      const saveKey = `note:${storyId}:new`;
      onPersistenceChange(saveKey, { state: "saving" });
      setBusy(true);
      try {
        await beforeSave();
        const result = await adminApi<{ note: PublicationInterviewNote; draft: PublicationDraft }>(`${publicationPath}/notes`, {
          method: "POST",
          body: JSON.stringify({
            storyId,
            expectedDraftRevision: draftRevision.current,
            note: { interviewee: form.get("interviewee"), interviewedAt: form.get("interviewedAt"), body: form.get("body") },
          }),
        });
        onDraftSaved(result.draft);
        setNotes((current) => [result.note, ...current]);
        element.reset();
        setError("");
        onPersistenceChange(saveKey, null);
      } catch (cause) {
        setError(errorText(cause));
        onPersistenceChange(saveKey, { state: "error", detail: errorText(cause) });
      } finally {
        setBusy(false);
      }
    }}>
      <div className="filters">
        <label>Interviewee<input name="interviewee" required maxLength={240} /></label>
        <label>Interview date<input name="interviewedAt" required type="date" /></label>
      </div>
      <label>Private notes<textarea name="body" required rows={5} maxLength={20_000} /></label>
      <button type="submit" disabled={busy}>Add private note</button>
    </form>}
  </details>;
}

function InterviewNoteEditor({
  note,
  disabled,
  path,
  storyId,
  onSaved,
  onDeleted,
  draftRevision,
  beforeSave,
  onDraftSaved,
  onPersistenceChange,
}: {
  note: PublicationInterviewNote;
  disabled: boolean;
  path: string;
  storyId: string;
  onSaved: (note: PublicationInterviewNote) => void;
  onDeleted: () => void;
  draftRevision: MutableRefObject<number>;
  beforeSave: () => Promise<void>;
  onDraftSaved: (draft: PublicationDraft) => void;
  onPersistenceChange: (key: string, state: SaveState | null) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saveKey = `note:${storyId}:${note._id}`;
  return <form className="editorial-note-card" inert={busy} aria-busy={busy} onSubmit={async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onPersistenceChange(saveKey, { state: "saving" });
    setBusy(true);
    try {
      await beforeSave();
      const result = await adminApi<{ note: PublicationInterviewNote; draft: PublicationDraft }>(`${path}/notes`, {
        method: "PATCH",
        body: JSON.stringify({
          storyId,
          noteId: note._id,
          expectedDraftRevision: draftRevision.current,
          expectedNoteRevision: note.revision,
          note: { interviewee: form.get("interviewee"), interviewedAt: form.get("interviewedAt"), body: form.get("body") },
        }),
      });
      onDraftSaved(result.draft);
      onPersistenceChange(saveKey, null);
      onSaved(result.note);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
      onPersistenceChange(saveKey, { state: "error", detail: errorText(cause) });
    } finally {
      setBusy(false);
    }
  }}>
    {error && <p className="alert" role="alert">{error}</p>}
    <div className="filters">
      <label>Interviewee<input name="interviewee" disabled={disabled} defaultValue={note.interviewee} required /></label>
      <label>Interview date<input name="interviewedAt" disabled={disabled} type="date" defaultValue={note.interviewed_at} required /></label>
    </div>
    <label>Private notes<textarea name="body" disabled={disabled} defaultValue={note.body} rows={5} required /></label>
    {!disabled && <div className="card-actions">
      <button type="submit" disabled={busy}>Save note</button>
      <button type="button" className="secondary" disabled={busy} onClick={async () => {
        onPersistenceChange(saveKey, { state: "saving" });
        setBusy(true);
        try {
          await beforeSave();
          const result = await adminApi<{ deleted: true; draft: PublicationDraft }>(`${path}/notes`, {
            method: "DELETE",
            body: JSON.stringify({
              storyId,
              noteId: note._id,
              expectedDraftRevision: draftRevision.current,
              expectedNoteRevision: note.revision,
            }),
          });
          onDraftSaved(result.draft);
          onPersistenceChange(saveKey, null);
          onDeleted();
        } catch (cause) {
          setError(errorText(cause));
          onPersistenceChange(saveKey, { state: "error", detail: errorText(cause) });
        } finally {
          setBusy(false);
        }
      }}>Delete note</button>
    </div>}
  </form>;
}
