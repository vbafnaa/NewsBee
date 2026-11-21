"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AccessPublication } from "@/pipeline/accounts/access-policy";

type Role = "owner" | "admin" | "editor";
type Account = {
  principalId: string;
  email: string;
  role: Role;
  enabled: boolean;
  revision: number;
  publicationIds: string[];
  passwordStatus?: "setup_required" | "invited" | "expired" | "credentials_set";
  recoveryStatus?: "pending" | "expired" | null;
};
type Publication = AccessPublication;
type Snapshot = {
  actor: { id: string; email: string; role: "owner" | "admin" };
  accounts: Account[];
  publications: Publication[];
};
type LinkResult = { principalId: string; kind: "signup" | "recovery"; url: string; expiresAt: string };

function AccountLink({ result }: { result: LinkResult }) {
  const ref = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState("");
  const [copyError, setCopyError] = useState("");
  const [expired, setExpired] = useState(() => Date.now() >= Date.parse(result.expiresAt));
  useEffect(() => {
    ref.current?.focus();
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(result.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [result]);
  async function copy() {
    setFeedback(""); setCopyError("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Select and copy the link manually.");
      await navigator.clipboard.writeText(result.url);
      setFeedback("Link copied.");
    } catch {
      setCopyError("Could not copy the link. Select and copy it manually.");
    }
  }
  return <div className="notice" ref={ref} tabIndex={-1} aria-label={`${result.kind} link result`}>
    <p role="status">{expired ? "Link expired." : `Single-use ${result.kind} link ready.`} No email sent.
      {" "}Expires {new Date(result.expiresAt).toLocaleString()}. Issuing another link replaces it.</p>
    {!expired && <label className="field">Share manually
      <input aria-label={`${result.kind} link`} readOnly value={result.url} onFocus={(event) => event.currentTarget.select()} />
    </label>}
    <button className="secondary" type="button" disabled={expired} onClick={() => void copy()}>Copy link</button>
    {feedback && <p role="status">{feedback}</p>}
    {copyError && <p role="alert">{copyError}</p>}
  </div>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function accessRequest<T>(input?: RequestInit): Promise<T> {
  const response = await fetch("/api/admin/access", {
    cache: "no-store",
    ...input,
    headers: input?.body ? { "Content-Type": "application/json", ...input.headers } : input?.headers,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data as T;
}

function assignmentNames(account: Account, publications: Publication[]) {
  return account.publicationIds
    .map((id) => {
      const publication = publications.find((publication) => publication.id === id);
      return publication ? publicationLabel(publication) : id;
    })
    .join(", ");
}

function publicationLabel(publication: Publication) {
  return `${publication.name}${publication.archivedAt != null ? " (archived)" : publication.enabled ? "" : " (paused)"}`;
}

function SetupStatus({ account }: { account: Account }) {
  const labels = {
    setup_required: "Username/password not set",
    invited: "Setup link issued (not yet completed)",
    expired: "Setup link expired",
    credentials_set: "Username/password credentials set",
  };
  return <p>{labels[account.passwordStatus ?? "setup_required"]}
    {account.recoveryStatus === "pending" ? " · Recovery link pending" : account.recoveryStatus === "expired" ? " · Recovery link expired" : ""}
  </p>;
}

function EditorCard({
  account,
  actor,
  publications,
  busy,
  onChange,
  onDelete,
  onInvite,
  onRecover,
  link,
  publicationId,
}: {
  account: Account;
  actor: Snapshot["actor"];
  publications: Publication[];
  busy: boolean;
  onChange: (update: Partial<Pick<Account, "role" | "enabled" | "publicationIds">>, confirmation?: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onInvite: () => Promise<void>;
  onRecover: () => Promise<void>;
  link?: LinkResult;
  publicationId?: string;
}) {
  return <article className="access-account-card">
    <div className="access-account-heading">
      <div>
        <h3>{account.email}</h3>
        {actor.id === account.principalId && <p>Signed in as this account · <a href="/account/security">Password &amp; sign-in</a></p>}
        <p><span className={`status-badge ${account.enabled ? "tone-ok" : ""}`}>{account.enabled ? "Enabled" : "Disabled"}</span></p>
        <SetupStatus account={account} />
      </div>
    </div>
    <p>Newsrooms: {assignmentNames(account, publications) || "None assigned"}</p>
    {link && <AccountLink key={link.url} result={link} />}
    <details className="access-account-actions">
      <summary aria-label={`Manage access for ${account.email}`}>Manage access</summary>
      <div className="card-actions">
        {actor.role === "owner" && <button
          className="secondary"
          type="button"
          disabled={busy || !account.enabled}
          onClick={() => void onChange(
            { role: "admin" },
            `Promote ${account.email} to Admin? Their editor publication assignments will be removed. Admin support access is privileged and audited; owner-only credentials, restore and destructive controls remain unavailable.`,
          )}
        >Promote to Admin</button>}
        <button
          className="secondary"
          type="button"
          disabled={busy || !account.enabled}
          onClick={() => void (account.passwordStatus === "credentials_set" ? onRecover() : onInvite())}
        >{account.passwordStatus === "credentials_set" ? "Create recovery link" : "Create signup link"}</button>
        <button
          className={account.enabled ? "danger" : "secondary"}
          type="button"
          disabled={busy}
          onClick={() => void onChange(
            { enabled: !account.enabled },
            account.enabled
              ? `Disable ${account.email}? Sign-in and newsroom access stop immediately. Existing newsroom assignments are preserved and return if the journalist is re-enabled.`
              : undefined,
          )}
        >{account.enabled ? "Disable journalist" : "Re-enable journalist"}</button>
        <button
          className="danger"
          type="button"
          disabled={busy}
          onClick={() => void onDelete()}
        >Delete permanently</button>
      </div>
      <PublicationAssignments key={account.revision} account={account} publications={publications} busy={busy} publicationId={publicationId}
        onSave={(publicationIds) => onChange({ publicationIds })} />
    </details>
  </article>;
}

function PublicationAssignments({ account, publications, busy, onSave, publicationId }: {
  account: Account;
  publications: Publication[];
  busy: boolean;
  onSave: (ids: string[]) => Promise<void>;
  publicationId?: string;
}) {
  const [selected, setSelected] = useState(account.publicationIds);
  const archived = publications.filter((publication) => publication.archivedAt != null);
  const choices = (rooms: Publication[]) => rooms.map((publication) => <label className="checkbox-label" key={publication.id}>
    <input type="checkbox" checked={selected.includes(publication.id)} onChange={(event) => setSelected((current) =>
      event.target.checked ? [...current, publication.id] : current.filter((id) => id !== publication.id))} />
    <span>{publicationLabel(publication)}</span>
  </label>);
  return <fieldset className="access-publications" disabled={busy || !account.enabled}>
    <legend>Newsroom assignments</legend>
    {publicationId && <p>Requested newsroom: {publications.find((publication) => publication.id === publicationId)?.name}. Select it below and save to assign; opening this page changes nothing.</p>}
    <div className="access-publication-grid">
      {choices(publications.filter((publication) => publication.archivedAt == null))}
    </div>
    {archived.length > 0 && <details open={archived.some((publication) => publication.id === publicationId) || undefined}>
      <summary>Archived newsrooms &amp; legacy destinations ({archived.length})</summary>
      <p>Existing assignments are retained unless you change them and save.</p>
      <div className="access-publication-grid">{choices(archived)}</div>
    </details>}
    {!publications.length && <p>No newsrooms are configured.</p>}
    <button type="button" disabled={busy || selected.slice().sort().join() === account.publicationIds.slice().sort().join()}
      onClick={() => void onSave(selected)}>Save newsroom assignments</button>
  </fieldset>;
}

export default function AccessManagement({ publicationId, email }: { publicationId?: string; email?: string } = {}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [links, setLinks] = useState<Record<string, LinkResult>>({});
  const newsroom = snapshot?.publications.find((publication) => publication.id === publicationId);
  function forgetLink(principalId: string) {
    setLinks((current) => {
      const next = { ...current };
      delete next[principalId];
      return next;
    });
  }

  const load = useCallback(async (preserveError = false) => {
    try {
      setSnapshot(await accessRequest<Snapshot>());
      if (!preserveError) setError("");
    } catch (cause) {
      setError((current) => preserveError && current
        ? `${current} Latest account data could not be refreshed: ${message(cause)}`
        : message(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email") ?? "");
    setBusy("new"); setError(""); setNotice("");
    try {
      const result = await accessRequest<{
        account: Account;
        invitation: { signupUrl: string; expiresAt: string };
      }>({
        method: "POST",
        body: JSON.stringify({ email }),
      });
      form.reset();
      setSnapshot((current) => current && ({ ...current, accounts: [...current.accounts, result.account] }));
      setLinks((current) => ({ ...current, [result.account.principalId]: {
        principalId: result.account.principalId, kind: "signup", url: result.invitation.signupUrl, expiresAt: result.invitation.expiresAt,
      } }));
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  }

  async function remove(account: Account) {
    if (!window.confirm(
      `Permanently delete ${account.email}? This removes login credentials, invitations, publication memberships, personal credentials, and active upload state. The action cannot be undone.`,
    )) return;
    setBusy(account.principalId); setError(""); setNotice("");
    forgetLink(account.principalId);
    try {
      await accessRequest<{ account: Pick<Account, "principalId" | "email"> }>({
        method: "DELETE",
        body: JSON.stringify({
          targetPrincipalId: account.principalId,
          expectedRevision: account.revision,
        }),
      });
      setNotice(`Account permanently deleted for ${account.email}.`);
      await load();
    } catch (cause) {
      setError(message(cause));
      await load(true);
    } finally {
      setBusy("");
    }
  }

  async function invite(account: Account) {
    setBusy(account.principalId); setError(""); setNotice("");
    forgetLink(account.principalId);
    try {
      const result = await accessRequest<{
        invitation: { signupUrl: string; expiresAt: string };
      }>({
        method: "POST",
        body: JSON.stringify({
          targetPrincipalId: account.principalId,
          expectedRevision: account.revision,
        }),
      });
      setLinks((current) => ({ ...current, [account.principalId]: {
        principalId: account.principalId, kind: "signup", url: result.invitation.signupUrl, expiresAt: result.invitation.expiresAt,
      } }));
      await load();
    } catch (cause) {
      setError(message(cause));
      await load(true);
    } finally {
      setBusy("");
    }
  }

  async function recover(account: Account) {
    setBusy(account.principalId); setError(""); setNotice("");
    forgetLink(account.principalId);
    try {
      const result = await accessRequest<{ recovery: { resetUrl: string; expiresAt: string } }>({
        method: "POST",
        body: JSON.stringify({
          action: "password-reset", targetPrincipalId: account.principalId, expectedRevision: account.revision,
        }),
      });
      setLinks((current) => ({ ...current, [account.principalId]: {
        principalId: account.principalId, kind: "recovery", url: result.recovery.resetUrl, expiresAt: result.recovery.expiresAt,
      } }));
      await load();
    } catch (cause) {
      setError(message(cause));
      await load(true);
    } finally {
      setBusy("");
    }
  }

  async function update(account: Account, changes: Partial<Pick<Account, "role" | "enabled" | "publicationIds">>, confirmation?: string) {
    if (confirmation && !window.confirm(confirmation)) return;
    setBusy(account.principalId); setError(""); setNotice("");
    if (changes.role !== undefined || changes.enabled !== undefined) forgetLink(account.principalId);
    try {
      await accessRequest<{ account: Account }>({
        method: "PATCH",
        body: JSON.stringify({
          targetPrincipalId: account.principalId,
          expectedRevision: account.revision,
          ...changes,
        }),
      });
      setNotice(`Access updated for ${account.email}.`);
      await load();
    } catch (cause) {
      setError(message(cause));
      await load(true);
    } finally {
      setBusy("");
    }
  }

  const grouped = (role: Role) => snapshot?.accounts.filter((account) => account.role === role) ?? [];
  const TeamRoster = snapshot?.actor.role === "owner" ? "div" : "details";
  const journalists = snapshot && <section className="access-role-section" aria-labelledby="access-editor-title">
    <h2 id="access-editor-title">Journalists</h2>
    {grouped("editor").map((account) => <EditorCard
      account={account} actor={snapshot.actor} busy={Boolean(busy)} key={account.principalId}
      onChange={(changes, confirmation) => update(account, changes, confirmation)}
      onDelete={() => remove(account)} onInvite={() => invite(account)} onRecover={() => recover(account)}
      publications={snapshot.publications} link={links[account.principalId]} publicationId={newsroom?.id}
    />)}
    {!grouped("editor").length && <p>No journalists yet.</p>}
  </section>;
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!snapshot && !error && <p role="status">Loading access policies…</p>}
    {!snapshot && error && <button type="button" onClick={() => void load()}>Retry</button>}
    {snapshot && <>
      <p>Signed in as <strong>{snapshot.actor.email}</strong> · {snapshot.actor.role === "owner" ? "Owner" : "Admin"} · <a href="/account/security">Password &amp; sign-in</a></p>
      {newsroom && <p className="notice">People for <a href={`/newsroom/${encodeURIComponent(newsroom.id)}`}>{newsroom.name}</a>. Add or select a journalist, then deliberately save their newsroom assignments. Setup links do not grant assignments.</p>}
      {publicationId && !newsroom && <p className="alert" role="alert">The requested newsroom is unavailable. No assignment has been selected or changed.</p>}
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Add journalist</h2>
          </div>
        </div>
        <form className="admin-form" onSubmit={(event) => void addEditor(event)}>
          <label className="field" htmlFor="access-email">Journalist email
            <input id="access-email" name="email" type="email" required maxLength={254} autoComplete="email" placeholder="journalist@example.com" defaultValue={email ?? ""} />
          </label>
          <button type="submit" disabled={Boolean(busy)}>Add journalist</button>
        </form>
      </section>
      {snapshot.actor.role !== "owner" && journalists}
      <details className="admin-page-help">
        <summary>Role permissions</summary>
        <p>The owner is always enabled and cannot be reassigned, demoted or disabled. Admins manage editors, not peer admins or owner-only settings.</p>
        <p>Journalists need a deliberate newsroom assignment. Assigned admins have journalist access; other publication writes require reasoned, audited support.</p>
        <p>New editors have no publication assignments. Disabling an account preserves assignments; re-enabling restores access.</p>
      </details>

      <TeamRoster>
      {snapshot.actor.role !== "owner" && <summary>Owner and Admins (read-only team context)</summary>}
      <section className="access-role-section" aria-labelledby="access-owner-title">
        <h2 id="access-owner-title">Owner</h2>
        {grouped("owner").map((account) => <article className="access-account-card" key={account.principalId}>
          <div className="access-account-heading"><div><h3>{account.email}</h3><p><span className="status-badge tone-ok">Enabled</span> · Owner</p></div></div>
          <SetupStatus account={account} />
          {snapshot.actor.id === account.principalId && <p><a href="/account/security">Password &amp; sign-in</a></p>}
          <p>Publication ownership: {assignmentNames(account, snapshot.publications) || "No publications owned yet."}</p>
        </article>)}
      </section>

      <section className="access-role-section" aria-labelledby="access-admin-title">
        <h2 id="access-admin-title">Admins</h2>
        {grouped("admin").map((account) => <article className="access-account-card" key={account.principalId}>
          <div className="access-account-heading">
            <div><h3>{account.email}</h3><p><span className={`status-badge ${account.enabled ? "tone-ok" : ""}`}>{account.enabled ? "Enabled" : "Suspended"}</span></p><SetupStatus account={account} /></div>
          </div>
          <p>Publications: {assignmentNames(account, snapshot.publications) || "None assigned"}</p>
          {links[account.principalId] && <AccountLink key={links[account.principalId].url} result={links[account.principalId]} />}
          {snapshot.actor.role === "owner" && <details className="access-account-actions">
            <summary aria-label={`Manage access for ${account.email}`}>Manage access</summary>
            <div className="card-actions">
              <button className="secondary" type="button" disabled={Boolean(busy) || !account.enabled}
                onClick={() => void recover(account)}>Create {account.passwordStatus === "credentials_set" ? "recovery" : "password setup"} link</button>
              <button
                className={account.enabled ? "danger" : "secondary"}
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void update(account, { enabled: !account.enabled }, account.enabled
                  ? `Suspend ${account.email}? Their next guarded request will be denied. Their Admin role, publication ownership and memberships are preserved. Sponsored active runs are blocked and will not reconnect automatically after reactivation.`
                  : `Reactivate ${account.email}? Their Admin access returns with existing publication ownership and memberships. Blocked sponsored runs will not reconnect or restart automatically.`)}
              >{account.enabled ? "Suspend admin" : "Reactivate admin"}</button>
              <button
                className="danger"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void update(account, { role: "editor" }, `Demote ${account.email} to Journalist? Deliberate publication assignments are preserved; global operator access is removed.`)}
              >Change to Journalist</button>
              <button
                className="danger"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void remove(account)}
              >Delete permanently</button>
            </div>
            <PublicationAssignments key={`${account.principalId}:${account.revision}`}
              account={account} publications={snapshot.publications} busy={Boolean(busy)}
              publicationId={newsroom?.id}
              onSave={(ids) => update(account, { publicationIds: ids })} />
          </details>}
        </article>)}
        {!grouped("admin").length && <p className="panel">No team admins configured.</p>}
      </section>
      </TeamRoster>
      {snapshot.actor.role === "owner" && journalists}
    </>}
  </>;
}
