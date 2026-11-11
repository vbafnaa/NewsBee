import { sceneCanPlay, sceneGeometry, type CommunitySceneConfig, type ScenePoint, type SceneRegion } from "../../../../shared/community-scenes";
import { connectSceneInteraction } from "./community-scene-interaction";
import { connectSceneCast } from "./community-scene-cast";

const MAX_REGIONS = 6;
const FRAME_INTERVAL = 1000 / 24;
const VERTEX = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = vec2((a_position.x + 1.0) * 0.5, (1.0 - a_position.y) * 0.5);
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;
const FRAGMENT = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_art;
  uniform vec4 u_crop;
  uniform float u_time;
  uniform float u_energy;
  uniform vec3 u_pointer;
  uniform vec4 u_pulse;
  uniform vec4 u_breeze[6];
  uniform vec4 u_water[6];
  uniform vec4 u_warmth[6];
  float region(vec2 uv, vec4 area) {
    if (area.z <= 0.0 || area.w <= 0.0) return 0.0;
    return 1.0 - smoothstep(0.15, 1.0, length((uv - area.xy) / area.zw));
  }
  void main() {
    vec2 uv = u_crop.xy + v_uv * u_crop.zw;
    vec2 offset = vec2(0.0);
    float water = 0.0;
    float warmth = 0.0;
    vec2 reach = (uv - u_pointer.xy) * vec2(2.3, 1.0);
    float nearby = exp(-dot(reach, reach) * 18.0) * u_pointer.z;
    float gust = 1.0 + nearby * 0.9 + u_pulse.w * 0.8;
    for (int i = 0; i < 6; i++) {
      float wind = region(uv, u_breeze[i]);
      float phase = float(i) * 1.7;
      if (wind > 0.0) offset += wind * u_energy * gust * vec2(
        sin(u_time * 0.86 + uv.y * 23.0 + phase) * 0.0022,
        cos(u_time * 0.62 + uv.x * 19.0 + phase) * 0.0012
      );
      water = max(water, region(uv, u_water[i]));
      warmth = max(warmth, region(uv, u_warmth[i]));
    }
    offset += water * u_energy * vec2(
      sin(uv.y * 190.0 + u_time * 0.72) * 0.0024,
      sin(uv.x * 100.0 - u_time * 0.82) * 0.0016
    );
    float ripple = 0.0;
    if (water > 0.0 && u_pulse.z >= 0.0 && u_pulse.z < 3.0) {
      vec2 fromPulse = uv - u_pulse.xy;
      float distance = length(fromPulse * vec2(3.0, 1.0));
      float front = distance - u_pulse.z * 0.13;
      ripple = sin(distance * 115.0 - u_pulse.z * 9.0) * exp(-front * front * 130.0) * exp(-u_pulse.z * 0.9);
      offset += normalize(fromPulse + vec2(0.0001)) * ripple * water * 0.002;
    }
    vec3 color = texture2D(u_art, clamp(uv + offset, 0.0, 1.0)).rgb;
    float glint = pow(max(0.0, sin(uv.y * 390.0 + sin(uv.x * 24.0 + u_time * 0.3) - u_time * 0.5)), 12.0);
    color += water * (glint * 0.045 + ripple * 0.025) * vec3(0.8, 1.0, 1.0);
    color += warmth * (0.55 + nearby * 1.1 + 0.25 * sin(u_time * 0.38)) * vec3(0.055, 0.027, 0.0);
    gl_FragColor = vec4(color, 1.0);
  }
`;

function regionUniforms(regions: readonly SceneRegion[] = []) {
  const values = new Float32Array(MAX_REGIONS * 4);
  regions.slice(0, MAX_REGIONS).forEach((region, index) => values.set(region, index * 4));
  return values;
}

/** Deform only reviewed parts of the original painting; people and buildings remain still. */
function createRenderer(canvas: HTMLCanvasElement, poster: HTMLImageElement, config: CommunitySceneConfig) {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null, texture: WebGLTexture | null = null, buffer: WebGLBuffer | null = null;
  const dispose = () => {
    shaders.forEach(shader => gl.deleteShader(shader));
    if (program) gl.deleteProgram(program);
    if (texture) gl.deleteTexture(texture);
    if (buffer) gl.deleteBuffer(buffer);
  };
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Scene shader unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Scene shader unsupported");
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX), fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    program = gl.createProgram();
    if (!program) throw new Error("Scene program unavailable");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Scene program unsupported");
    gl.useProgram(program);
    buffer = gl.createBuffer();
    texture = gl.createTexture();
    if (!buffer || !texture) throw new Error("Scene resources unavailable");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(program, "u_art"), 0);
    gl.uniform1f(gl.getUniformLocation(program, "u_energy"), Math.max(0.5, Math.min(2, config.energy ?? 1)));
    gl.uniform4fv(gl.getUniformLocation(program, "u_breeze[0]"), regionUniforms(config.breeze));
    gl.uniform4fv(gl.getUniformLocation(program, "u_water[0]"), regionUniforms(config.water));
    gl.uniform4fv(gl.getUniformLocation(program, "u_warmth[0]"), regionUniforms(config.warmth));
    const time = gl.getUniformLocation(program, "u_time"), crop = gl.getUniformLocation(program, "u_crop");
    const pointerUniform = gl.getUniformLocation(program, "u_pointer"), pulseUniform = gl.getUniformLocation(program, "u_pulse");
    const pointer = new Float32Array([0.5, 0.5, 0]), target = new Float32Array(pointer), pulse = new Float32Array([0.5, 0.5, -1, 0]);
    let lastElapsed = 0, pulseStarted = -100;
    const updateTexture = () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, poster);
    updateTexture();
    return {
      resize(width: number, height: number, geometry: NonNullable<ReturnType<typeof sceneGeometry>>) {
        const ratio = Math.min(window.devicePixelRatio || 1, 1.5, 2160 / width);
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform4fv(crop, new Float32Array(geometry.crop));
      },
      draw(elapsed: number) {
        if (elapsed > lastElapsed) {
          for (let index = 0; index < 3; index++) pointer[index] += (target[index] - pointer[index]) * 0.15;
        }
        lastElapsed = elapsed;
        const age = elapsed - pulseStarted;
        pulse[2] = age < 3 ? age : -1;
        pulse[3] = age < 3 ? Math.exp(-age * 1.3) : 0;
        gl.uniform1f(time, elapsed);
        gl.uniform3fv(pointerUniform, pointer);
        gl.uniform4fv(pulseUniform, pulse);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      pointAt(point: ScenePoint | null) {
        if (point) { target[0] = point[0]; target[1] = point[1]; }
        target[2] = point ? 1 : 0;
      },
      pulse(point: ScenePoint) { pulse[0] = point[0]; pulse[1] = point[1]; pulseStarted = lastElapsed; },
      updateTexture, dispose,
    };
  } catch {
    dispose();
    return null;
  }
}

class CommunityScene extends HTMLElement {
  private poster: HTMLImageElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private backdrop: HTMLImageElement | null = null;
  private viewport: HTMLElement | null = null;
  private config: CommunitySceneConfig | null = null;
  private renderer: ReturnType<typeof createRenderer> = null;
  private visibility: IntersectionObserver | null = null;
  private resize: ResizeObserver | null = null;
  private preference: MediaQueryList | null = null;
  private interaction: ReturnType<typeof connectSceneInteraction> = null;
  private cast: ReturnType<typeof connectSceneCast> = null;
  private ready = false;
  private initializing = false;
  private tried = false;
  private visible = false;
  private paused = false;
  private frame = 0;
  private lastFrame = 0;
  private elapsed = 0;

  connectedCallback() { queueMicrotask(() => this.connect()); }

  private connect() {
    if (!this.isConnected || this.preference) return;
    this.poster = this.querySelector("img");
    this.canvas = this.querySelector("canvas");
    this.viewport = this.querySelector("[data-scene-frame]");
    try { this.config = JSON.parse(this.dataset.sceneConfig ?? "null"); } catch { return; }
    if (!this.poster || !this.canvas || !this.viewport || this.config?.version !== 1 || !window.ResizeObserver) return;
    this.preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.preference.addEventListener("change", this.update);
    document.addEventListener("visibilitychange", this.update);
    this.canvas.addEventListener("webglcontextlost", this.fallback);
    this.poster.addEventListener("load", this.refreshTexture);
    this.interaction = connectSceneInteraction(this, this.viewport, this.poster, this.config, {
      canInteract: () => this.ready && !this.preference?.matches && !this.paused && this.visible && !document.hidden,
      move: point => this.renderer?.pointAt(point),
      pulse: point => this.renderer?.pulse(point),
      resume: () => { if (this.ready && !this.preference?.matches) { this.paused = false; this.update(); } },
      pause: () => { this.paused = true; this.update(); },
    });
    this.cast = connectSceneCast(this, this.config.cast, {
      canInteract: () => this.ready && !this.preference?.matches && !this.paused && this.visible && !document.hidden,
      resume: () => { if (this.ready && !this.preference?.matches) { this.paused = false; this.update(); } },
    });
    this.resize = new ResizeObserver(this.measure);
    this.resize.observe(this.viewport);
    if (window.IntersectionObserver) {
      this.visibility = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        this.update();
      }, { threshold: 0.05 });
      this.visibility.observe(this);
    } else { this.visible = true; }
    this.update();
  }

  private initialize = async () => {
    if (this.initializing || this.tried || !this.poster || !this.canvas || !this.config) return;
    this.initializing = true;
    try {
      await this.poster.decode();
      if (this.dataset.sceneBackdrop) {
        this.backdrop = new Image();
        this.backdrop.src = this.dataset.sceneBackdrop;
        await this.backdrop.decode();
        if (this.backdrop.naturalWidth !== Number(this.poster.getAttribute("width"))
          || this.backdrop.naturalHeight !== Number(this.poster.getAttribute("height"))) {
          throw new Error("Community background dimensions must match the portrait");
        }
      }
      if (!this.isConnected) return;
      this.tried = true;
      this.renderer = createRenderer(this.canvas, this.backdrop ?? this.poster, this.config);
      this.ready = Boolean(this.renderer);
      if (this.ready) this.measure();
    } catch { this.fallback(); }
    finally { this.initializing = false; }
    this.update();
  };

  private measure = () => {
    const frame = this.viewport;
    if (!frame || !this.config || !this.poster) return;
    const { width, height } = frame.getBoundingClientRect();
    const geometry = sceneGeometry(this.poster.naturalWidth, this.poster.naturalHeight, width, height, this.config.focalPoint);
    if (!geometry) return;
    this.style.setProperty("--scene-art-width", `${geometry.imageWidth}px`);
    this.style.setProperty("--scene-art-height", `${geometry.imageHeight}px`);
    this.style.setProperty("--scene-art-left", `${geometry.left}px`);
    this.style.setProperty("--scene-art-top", `${geometry.top}px`);
    this.renderer?.resize(width, height, geometry);
    this.renderer?.draw(this.elapsed);
    this.cast?.measure(geometry);
  };

  private refreshTexture = () => {
    if (!this.renderer) return;
    try { this.renderer.updateTexture(); this.measure(); } catch { this.fallback(); }
  };

  private update = () => {
    const reducedMotion = this.preference?.matches ?? true;
    if (this.visible && !reducedMotion && !this.tried && !this.initializing) void this.initialize();
    const playing = sceneCanPlay({ ready: this.ready, reducedMotion, visible: this.visible,
      documentHidden: document.hidden, paused: this.paused });
    this.dataset.playing = String(playing);
    this.dataset.motion = this.ready && !reducedMotion ? "ready" : "static";
    this.dataset.scenePaused = String(this.paused);
    this.interaction?.setPlaying(playing);
    this.cast?.setAvailable(this.ready && !reducedMotion);
    this.cast?.setPlaying(playing);
    if (this.viewport && this.config?.interaction) {
      if (this.ready && !reducedMotion) {
        this.viewport.tabIndex = 0;
        this.viewport.setAttribute("role", "group");
        const action = this.config.interaction.kind === "water" ? "make a ripple" : "stir the leaves";
        this.viewport.setAttribute("aria-label", `${this.dataset.sceneName} portrait. Press Enter to ${action}; Escape to pause. Tab to explore the scene.`);
      } else {
        this.viewport.removeAttribute("tabindex");
        this.viewport.removeAttribute("role");
        this.viewport.removeAttribute("aria-label");
      }
    }
    if (playing && !this.frame) this.frame = requestAnimationFrame(this.draw);
    if (!playing) this.stop();
  };

  private draw = (timestamp: number) => {
    this.frame = 0;
    if (!this.ready || this.dataset.playing !== "true") return;
    if (!this.lastFrame || timestamp - this.lastFrame >= FRAME_INTERVAL) {
      if (this.lastFrame) this.elapsed += Math.min((timestamp - this.lastFrame) / 1000, 0.1);
      this.lastFrame = timestamp;
      this.renderer?.draw(this.elapsed);
    }
    this.frame = requestAnimationFrame(this.draw);
  };

  private stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastFrame = 0;
  }

  private fallback = () => {
    this.ready = false;
    this.tried = true;
    this.stop();
    this.renderer?.dispose();
    this.renderer = null;
    this.interaction?.dispose();
    this.interaction = null;
    this.cast?.dispose();
    this.cast = null;
    this.update();
  };

  disconnectedCallback() {
    this.stop();
    this.visibility?.disconnect();
    this.resize?.disconnect();
    this.preference?.removeEventListener("change", this.update);
    document.removeEventListener("visibilitychange", this.update);
    this.canvas?.removeEventListener("webglcontextlost", this.fallback);
    this.poster?.removeEventListener("load", this.refreshTexture);
    this.renderer?.dispose();
    this.interaction?.dispose();
    this.cast?.dispose();
    this.cast = null;
    this.backdrop = null;
    this.interaction = null;
    this.renderer = null;
    this.preference = null;
    this.ready = false;
    this.tried = false;
  }
}

export function registerCommunityScenes() {
  if (!customElements.get("community-scene")) customElements.define("community-scene", CommunityScene);
}
