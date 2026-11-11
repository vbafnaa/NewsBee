import { sceneGeometry, scenePointAt, sceneRegionContains, type CommunitySceneConfig, type ScenePoint } from "../../../../shared/community-scenes";

type InteractionHandlers = {
  canInteract(): boolean;
  move(point: ScenePoint | null): void;
  pulse(point: ScenePoint): void;
  resume(): void;
  pause(): void;
};
const SVG = "http://www.w3.org/2000/svg";

/** Pointer effects are decorative; keyboard gestures provide the same breeze or ripple. */
export function connectSceneInteraction(host: HTMLElement, frame: HTMLElement, poster: HTMLImageElement,
  config: CommunitySceneConfig, handlers: InteractionHandlers) {
  const interaction = config.interaction;
  if (!interaction) return null;
  const effects = new Map<Animation, SVGElement>();
  const waterLayer = host.querySelector<SVGGElement>("[data-water-effects]");
  const breezeLayer = host.querySelector<SVGGElement>("[data-breeze-effects]");
  let playing = false, lastTrail = -Infinity, lastPulse = -Infinity, sequence = 0;
  let pressed: { x: number; y: number; time: number } | null = null;

  const pointAt = (x: number, y: number) => {
    const rect = frame.getBoundingClientRect();
    const geometry = sceneGeometry(poster.naturalWidth, poster.naturalHeight, rect.width, rect.height, config.focalPoint);
    return geometry ? scenePointAt(x - rect.left, y - rect.top, rect.width, rect.height, geometry.crop) : null;
  };
  const animate = (node: SVGGElement, frames: Keyframe[], duration: number, root: SVGElement = node) => {
    const animation = node.animate(frames, { duration, easing: "ease-out", fill: "forwards" });
    effects.set(animation, root);
    const release = () => { effects.delete(animation); root.remove(); };
    animation.onfinish = release;
    animation.oncancel = release;
    if (!playing) animation.pause();
  };
  const ripple = (point: ScenePoint) => {
    if (!waterLayer) return;
    const node = document.createElementNS(SVG, "g");
    node.setAttribute("transform", `translate(${point[0] * 2172} ${point[1] * 724})`);
    const rings = document.createElementNS(SVG, "g");
    for (const [rx, ry, opacity] of [[48, 14, 0.85], [70, 21, 0.5], [91, 28, 0.25]]) {
      const ellipse = document.createElementNS(SVG, "ellipse");
      ellipse.setAttribute("rx", String(rx)); ellipse.setAttribute("ry", String(ry));
      ellipse.setAttribute("fill", "none"); ellipse.setAttribute("stroke", "#f7fbef");
      ellipse.setAttribute("stroke-width", "2.4"); ellipse.setAttribute("opacity", String(opacity));
      rings.append(ellipse);
    }
    node.append(rings); waterLayer.append(node);
    animate(rings, [{ transform: "scale(.28)", opacity: 0 }, { transform: "scale(.65)", opacity: 1, offset: 0.18 },
      { transform: "scale(1.7)", opacity: 0 }], 2300, node);
  };
  const leaves = (point: ScenePoint) => {
    if (!breezeLayer || !config.breeze.length) return;
    const closest = [...config.breeze].sort((a, b) => (a[0] - point[0]) ** 2 + (a[1] - point[1]) ** 2
      - ((b[0] - point[0]) ** 2 + (b[1] - point[1]) ** 2))[0];
    const x = Math.max(closest[0] - closest[2] * 0.55, Math.min(closest[0] + closest[2] * 0.55, point[0]));
    const y = Math.max(closest[1] - closest[3] * 0.4, Math.min(closest[1] + closest[3] * 0.4, point[1]));
    for (let index = 0; index < 6; index++) {
      const node = document.createElementNS(SVG, "g");
      node.setAttribute("transform", `translate(${x * 2172 + index * 9 - 24} ${y * 724 + index * 3})`);
      const leaf = document.createElementNS(SVG, "path");
      leaf.setAttribute("d", "M0-13C14-11 17 1 0 13C-12 5-14-7 0-13Z");
      leaf.setAttribute("fill", config.leaves?.[index % config.leaves.length]?.color ?? "#b99a48");
      leaf.setAttribute("fill-opacity", ".82");
      leaf.setAttribute("stroke", "#867247"); leaf.setAttribute("stroke-width", ".8");
      node.append(leaf); breezeLayer.append(node);
      const direction = Math.sin((sequence + index) * 2.4);
      animate(node, [
        { transform: `translate(${x * 2172 + index * 9 - 24}px, ${y * 724}px) rotate(-20deg)`, opacity: 0 },
        { opacity: 0.95, offset: 0.12 },
        { transform: `translate(${x * 2172 + 110 * direction}px, ${y * 724 + 180 + index * 14}px) rotate(${100 + index * 31}deg)`, opacity: 0 },
      ], 2500 + index * 170);
    }
    sequence++;
  };
  const emit = (point: ScenePoint, trail = false) => {
    const count = interaction.kind === "water" ? 1 : 6;
    if (!handlers.canInteract() || effects.size + count > 18) return;
    if (interaction.kind === "water" && !sceneRegionContains(point, config.water)) return;
    const now = performance.now();
    if (now - lastPulse < (trail ? 450 : 180)) return;
    lastPulse = now;
    handlers.pulse(point);
    if (interaction.kind === "water") ripple(point); else leaves(point);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !handlers.canInteract()) return;
    const point = pointAt(event.clientX, event.clientY);
    if (!point) return;
    handlers.move(point);
    if (interaction.kind === "water" && performance.now() - lastTrail > 550 && sceneRegionContains(point, config.water)) {
      lastTrail = performance.now(); emit(point, true);
    }
  };
  const leave = () => { pressed = null; handlers.move(null); };
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    pressed = { x: event.clientX, y: event.clientY, time: performance.now() };
  };
  const up = (event: PointerEvent) => {
    if (!pressed) return;
    const tap = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 12 && performance.now() - pressed.time < 600;
    pressed = null;
    const point = tap ? pointAt(event.clientX, event.clientY) : null;
    if (point && !(event.target instanceof Element && event.target.closest("[data-scene-action]"))) {
      handlers.resume(); emit(point);
    }
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); handlers.pause(); }
    if (event.target !== frame) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); handlers.resume(); emit(interaction.origin);
    }
  };
  frame.addEventListener("pointermove", move, { passive: true });
  frame.addEventListener("pointerleave", leave);
  frame.addEventListener("pointerdown", down, { passive: true });
  frame.addEventListener("pointerup", up, { passive: true });
  frame.addEventListener("pointercancel", leave);
  frame.addEventListener("keydown", key);
  return {
    setPlaying(value: boolean) {
      playing = value;
      for (const animation of effects.keys()) value ? animation.play() : animation.pause();
    },
    dispose() {
      frame.removeEventListener("pointermove", move); frame.removeEventListener("pointerleave", leave);
      frame.removeEventListener("pointerdown", down); frame.removeEventListener("pointerup", up);
      frame.removeEventListener("pointercancel", leave); frame.removeEventListener("keydown", key);
      for (const animation of [...effects.keys()]) animation.cancel();
      effects.clear();
    },
  };
}
