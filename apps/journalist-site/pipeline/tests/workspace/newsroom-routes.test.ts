import { describe, expect, it } from "vitest";
import {
  draftIdForPath, legacyNewsroomTarget, newsroomEditionHref, newsroomHref, newsroomTaskForPath,
} from "@/app/newsroom/newsroom-routes";
import { editionPipeline, generationNeedsAttention } from "@/app/newsroom/edition-pipeline";

const base = "/newsroom/room";

describe("journalist workspace routes", () => {
  it.each([
    ["/newsroom/room", null],
    ["/newsroom/room/new-edition", "new-edition"],
    ["/newsroom/room/editions", "editions"],
    ["/newsroom/room/editions/draft%2Bone", "writing"],
    ["/newsroom/room/generation", "activity"],
    ["/newsroom/room/videos", "videos"],
    ["/newsroom/room/releases/r1", "videos"],
    ["/newsroom/room/releases/r1/video/s1", "videos"],
    // Channels was removed; its old links land on Videos and New video.
    ["/newsroom/room/channels", "videos"],
    ["/newsroom/room/channels/new", "new-video"],
    ["/newsroom/room/new-video", "new-video"],
    ["/newsroom/room/admin", "admin"],
    ["/newsroom/room/source-map", "source-map"],
    ["/newsroom/room/edition-editor", "writing"],
    ["/newsroom/room/inbox", "inbox"],
    ["/newsroom/room/settings", "settings"],
    ["/newsroom/other/editions", null],
  ])("maps %s to its view", (path, task) => {
    expect(newsroomTaskForPath(path, base)).toBe(task);
  });

  it("reads and writes the edition editor URL", () => {
    expect(newsroomEditionHref("room", "draft+one")).toBe("/newsroom/room/editions/draft%2Bone");
    expect(draftIdForPath("/newsroom/room/editions/draft%2Bone", base)).toBe("draft+one");
    expect(draftIdForPath("/newsroom/room/editions", base)).toBeUndefined();
    expect(newsroomHref("room", "activity", "?generation=g")).toBe("/newsroom/room/generation?generation=g");
  });

  it.each([
    ["", "", null],
    ["", "#home", null],
    ["", "#overview", null],
    ["", "#needs-attention", null],
    ["", "#editions", "/newsroom/room/editions"],
    ["", "#settings", "/newsroom/room/settings"],
    ["", "#audience", "/newsroom/room/settings#audience"],
    ["", "#delivery", "/newsroom/room/settings#delivery"],
    ["", "#generation-activity", "/newsroom/room/generation"],
    ["?generation=g1", "", "/newsroom/room/generation?generation=g1"],
    ["?generation=g1", "#generation-activity", "/newsroom/room/generation?generation=g1"],
    ["?draft=d1", "#editorial-workspace-title", "/newsroom/room/editions/d1#editorial-workspace-title"],
    ["?draft=d1", "", "/newsroom/room/editions/d1"],
    ["?draft=d1&keep=yes", "#editions", "/newsroom/room/editions/d1?keep=yes"],
    ["?draft=d1", "#edition-story-s1", "/newsroom/room/editions/d1#edition-story-s1"],
    ["", "#reporting", "/newsroom/room/editions"],
    ["", "#publication-release-history-title", "/newsroom/room/editions"],
    ["", "#videos", "/newsroom/room/videos"],
  ])("redirects the older link %s%s", (search, hash, target) => {
    expect(legacyNewsroomTarget("room", search, hash)).toBe(target);
  });
});

describe("edition pipeline card", () => {
  const generation = (status: string, children: string[]) => ({
    status, progress: { total: children.length, completed: children.filter((child) => child === "built").length, failed: 0 },
    children: children.map((child) => ({ status: child })),
  });

  it("follows the slowest community through the four stages", () => {
    const running = editionPipeline(generation("running", ["authoring", "built"]));
    expect(running.stages.map((stage) => stage.state)).toEqual(["done", "current", "waiting", "waiting"]);
    expect(running.percent).toBe(50);
    expect(editionPipeline(generation("starting", [])).stages[0].state).toBe("current");
    expect(editionPipeline(generation("combining", ["built", "built"])).stages.map((stage) => stage.state))
      .toEqual(["done", "done", "done", "current"]);
    const ready = editionPipeline(generation("ready", ["built"]));
    expect(ready.percent).toBe(100);
    expect(ready.stages.every((stage) => stage.state === "done")).toBe(true);
  });

  it("marks stuck work instead of animating past it", () => {
    const blocked = generation("blocked", ["collecting", "failed"]);
    expect(generationNeedsAttention(blocked)).toBe(true);
    expect(editionPipeline(blocked).stages[0].state).toBe("failed");
    expect(generationNeedsAttention(generation("running", ["authoring"]))).toBe(false);
  });
});
