import type { PublicationReleasePayloadV1 } from "../../../../shared/publication-release";

export const EMAIL_PREFERENCES_PLACEHOLDER = "{{preferences_url}}";
export const EMAIL_UNSUBSCRIBE_PLACEHOLDER = "{{unsubscribe_url}}";

export type PublicationEmailContent = {
  subject: string;
  html: string;
  text: string;
  renderer_version: "publication-email-v1";
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  })[character]!);
}

function readerRoot() {
  return (process.env.NEWSBEE_READER_SITE_URL ?? "http://127.0.0.1:4321/reader").replace(/\/$/, "");
}

export function publicationReleaseUrl(release: PublicationReleasePayloadV1) {
  return `${readerRoot()}/publications/${encodeURIComponent(release.publication.id)}/releases/${encodeURIComponent(release.release_id)}`;
}

export function renderPublicationReleaseEmail(release: PublicationReleasePayloadV1): PublicationEmailContent {
  const releaseUrl = publicationReleaseUrl(release);
  const stories = release.items.map((item) => ({
    headline: item.headline.replace(/\s+/g, " ").trim(),
    blurb: item.blurb.trim(),
    url: `${releaseUrl}?story=${encodeURIComponent(item.item_id)}`,
  }));
  const textStories = stories.map((story) => `${story.headline}\n${story.blurb}\n${story.url}`).join("\n\n");
  const htmlStories = stories.map((story) =>
    `<article><h2><a href="${escapeHtml(story.url)}">${escapeHtml(story.headline)}</a></h2><p>${escapeHtml(story.blurb)}</p></article>`,
  ).join("\n");
  const footerText = `Manage preferences: ${EMAIL_PREFERENCES_PLACEHOLDER}\nUnsubscribe: ${EMAIL_UNSUBSCRIBE_PLACEHOLDER}`;
  const footerHtml = `<p><a href="${EMAIL_PREFERENCES_PLACEHOLDER}">Manage email preferences</a> · <a href="${EMAIL_UNSUBSCRIBE_PLACEHOLDER}">Unsubscribe</a></p>`;
  return {
    renderer_version: "publication-email-v1",
    subject: release.title.replace(/\s+/g, " ").trim(),
    text: `${release.publication.display_name}\n\n${release.title}\n\n${release.intro}\n\n${textStories}\n\nRead this release: ${releaseUrl}\n\n${footerText}\n`,
    html: `<main><p>${escapeHtml(release.publication.display_name)}</p><h1>${escapeHtml(release.title)}</h1><p>${escapeHtml(release.intro)}</p>${htmlStories}<p><a href="${escapeHtml(releaseUrl)}">Read this release</a></p>${footerHtml}</main>`,
  };
}

export function personalizePublicationEmail(
  content: PublicationEmailContent,
  links: { preferencesUrl: string; unsubscribeUrl: string },
) {
  const replace = (value: string) => value
    .replaceAll(EMAIL_PREFERENCES_PLACEHOLDER, links.preferencesUrl)
    .replaceAll(EMAIL_UNSUBSCRIBE_PLACEHOLDER, links.unsubscribeUrl);
  return { subject: content.subject, html: replace(content.html), text: replace(content.text) };
}
