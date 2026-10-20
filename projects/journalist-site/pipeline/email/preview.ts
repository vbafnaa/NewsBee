export type EmailPreviewContent = { subject: string; text: string; html: string };
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[char]!); }
/** Stage 2 creates a preview artifact only; it never sends email. */
export function previewContent(locationName: string, locationId: string, edition: { headline: string; intro: string; email?: { blurb?: string } }, websiteUrl = "http://127.0.0.1:4321") {
  const headline = edition.headline.trim().split(/\s+/).join(" ");
  const link = `${websiteUrl.replace(/\/$/, "")}/?location=${encodeURIComponent(locationId)}`;
  const blurb = edition.email?.blurb ?? `See what is happening around ${locationName.split(",")[0]} this week in the new edition.`;
  const text = `${headline}\n\n${edition.intro}\n\n${blurb}\n\nRead the full ${locationName} edition: ${link}\n`;
  const html = `<h1>${escapeHtml(headline)}</h1>\n<p>${escapeHtml(edition.intro)}</p>\n<p>${escapeHtml(blurb)}</p>\n<p><a href="${escapeHtml(link)}">Read the full ${escapeHtml(locationName)} edition</a></p>\n`;
  return { subject: headline, text, html } satisfies EmailPreviewContent;
}
