import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { parseHTML } from "linkedom";
import { connectSceneCast } from "../../../../reader-site/src/lib/community-scene-cast";
import { sceneCanPlay, sceneGeometry, scenePointAt, sceneRegionContains, sceneTargetBounds } from "../../../../../shared/community-scenes";
import { NEIGHBORHOOD_ART, neighborhoodArt, type NeighborhoodArt } from "../../../../../shared/neighborhood-illustrations";

describe("community motion profiles", () => {
  it("keeps local identity and effects scoped to their registered communities", () => {
    const wedgwood = neighborhoodArt("osm-r13915552-wa")!;
    const mosesLake = neighborhoodArt("moses-lake-wa")!;
    expect(wedgwood.motion?.water).toBeUndefined();
    expect(wedgwood.motion?.leaves?.length).toBeGreaterThan(0);
    expect(wedgwood.motion?.steam).toBeDefined();
    expect(wedgwood.motion?.interaction?.kind).toBe("breeze");
    expect(mosesLake.motion?.water?.length).toBeGreaterThan(0);
    expect(mosesLake.motion?.steam).toBeUndefined();
    expect(mosesLake.motion?.interaction?.kind).toBe("water");
    expect(mosesLake.motion?.boats?.length).toBeGreaterThan(0);
    expect(neighborhoodArt("another-community-wa")).toBeNull();
    expect(neighborhoodArt("wedgwood-wa")).toBe(wedgwood);
  });

  it("bounds effects in image space and keeps their uniform counts within the renderer's limit", () => {
    const ids = new Set<string>();
    for (const profile of NEIGHBORHOOD_ART as readonly NeighborhoodArt[]) {
      for (const id of profile.location_ids) { expect(ids.has(id)).toBe(false); ids.add(id); }
      const motion = profile.motion;
      if (!motion) continue;
      expect(motion.version).toBe(1);
      expect(motion.energy ?? 1).toBeGreaterThanOrEqual(0.5);
      expect(motion.energy ?? 1).toBeLessThanOrEqual(2);
      for (const value of motion.focalPoint) expect(value).toBeGreaterThanOrEqual(0);
      for (const value of motion.focalPoint) expect(value).toBeLessThanOrEqual(1);
      for (const regions of [motion.breeze, motion.water ?? [], motion.warmth ?? []]) {
        expect(regions.length).toBeLessThanOrEqual(6);
        for (const [x, y, rx, ry] of regions) {
          expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1);
          expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1);
          expect(rx).toBeGreaterThan(0); expect(rx).toBeLessThanOrEqual(1);
          expect(ry).toBeGreaterThan(0); expect(ry).toBeLessThanOrEqual(1);
        }
      }
      if (motion.interaction?.kind === "water") expect(sceneRegionContains(motion.interaction.origin, motion.water)).toBe(true);
      if (motion.interaction?.kind === "breeze") expect(sceneRegionContains(motion.interaction.origin, motion.breeze)).toBe(true);
      for (const boat of motion.boats ?? []) {
        expect(sceneRegionContains(boat.from, motion.water)).toBe(true);
        expect(sceneRegionContains(boat.to, motion.water)).toBe(true);
        expect(boat.duration).toBeGreaterThanOrEqual(20);
      }
    }
  });
});

describe("responsive scene composition", () => {
  it("preserves the full painting on desktop", () => {
    expect(sceneGeometry(2172, 724, 1086, 362)).toMatchObject({
      imageWidth: 1086, imageHeight: 362, left: 0, top: 0, crop: [0, 0, 1, 1],
    });
  });

  it("aligns the poster, texture and overlays around each community's mobile focal point", () => {
    for (const profile of NEIGHBORHOOD_ART as readonly NeighborhoodArt[]) {
      const focalPoint = profile.motion?.focalPoint ?? [0.5, 0.5];
      const result = sceneGeometry(2172, 724, 360, 202.5, focalPoint)!;
      expect(result.imageHeight).toBe(202.5);
      expect(result.imageWidth).toBe(607.5);
      expect(result.left).toBeCloseTo((360 - 607.5) * focalPoint[0]);
      expect(result.crop[0]).toBeCloseTo(-result.left / result.imageWidth);
      expect(result.crop[2]).toBeCloseTo(360 / result.imageWidth);
      expect(result.crop[0] + result.crop[2]).toBeLessThanOrEqual(1);
      expect(result.crop[3]).toBe(1);
    }
  });

  it("waits for a real layout instead of creating invalid drawing dimensions", () => {
    expect(sceneGeometry(2172, 724, 0, 200)).toBeNull();
    expect(sceneGeometry(2172, 724, 360, Number.NaN)).toBeNull();
    expect(sceneGeometry(2172, 724, 360, -1)).toBeNull();
  });

  it("keeps the local interaction reachable in wide and tall immersive compositions", () => {
    for (const profile of NEIGHBORHOOD_ART as readonly NeighborhoodArt[]) {
      const focus = profile.presentation?.focalPoint ?? profile.motion?.focalPoint ?? [0.5, 0.5];
      expect(focus.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
      const origin = profile.motion?.interaction?.origin;
      if (!origin) continue;
      for (const [width, height] of [[1920, 835], [1440, 882], [768, 820], [390, 666], [360, 594]]) {
        const geometry = sceneGeometry(2172, 724, width, height, focus)!;
        const x = geometry.left + origin[0] * geometry.imageWidth;
        const y = geometry.top + origin[1] * geometry.imageHeight;
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(width);
        expect(y).toBeGreaterThan(height * 0.15);
        expect(y).toBeLessThan(height * 0.8);
        const mapped = scenePointAt(x, y, width, height, geometry.crop)!;
        expect(mapped[0]).toBeCloseTo(origin[0]);
        expect(mapped[1]).toBeCloseTo(origin[1]);
      }
    }
  });

  it("keeps pointer and touch effects aligned with the mobile crop", () => {
    const profile = neighborhoodArt("moses-lake-wa")!;
    const geometry = sceneGeometry(2172, 724, 360, 202.5, profile.motion!.focalPoint)!;
    const point = scenePointAt(180, 202.5 * 0.59, 360, 202.5, geometry.crop)!;
    expect(point[0]).toBeCloseTo(geometry.crop[0] + geometry.crop[2] * 0.5);
    expect(point[1]).toBeCloseTo(0.59);
    expect(sceneRegionContains(point, profile.motion!.water)).toBe(true);
    expect(scenePointAt(0, 0, 0, 200, geometry.crop)).toBeNull();
    expect(scenePointAt(Number.NaN, 0, 360, 200, geometry.crop)).toBeNull();
  });

  it("does not create water ripples over the sky or neighborhood buildings", () => {
    const water = neighborhoodArt("moses-lake-wa")!.motion!.water;
    expect(sceneRegionContains([0.55, 0.59], water)).toBe(true);
    expect(sceneRegionContains([0.55, 0.25], water)).toBe(false);
    expect(sceneRegionContains([0.55, 0.49], water)).toBe(false);
    expect(sceneRegionContains([0.1, 0.65], water)).toBe(false);
  });
});

describe("motion policy", () => {
  const playing = { ready: true, reducedMotion: false, visible: true, documentHidden: false, paused: false };
  it("runs only while visible, supported and permitted by the reader", () => {
    expect(sceneCanPlay(playing)).toBe(true);
    for (const state of [{ ready: false }, { reducedMotion: true }, { visible: false }, { documentHidden: true }, { paused: true }]) {
      expect(sceneCanPlay({ ...playing, ...state })).toBe(false);
    }
  });

  it("removes interactive keyboard instructions when the graphics context is lost", async () => {
    const { window, document } = parseHTML(`<community-scene data-scene-config='${JSON.stringify(neighborhoodArt("wedgwood-wa")!.motion)}'>
      <figure data-scene-frame><img /><canvas></canvas></figure></community-scene>`);
    const observer = class {
      observe() {}
      disconnect() {}
    };
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("customElements", window.customElements);
    vi.stubGlobal("ResizeObserver", observer);
    vi.stubGlobal("IntersectionObserver", observer);
    window.matchMedia = query => ({
      media: query, matches: false, onchange: null,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      addListener() {}, removeListener() {},
    });
    try {
      const { registerCommunityScenes } = await import("../../../../reader-site/src/lib/community-scene");
      registerCommunityScenes();
      await Promise.resolve();
      const host = document.querySelector("community-scene")!;
      const frame = host.querySelector("figure")!;
      frame.setAttribute("tabindex", "0");
      frame.setAttribute("role", "group");
      frame.setAttribute("aria-label", "Press Enter to stir the leaves");
      host.querySelector("canvas")!.dispatchEvent(new window.Event("webglcontextlost"));
      expect(host.dataset.motion).toBe("static");
      expect(host.dataset.playing).toBe("false");
      expect(frame.hasAttribute("tabindex")).toBe(false);
      expect(frame.hasAttribute("role")).toBe(false);
      expect(frame.hasAttribute("aria-label")).toBe(false);
      host.remove();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("interactive scene casts", () => {
  it("ships matching background plates without replacing the static portraits", async () => {
    for (const profile of NEIGHBORHOOD_ART as readonly NeighborhoodArt[]) {
      const cast = profile.motion?.cast;
      if (!cast) continue;
      expect(cast.backdrop).toMatch(/^[a-z-]+-backdrop-v\d+\.webp$/);
      const file = fileURLToPath(new URL(`../../../../reader-site/public/illustrations/${cast.backdrop}`, import.meta.url));
      const { info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
      expect(info).toMatchObject({ width: 2172, height: 724 });
      expect(cast.backdrop).not.toBe(`${profile.asset}-v1.webp`);
    }
  });

  it("uses finite gestures with valid joints and restores every actor to its resting pose", () => {
    for (const profile of NEIGHBORHOOD_ART as readonly NeighborhoodArt[]) {
      const cast = profile.motion?.cast;
      if (!cast) continue;
      const actors = new Map(cast.actors.map(actor => [actor.id, actor]));
      expect(actors.size).toBe(cast.actors.length);
      expect(actors.size).toBeLessThanOrEqual(12);
      for (const actor of cast.actors) {
        expect(actor.outline.startsWith("M")).toBe(true);
        expect(actor.pivot.every(value => value >= 0 && value <= 1)).toBe(true);
        const parents = new Set([actor.id]);
        let parent = actor.parent;
        while (parent) {
          expect(parents.has(parent)).toBe(false);
          expect(actors.has(parent)).toBe(true);
          parents.add(parent); parent = actors.get(parent)?.parent;
        }
      }
      expect(new Set(cast.actions.map(action => action.id)).size).toBe(cast.actions.length);
      for (const action of cast.actions) {
        expect(action.label.length).toBeGreaterThan(0);
        expect(action.duration).toBeGreaterThanOrEqual(1000);
        expect(action.duration).toBeLessThanOrEqual(30000);
        expect(action.tracks.length).toBeGreaterThan(0);
        expect(new Set(action.tracks.map(track => track.actor)).size).toBe(action.tracks.length);
        for (const track of action.tracks) {
          expect(actors.has(track.actor)).toBe(true);
          expect(track.poses[0]).toMatchObject({ at: 0, x: 0, y: 0, rotation: 0, scale: 1 });
          expect(track.poses.at(-1)).toMatchObject({ at: 1, x: 0, y: 0, rotation: 0, scale: 1 });
          const restOpacity = actors.get(track.actor)!.restOpacity ?? 1;
          expect(track.poses[0].opacity ?? 1).toBe(restOpacity);
          expect(track.poses.at(-1)!.opacity ?? 1).toBe(restOpacity);
          for (let index = 0; index < track.poses.length; index++) {
            const pose = track.poses[index];
            expect(Object.values(pose).every(Number.isFinite)).toBe(true);
            if (index) expect(pose.at).toBeGreaterThan(track.poses[index - 1].at);
          }
        }
      }
    }
  });

  it("keeps the shore boat and street neighbors clickable in the phone crop", () => {
    for (const [id, actionId] of [["moses-lake-wa", "launch-boat"], ["wedgwood-wa", "high-five"]]) {
      const profile = neighborhoodArt(id)!;
      const action = profile.motion!.cast!.actions.find(action => action.id === actionId)!;
      const geometry = sceneGeometry(2172, 724, 390, 666, profile.presentation!.focalPoint)!;
      const target = sceneTargetBounds(action.region, geometry)!;
      expect(target).not.toBeNull();
      expect(target.left).toBeGreaterThanOrEqual(0);
      expect(target.left + target.width).toBeLessThanOrEqual(390);
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
  });

  it("takes the shore boat into the lake before returning to the bank", () => {
    const motion = neighborhoodArt("moses-lake-wa")!.motion!;
    const boat = motion.cast!.actors.find(actor => actor.id === "shore-boat")!;
    const pose = motion.cast!.actions[0].tracks[0].poses.find(pose => pose.at === .35)!;
    expect(sceneRegionContains([boat.pivot[0] + pose.x!, boat.pivot[1] + pose.y!], motion.water)).toBe(true);
    expect(pose.scale).toBeLessThan(1);
  });

  it("excludes fully cropped targets from keyboard navigation", () => {
    const geometry = sceneGeometry(2172, 724, 390, 666, [.5, .5])!;
    expect(sceneTargetBounds([.05, .5, .02, .05], geometry)).toBeNull();
    const clipped = sceneTargetBounds([geometry.crop[0], .5, .04, .05], geometry)!;
    expect(clipped.left).toBe(0);
    expect(clipped.width).toBeGreaterThanOrEqual(24);
  });
});

describe("scene action lifecycle", () => {
  function fixture() {
    const { document } = parseHTML('<community-scene><svg><g data-scene-actor="shore-boat"></g></svg><button data-scene-action="launch-boat" hidden></button></community-scene>');
    const host = document.querySelector("community-scene")! as unknown as HTMLElement;
    const animations: Animation[] = [];
    const animate = vi.fn(() => {
      let finish!: () => void, cancel!: (reason: Error) => void;
      const finished = new Promise<void>((resolve, reject) => { finish = resolve; cancel = reject; });
      const animation = { finished, play: vi.fn(), pause: vi.fn(), finish: vi.fn(finish), cancel: vi.fn(() => cancel(new Error("cancelled"))) } as unknown as Animation;
      animations.push(animation); return animation;
    });
    Object.defineProperty(host.querySelector("g"), "animate", { value: animate });
    const handlers = { canInteract: vi.fn(() => true), resume: vi.fn() };
    const cast = connectSceneCast(host, neighborhoodArt("moses-lake-wa")!.motion!.cast, handlers)!;
    cast.measure(sceneGeometry(2172, 724, 2172, 724)!);
    return { host, cast, animations, animate, handlers, button: host.querySelector("button")! };
  }

  it("blocks repeated triggers, pauses with the scene and becomes replayable after completion", async () => {
    const { host, cast, animations, animate, button } = fixture();
    button.click(); expect(animate).not.toHaveBeenCalled();
    cast.setAvailable(true); cast.setPlaying(true);
    button.click(); button.click();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(host.dataset.sceneActions).toBe("launch-boat");
    cast.setPlaying(false); expect(animations[0].pause).toHaveBeenCalledOnce();
    cast.setPlaying(true); expect(animations[0].play).toHaveBeenCalledOnce();
    animations[0].finish(); await Promise.resolve(); await Promise.resolve();
    expect(host.dataset.sceneActions).toBe("");
    expect(button.hasAttribute("aria-busy")).toBe(false);
    button.click(); expect(animate).toHaveBeenCalledTimes(2);
    cast.dispose();
    expect(animations[1].cancel).toHaveBeenCalledOnce();
    expect(button.hidden).toBe(true);
    button.click(); expect(animate).toHaveBeenCalledTimes(2);
  });

  it("cancels actions when motion is disabled and hides targets cropped out of view", async () => {
    const { host, cast, animations, animate, button } = fixture();
    cast.setAvailable(true); cast.setPlaying(true); button.click();
    cast.setAvailable(false);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(button.hidden).toBe(true);
    cast.setPlaying(false);
    expect(animations[0].pause).not.toHaveBeenCalled();
    await Promise.resolve(); await Promise.resolve();
    expect(host.dataset.sceneActions).toBe("");
    cast.setAvailable(true);
    cast.measure(sceneGeometry(2172, 724, 390, 666, [.95, .5])!);
    expect(button.hidden).toBe(true);
    button.click(); expect(animate).toHaveBeenCalledTimes(1);
    cast.dispose();
  });

  it("keeps a new gesture active when an older cancellation settles later", async () => {
    const { host, cast, button, animations } = fixture();
    cast.setAvailable(true); cast.setPlaying(true); button.click();
    cast.setAvailable(false);
    cast.setAvailable(true); cast.setPlaying(true); button.click();
    await Promise.resolve(); await Promise.resolve();
    expect(animations).toHaveLength(2);
    expect(host.dataset.sceneActions).toBe("launch-boat");
    expect(button.getAttribute("aria-busy")).toBe("true");
    cast.dispose();
  });
});
