import { sceneTargetBounds, type SceneCast, type sceneGeometry } from "../../../../shared/community-scenes";

type CastHandlers = { canInteract(): boolean; resume(): void };
type Geometry = NonNullable<ReturnType<typeof sceneGeometry>>;

/** Runs reviewed, finite gestures using pieces of the original painting. */
export function connectSceneCast(host: HTMLElement, cast: SceneCast | undefined, handlers: CastHandlers) {
  if (!cast) return null;
  const actors = new Map([...host.querySelectorAll<SVGGElement>("[data-scene-actor]")].map(node => [node.dataset.sceneActor!, node]));
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-scene-action]")];
  const running = new Map<string, Animation[]>();
  let playing = false, available = false, geometry: Geometry | null = null;

  const measure = () => {
    for (const button of buttons) {
      const action = cast.actions.find(item => item.id === button.dataset.sceneAction);
      const bounds = action && geometry ? sceneTargetBounds(action.region, geometry) : null;
      button.hidden = !available || !bounds;
      if (bounds) Object.assign(button.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    }
  };
  const clear = (id: string, animations: Animation[]) => {
    if (running.get(id) !== animations) return;
    running.delete(id);
    buttons.find(button => button.dataset.sceneAction === id)?.removeAttribute("aria-busy");
    host.dataset.sceneActions = [...running.keys()].join(" ");
  };
  const cancelAll = () => {
    for (const [id, animations] of [...running]) {
      clear(id, animations);
      animations.forEach(animation => animation.cancel());
    }
  };
  const activate = (event: MouseEvent) => {
    const button = event.currentTarget as HTMLButtonElement;
    const action = cast.actions.find(item => item.id === button.dataset.sceneAction);
    if (!available || button.hidden || !action) return;
    handlers.resume();
    if (running.has(action.id)) return;
    if (!handlers.canInteract()) return;
    const animations: Animation[] = [];
    for (const track of action.tracks) {
      const actor = actors.get(track.actor);
      if (!actor) continue;
      const frames = track.poses.map(pose => ({ offset: pose.at,
        transform: `translate(${(pose.x ?? 0) * 2172}px, ${(pose.y ?? 0) * 724}px) rotate(${pose.rotation ?? 0}deg) scale(${pose.scale ?? 1})`,
        opacity: pose.opacity ?? 1,
        easing: "ease-in-out" }));
      animations.push(actor.animate(frames, { duration: action.duration, fill: "none" }));
    }
    if (!animations.length) return;
    running.set(action.id, animations);
    button.setAttribute("aria-busy", "true");
    host.dataset.sceneActions = [...running.keys()].join(" ");
    if (!playing) animations.forEach(animation => animation.pause());
    void Promise.all(animations.map(animation => animation.finished)).then(() => clear(action.id, animations), () => clear(action.id, animations));
  };
  for (const button of buttons) button.addEventListener("click", activate);
  return {
    measure(value: Geometry) { geometry = value; measure(); },
    setAvailable(value: boolean) {
      available = value; measure();
      if (!value) cancelAll();
    },
    setPlaying(value: boolean) {
      playing = value;
      for (const animations of running.values()) animations.forEach(animation => value ? animation.play() : animation.pause());
    },
    dispose() {
      for (const button of buttons) { button.removeEventListener("click", activate); button.hidden = true; }
      cancelAll(); delete host.dataset.sceneActions;
    },
  };
}
