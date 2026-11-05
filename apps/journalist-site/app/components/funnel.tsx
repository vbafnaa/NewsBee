"use client";

export type FunnelStep = { step: string; label: string; count: number; previous?: number | null };

/** The edition funnel: each step's count, its share of the first step, and the change from the previous edition. */
export default function Funnel({ steps, selected, onSelect }: { steps: FunnelStep[]; selected?: string | null; onSelect?: (step: string | null) => void }) {
  const top = Math.max(1, ...steps.map((step) => step.count));
  return <ol className="funnel" aria-label="How the edition was made">
    {steps.map((step) => <li key={step.step}>
      {onSelect ? <button type="button" aria-pressed={selected === step.step} onClick={() => onSelect(selected === step.step ? null : step.step)}>{step.label}</button> : <span>{step.label}</span>}
      <span className="bar" style={{ width: `${Math.max(2, Math.round(step.count / top * 100))}%` }} aria-hidden="true" />
      <span><strong>{step.count}</strong>{typeof step.previous === "number" && <span className="delta"> {step.count >= step.previous ? "+" : "−"}{Math.abs(step.count - step.previous)} vs last</span>}</span>
    </li>)}
  </ol>;
}
