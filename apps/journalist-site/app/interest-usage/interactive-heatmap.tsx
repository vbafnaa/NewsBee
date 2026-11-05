"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { UsageRow } from "@/pipeline/analytics/usage";
import { clusterRows, constrainView, fitView, heatCells, locatedRows, MIN_WIDTH, project, transformView, type Metric, type Position, type View } from "@/lib/usage-map-geometry";
import LAND from "../../public/maps/land.json";

const COLORS = { reads: "#286b91", subscriptions: "#276749", interest: "#a65a17" };

export default function InteractiveHeatmap({ rows, metric, selected, onSelect }: {
  rows: UsageRow[]; metric: Metric; selected: string; onSelect: (id: string) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 440 });
  const [customView, setView] = useState<View | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const pointers = useRef(new Map<number, Position>());
  const gestureStart = useRef<Position | null>(null);
  const dragged = useRef(false);
  const chooser = useRef<HTMLHeadingElement>(null);
  const clip = useId().replaceAll(":", "");
  const help = useId();
  const located = useMemo(() => locatedRows(rows, metric), [rows, metric]);
  const initial = useMemo(() => fitView(located, size), [located, size]);
  const view = constrainView(customView ?? initial, size);
  const liveView = useRef(view);
  liveView.current = view;
  const updateView = (next: View) => { liveView.current = next; setView(next); };
  const heat = heatCells(located, metric, view);
  const maximum = Math.max(0, ...heat.cells.map((cell) => cell.count));
  const clusters = clusterRows(located, metric, view, size);
  const chosen = rows.find((row) => row.id === selected);
  const candidates = located.filter((row) => members.includes(row.id));
  const center = { x: size.width / 2, y: size.height / 2 };
  const zoom = (factor: number) => updateView(transformView(liveView.current, size, center, center, factor));

  useEffect(() => { if (members.length > 1) chooser.current?.focus(); }, [members]);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width > 0) setSize({ width, height: Math.max(320, Math.min(520, width * .55)) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      updateView(transformView(liveView.current, size, anchor, anchor, Math.exp(-Math.max(-100, Math.min(100, delta)) * .008)));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [size]);

  useEffect(() => {
    const row = located.find((item) => item.id === selected);
    if (!row) return;
    updateView(constrainView({ ...liveView.current, x: row.longitude, y: -row.latitude }, size));
  }, [selected, located, size]);

  return <div className="geo-heatmap interactive-heatmap">
    <div className="map-controls" role="group" aria-label="Map controls">
      <button type="button" onClick={() => zoom(2)} disabled={view.width <= MIN_WIDTH} aria-label="Zoom in">+ Zoom in</button>
      <button type="button" onClick={() => zoom(.5)} disabled={view.width >= Math.max(360, 180 * size.width / size.height)} aria-label="Zoom out">− Zoom out</button>
      <button type="button" className="secondary" onClick={() => { setView(null); setMembers([]); }}>Reset extent</button>
    </div>
    <p id={help} className="chart-caption">Drag to pan; scroll or pinch to zoom. Keyboard: focus the map, use arrow keys to pan, + / − to zoom, Home to reset. Select a numbered group to choose its communities.</p>
    <div ref={surface} className="interactive-map-surface" style={{ height: size.height }} tabIndex={0} role="group" aria-label={`Interactive ${metric} map`} aria-describedby={help}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (["+", "=", "-", "_", "Home", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault();
        if (event.key === "+" || event.key === "=") zoom(2);
        else if (event.key === "-" || event.key === "_") zoom(.5);
        else if (event.key === "Home") { setView(null); setMembers([]); }
        else if (event.key.startsWith("Arrow")) {
          const dx = event.key === "ArrowLeft" ? 80 : event.key === "ArrowRight" ? -80 : 0;
          const dy = event.key === "ArrowUp" ? 80 : event.key === "ArrowDown" ? -80 : 0;
          updateView(transformView(liveView.current, size, center, { x: center.x + dx, y: center.y + dy }));
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if (!pointers.current.size) { gestureStart.current = { x: event.clientX, y: event.clientY }; dragged.current = false; }
        else dragged.current = true;
        const target = (event.target as Element).closest("button") ?? event.currentTarget;
        target.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        if (gestureStart.current && Math.hypot(event.clientX - gestureStart.current.x, event.clientY - gestureStart.current.y) > 4) dragged.current = true;
        const before = [...pointers.current.values()];
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const after = [...pointers.current.values()];
        const midpoint = (points: Position[]) => points.length < 2 ? points[0] : { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        const old = midpoint(before), next = midpoint(after), bounds = event.currentTarget.getBoundingClientRect();
        const distance = (points: Position[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        const factor = before.length >= 2 && distance(before) > 0 ? Math.max(.1, distance(after) / distance(before)) : 1;
        updateView(transformView(liveView.current, size, { x: old.x - bounds.left, y: old.y - bounds.top }, { x: next.x - bounds.left, y: next.y - bounds.top }, factor));
      }}
      onPointerUp={(event) => pointers.current.delete(event.pointerId)}
      onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
      onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
      onClickCapture={(event) => {
        if (event.detail > 0 && dragged.current) { event.preventDefault(); event.stopPropagation(); dragged.current = false; }
      }}>
      <svg viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
        <defs><clipPath id={clip}><rect width={size.width} height={size.height} /></clipPath></defs>
        <rect width={size.width} height={size.height} fill="#eaf1f3" />
        <g clipPath={`url(#${clip})`}>
          {LAND.polygons.map((ring, index) => <polygon key={index} points={ring.map(([longitude, latitude]) => {
            const point = project(longitude, latitude, view, size); return `${point.x},${point.y}`;
          }).join(" ")} fill="#e3e9db" stroke="#a9b79e" strokeWidth=".7" />)}
          {heat.cells.map((cell) => {
            const point = project(cell.longitude, cell.latitude + heat.degrees, view, size);
            return <rect key={`${cell.longitude}:${cell.latitude}`} x={point.x} y={point.y} width={heat.degrees / view.width * size.width} height={heat.degrees / view.width * size.width} fill={COLORS[metric]} opacity={.25 + .65 * cell.count / maximum} />;
          })}
          {Array.from({ length: 5 }, (_, i) => {
            const x = size.width * (i + .5) / 5, y = size.height * (i + .5) / 5;
            return <g key={i} className="map-grid"><line x1={x} x2={x} y1="0" y2={size.height} /><line x1="0" x2={size.width} y1={y} y2={y} />
              <text x={x} y={size.height - 8} textAnchor="middle">{(view.x + (x - size.width / 2) * view.width / size.width).toFixed(3)}°</text>
              <text x="5" y={y - 4}>{(-view.y - (y - size.height / 2) * view.width / size.width).toFixed(3)}°</text></g>;
          })}
        </g>
      </svg>
      {clusters.filter((group) => group.x >= 0 && group.x <= size.width && group.y >= 0 && group.y <= size.height).map((group) => <button
        key={group.rows.map((row) => row.id).join("|")} type="button" className="map-marker"
        style={{ left: group.x, top: group.y, background: COLORS[metric] }}
        aria-pressed={group.rows.some((row) => row.id === selected)}
        aria-label={group.rows.length > 1 ? `${group.rows.length} communities: ${group.count} ${metric}. Choose a community` : `${group.rows[0].name}: ${group.count} ${metric}`}
        onClick={() => {
          setMembers(group.rows.map((row) => row.id));
          if (group.rows.length === 1) onSelect(group.rows[0].id);
        }}>{group.rows.length > 1 ? group.rows.length : <span aria-hidden="true">●</span>}</button>)}
    </div>
    <p className="chart-caption" role="status">{heat.degrees.toPrecision(3)}° cells · maximum {maximum.toLocaleString()} {metric} per cell. Numbered markers count communities, not events. <span className="heat-legend" style={{ background: `linear-gradient(to right, #eef2ef, ${COLORS[metric]})` }} /> Lower → higher. Grid cells are not community boundaries.</p>
    {candidates.length > 1 && <section className="map-chooser" aria-label="Communities in selected group">
      <h3 ref={chooser} tabIndex={-1}>{candidates.length} nearby or coincident communities</h3>
      <p>Choose exact counts below. Communities sharing coordinates remain individually selectable at every zoom level.</p>
      <button type="button" className="secondary" onClick={() => setView(fitView(candidates, size))}>Fit this group</button>
      <ul>{candidates.map((row) => <li key={row.id}><button type="button" className="secondary" aria-pressed={selected === row.id} onClick={() => onSelect(row.id)}>{row.name} · {row[metric].toLocaleString()} {metric}</button></li>)}</ul>
    </section>}
    {chosen && <div className="notice map-details" role="status"><strong>{chosen.name}</strong><p>{chosen.reads.toLocaleString()} edition reads · {chosen.subscriptions.toLocaleString()} subscription signups · {chosen.interest.toLocaleString()} interest signups</p>
      <p>{chosen.latitude === null || chosen.longitude === null ? "No saved coordinates. Counts are included in totals and the table." : `${chosen.latitude.toFixed(5)}, ${chosen.longitude.toFixed(5)} · saved community coordinates, not reader location.`}</p></div>}
    {!located.length && <p>No saved coordinates for this metric. Use the exact counts below.</p>}
    <p className="chart-caption">Low-resolution country context: <a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noreferrer">Natural Earth</a> (public domain). No external map services; local detail comes from community coordinates, not street tiles. Exact counts remain in the table regardless of viewport.</p>
  </div>;
}
