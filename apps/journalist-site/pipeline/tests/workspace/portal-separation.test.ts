import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("role-scoped product portals", () => {
  it("keeps the Newsroom shell publication-scoped and free of privileged operations", async () => {
    const [shell, navigation] = await Promise.all([source("app/newsroom/newsroom-shell.tsx"), source("app/newsroom/newsroom-navigation.tsx")]);
    expect(shell).toContain("<span>Newsbee</span>");
    expect(navigation).toContain('aria-label="Newsroom navigation"');
    for (const label of ["Overview", "New source map", "New edition", "New video", "Source map", "Editions", "Videos", "Analytics", "Newsroom admin"]) {
      expect(navigation).toContain(`label: "${label}"`);
    }
    // Admin is one item for everyone, inside the newsroom; the Operations pages are never linked from the sidebar.
    expect(navigation).toContain('{ label: "Admin", items: [');
    for (const operations of ['"/health"', '"/drive-diagnostics"', '"/site-backup"', '"/account"']) expect(navigation).not.toContain(operations);
    for (const privileged of ["System health", "Clear data", "Users", "API settings", "Locations", "People", "Marketing"]) {
      expect(shell).not.toContain(privileged);
      expect(navigation).not.toContain(privileged);
    }
    expect(shell).toContain('{role !== "editor" && <Link className="jw-operations-link" href="/admin">');
    expect(navigation).toContain('name="publicationId"');
    expect(navigation).toContain("Newsroom workspace");
  });

  it("brands the operator portal and exposes the selected queue-first navigation", async () => {
    const [shell, overview, page, support] = await Promise.all([
      source("app/admin-navigation.tsx"),
      source("app/admin/admin-overview.tsx"),
      source("app/admin/page.tsx"),
      source("app/admin/publications/[publicationId]/page.tsx"),
    ]);
    expect(await source("app/admin-shell.tsx")).toContain("Newsbee Admin");
    expect(shell).toContain('aria-label="Admin navigation"');
    const navigation = ["Locations", "Newsrooms", "People", "Inbox", "Marketing", "System"];
    for (const label of navigation) {
      expect(shell).toContain(`label: "${label}"`);
    }
    for (let index = 1; index < navigation.length; index += 1) {
      expect(shell.indexOf(`label: "${navigation[index - 1]}"`)).toBeLessThan(shell.indexOf(`label: "${navigation[index]}"`));
    }
    expect(overview).toContain('href="/admin/campaigns"');
    expect(overview).toContain("campaign leads");
    expect(overview).not.toContain("Prepare coverage");
    expect(overview).not.toContain("admin-control-card");
    expect(page).toContain('<LocationDirectory owner={principal.role === "owner"} requested={requested} />');
    expect(support).toContain("requireOperatorPrincipal");
    expect(support).toContain('surface="admin"');
  });

  it("routes owners and admins to Admin while keeping editors publication-scoped", async () => {
    const [access, admin, newsroom, maps] = await Promise.all([
      source("lib/portal-access.ts"),
      source("app/admin/page.tsx"),
      source("app/newsroom/[publicationId]/layout.tsx"),
      source("lib/internal-session.ts"),
    ]);
    expect(access).toContain('role === "editor" ? "/newsroom" : "/admin"');
    expect(access).toContain('role === "owner" || role === "admin"');
    expect(access).toContain('if (!canAccessAdmin(principal.role)) redirect("/newsroom")');
    expect(admin).toContain("requireOperatorPrincipal");
    const context = await source("app/newsroom/[publicationId]/newsroom-context.ts");
    expect(newsroom).toContain("loadNewsroom(publicationId)");
    expect(context).toContain("requireSignedInPrincipal");
    expect(context).toContain("resolveOutputChannelForPrincipal(");
    expect(newsroom).toContain("Support and governance");
    expect(maps).toContain("isOperator(principal)");
  });

  it("redirects compatibility URLs into the correct product surface", async () => {
    const [locations, publishing, publication, release, administrators] = await Promise.all([
      source("app/locations/page.tsx"),
      source("app/publishing/page.tsx"),
      source("app/publishing/[channelId]/page.tsx"),
      source("app/publishing/[channelId]/releases/[releaseId]/page.tsx"),
      source("app/administrators/page.tsx"),
    ]);
    expect(locations).toContain("defaultPortal(principal.role)");
    expect(publishing).toContain('redirect("/newsroom")');
    expect(publication).toContain("redirect(`/newsroom/${encodeURIComponent(channelId)}");
    expect(publication).toContain("...(draft ? { draft } : {})");
    expect(publication).toContain("...(generation ? { generation } : {})");
    expect(release).toContain("redirect(`/newsroom/${encodeURIComponent(channelId)}/releases/${encodeURIComponent(releaseId)}`)");
    expect(administrators).toContain('redirect("/admin/access")');
  });

  it("admits operators to personal credential settings while keeping restore and destructive surfaces owner-only", async () => {
    const [accountPage, backupPage, clearPage, accountApi, backupApi] = await Promise.all([
      source("app/account/page.tsx"),
      source("app/site-backup/page.tsx"),
      source("app/clear-data/page.tsx"),
      source("app/api/account/settings/route.ts"),
      source("app/api/admin/site-backup/route.ts"),
    ]);
    expect(accountPage).toContain("requireOperatorPrincipal");
    expect(accountApi).toContain("operatorGuard");
    expect(accountApi).toContain("isConfiguredOwner(principal)");
    for (const page of [backupPage, clearPage]) expect(page).toContain("requireOwnerPrincipal");
    expect(backupApi).toContain("ownerGuard");
  });

  it("keeps Campaigns read-only and operator-scoped with contained CSV export", async () => {
    const [page, route, csv, leads] = await Promise.all([
      source("app/admin/campaigns/page.tsx"),
      source("app/api/admin/campaigns/route.ts"),
      source("app/api/admin/campaigns/export/route.ts"),
      source("pipeline/campaigns/leads.ts"),
    ]);
    expect(page).toContain("requireOperatorPrincipal");
    expect(page).toContain("Export matching CSV");
    expect(page).toContain('className="campaign-lead-list"');
    expect(page).toContain('className="campaign-attribution"');
    for (const api of [route, csv]) expect(api).toContain("operatorGuard");
    expect(route).not.toContain("export async function POST");
    expect(csv).not.toContain("export async function POST");
    expect(leads).toContain("csvCell");
    expect(leads).not.toContain("console.");
  });

  it("renders the selected Option A weekly workflow and existing editorial actions", async () => {
    const [workspace, generation, editorial, distribution, releaseVideo] = await Promise.all([
      source("app/newsroom/[publicationId]/layout.tsx"),
      source("app/publishing/publication-generation.tsx"),
      source("app/publishing/publication-editorial-workspace.tsx"),
      source("app/publishing/[channelId]/releases/[releaseId]/release-distribution.tsx"),
      source("app/publishing/[channelId]/releases/[releaseId]/video/[storyId]/release-video-manager.tsx"),
    ]);
    expect(workspace).toContain("Newsroom inspection");
    expect(workspace).toContain("<PublicationGeneration");
    expect(workspace).toContain('generationAnchorId="editions"');
    expect(workspace).toContain('reportingAnchorId="reporting"');
    expect(generation).toContain('aria-labelledby="reporting-title"');
    expect(generation).toContain("Generate draft");
    expect(generation).toContain("const draft = data.draft");
    expect(generation).toContain("<PublicationEditorialWorkspace");
    expect(generation).toMatch(/Generate a draft before adding reporting|Start writing/);
    expect(workspace.indexOf("<PublicationSourceFeedback")).toBeGreaterThan(workspace.indexOf('id="settings"'));
    expect(workspace).not.toContain('<section className="newsroom-anchor" id="reporting" aria-label="Reporting">\n      <PublicationSourceFeedback');
    expect(editorial.indexOf('id="editorial-workspace-title"')).toBeLessThan(editorial.indexOf('id="story-workspace-title"'));
    expect(editorial.indexOf('id="story-workspace-title"')).toBeLessThan(editorial.indexOf('<p className="eyebrow">Preview</p>'));
    expect(editorial.indexOf('<p className="eyebrow">Preview</p>')).toBeLessThan(editorial.indexOf('className="panel newsroom-step-panel editorial-ready editorial-publish"'));
    expect(editorial).toContain("Generated evidence and flags");
    expect(editorial).toContain("Preview web");
    expect(editorial).toContain("Approve revision");
    expect(editorial).toContain("Publish to web");
    expect(distribution).toContain(">Create video</Link>");
    expect(releaseVideo).toContain("Desktop Video · MiniMax H3 · 15 seconds · 9:16 portrait");
    expect(releaseVideo).toContain("15 seconds · 9:16 portrait");
    expect(releaseVideo).toContain("Newsbee-managed Desktop Video is provided by the newsroom; no personal API settings are required.");
    expect(releaseVideo).toContain("Download the MP4 from Google Drive");
    expect(releaseVideo).toContain(">Generate replacement</button>");
    expect(releaseVideo).toContain("<progress");
    expect(releaseVideo).toContain("window.setTimeout");
    expect(releaseVideo).not.toContain("window.setInterval");
    expect(releaseVideo).toContain("video.status === \"complete\" && video.drive_file_id && <video");
  });

  it("keeps Desktop readiness and non-secret release usage reachable inside System", async () => {
    const [delivery, route, usage] = await Promise.all([
      source("app/newsletter/newsletter-delivery.tsx"),
      source("app/api/admin/newsletter/route.ts"),
      source("lib/release-video-usage.ts"),
    ]);
    expect(delivery).toContain("Desktop Video readiness and usage");
    const system = await source("app/health/page.tsx");
    expect(system).toContain('<NewsletterDelivery videoOnly />');
    expect(system).toContain('href="/health?view=video"');
    expect(delivery).toContain("Credential values, credential owner IDs, and credential versions are never returned here.");
    expect(route).toContain("releaseVideoStatus(deps)");
    for (const field of ["statuses", "providers", "funding", "auditEvents"]) expect(usage).toContain(field);
    expect(usage).toContain('role: { $regex: "^release-video-" }');
    expect(usage).not.toContain("credential_owner_id");
    expect(usage).not.toContain("credential_version");
  });

  it("uses the light Inter and Roboto portal theme with compact overflow-safe mobile navigation", async () => {
    const styles = await source("app/styles.css");
    const optionA = styles.slice(styles.indexOf("/* Option A product portals"));
    expect(optionA).toContain('font-family: "Newsbee Inter"');
    expect(optionA).toContain('font-family: "Newsbee Roboto"');
    expect(optionA).toContain("background: #f7f6f2");
    expect(optionA).toContain(".portal-shell .sidebar {");
    expect(optionA).toContain("background: var(--color-surface)");
    expect(optionA).toContain(".edition-hero");
    expect(optionA).toContain(".admin-readiness-summary");
    expect(optionA).toContain("@media (max-width: 390px)");
    expect(optionA).toContain("@media (max-width: 320px)");
    expect(optionA).toMatch(/\.portal-shell \.portal-primary-nav \{[\s\S]*flex-wrap: nowrap;[\s\S]*overflow-x: auto;/);
    expect(optionA).not.toContain("background: #193e31");
  });

  it("keeps publication lifecycle and story controls in the operator support view", async () => {
    const [channels, support, management] = await Promise.all([
      source("app/publishing/channels.tsx"),
      source("app/admin/publications/[publicationId]/page.tsx"),
      source("app/admin/publications/newsroom-management.tsx"),
    ]);
    expect(management).toContain('"Confirm archive" : "Confirm restore"');
    expect(management).toContain('lifecycleRevision: channel.lifecycleRevision');
    expect(support).toContain('canDelete={principal.role === "owner"}');
    expect(channels).toContain('surface === "admin" && <details><summary>Advanced legacy maintenance</summary>');
    expect(channels).toContain('channel.canWrite && (!channel.supportExpiresAt || channel.supportExpiresAt > now)');
    expect(channels).toContain("`/admin/publications/${encodeURIComponent(channel.id)}`");
    expect(channels).toContain("`/newsroom/${encodeURIComponent(channel.id)}`");
  });
});
