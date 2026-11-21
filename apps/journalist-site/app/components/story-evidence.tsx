import type { EvidencePacket } from "@/pipeline/editions/evidence";

type EvidenceItem = {
  id: string;
  title: string;
  source_name: string;
  url: string | null;
  evidence?: EvidencePacket;
};

function EvidencePacketView({ packet }: { packet: EvidencePacket }) {
  return <>
    <p>Text: {packet.text_quality} · extraction: {packet.extraction.replaceAll("_", " ")}. Text volume is not a factual-quality score.</p>
    {packet.extraction_error && <p className="alert">{packet.extraction_error}</p>}
    {packet.missing.length > 0 && <p>Not established in structured details: {packet.missing.join(", ")}.</p>}
    {!packet.sources.length && <p>No source URL available for enrichment.</p>}
    {packet.facts?.map((fact, index) => <details key={`fact:${index}`}>
      <summary>{fact.field.replaceAll("_", " ")}: {fact.value}</summary>
      <blockquote>{fact.quote}</blockquote>
      <p>{fact.source_urls.length ? fact.source_urls.join(" · ") : "Supported by the collected title/description; no matching retrieved passage."}</p>
    </details>)}
    {packet.sources.map((source, index) => <details key={`${source.url}:${index}`}>
      <summary>{source.status}: {source.final_url ?? source.url}</summary>
      {source.reason && <p>{source.reason}</p>}
      {source.fetched_at && <p>Fetched: {source.fetched_at}{source.truncated ? " (text capped)" : ""}</p>}
      {source.content_hash && <p>Content SHA-256: <code>{source.content_hash}</code></p>}
      {source.passages.map((passage, position) => <blockquote key={position}>{passage}</blockquote>)}
    </details>)}
  </>;
}

export default function StoryEvidence({
  flags = [],
  sources = [],
  items = [],
  empty = "Not enriched (older run or outside the ranked shortlist)",
  direct = false,
}: {
  flags?: string[];
  sources?: Array<{ name: string; url: string | null }>;
  items?: EvidenceItem[];
  empty?: string;
  direct?: boolean;
}) {
  return <div className="story-evidence">
    {flags.length > 0 && <div className="evidence-flags" role="note">
      <strong>Review flags</strong>
      <ul>{flags.map((flag) => <li key={flag}>{flag}</li>)}</ul>
    </div>}
    {sources.length > 0 && <p><strong>Generated sources:</strong>{" "}
      {sources.map((source, index) => <span key={`${source.url ?? source.name}:${index}`}>
        {index > 0 && " · "}
        {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a> : source.name}
      </span>)}
    </p>}
    {direct && items.length === 1
      ? items[0].evidence ? <EvidencePacketView packet={items[0].evidence} /> : <p>{empty}</p>
      : items.length > 0 ? items.map((item) => <details key={item.id}>
      <summary>{item.source_name}: {item.title}</summary>
      {item.url && <p><a href={item.url} target="_blank" rel="noopener noreferrer">Open collected source</a></p>}
      {item.evidence ? <EvidencePacketView packet={item.evidence} /> : <p>{empty}</p>}
    </details>) : !flags.length && !sources.length ? <p>{empty}</p> : null}
  </div>;
}

export { EvidencePacketView };
