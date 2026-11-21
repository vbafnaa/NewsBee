"use client";

export default function CampaignsError({ reset }: { reset: () => void }) {
  return (
    <section className="panel" role="alert">
      <h2>Campaign requests are unavailable</h2>
      <p>Newsbee could not load this operator-only view.</p>
      <button type="button" onClick={reset}>Try again</button>
    </section>
  );
}
