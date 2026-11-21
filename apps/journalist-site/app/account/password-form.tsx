"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

type Details = { username: string | null; credentialsSet?: boolean; email?: string; expiresAt?: string };

export default function PasswordForm({ recovery = false }: { recovery?: boolean }) {
  const token = useRef("");
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const endpoint = recovery ? "/api/auth/password-reset" : "/api/account/password";

  const load = useCallback(async () => {
    setError("");
    try {
      if (recovery && !token.current) throw new Error("Open the complete recovery link shared by your operator.");
      const response = await fetch(endpoint, recovery ? {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "inspect", token: token.current }),
      } : { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? "Password details could not be loaded");
      setDetails(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Password details could not be loaded");
    }
  }, [endpoint, recovery]);

  useEffect(() => {
    if (recovery && window.location.hash) {
      token.current = window.location.hash.slice(1);
      window.history.replaceState(null, "", window.location.pathname);
    }
    void load();
  }, [load, recovery]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    if (password !== data.get("confirmation")) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(recovery ? { token: token.current } : { currentPassword: String(data.get("currentPassword") ?? "") }),
          password,
          ...(details?.username ? {} : { username: String(data.get("username") ?? "") }),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? "Password could not be saved");
      form.reset();
      token.current = "";
      setComplete(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Password could not be saved");
    } finally {
      setBusy(false);
    }
  }

  if (complete) return <p className="notice" role="status">Password saved. All existing Newsbee sessions are revoked. <Link href="/login">Sign in again</Link> with your username or approved Google account.</p>;
  if (!details) return <>
    <p role={error ? "alert" : "status"} className={error ? "alert" : ""}>{error || "Loading password details..."}</p>
    {error && <button type="button" onClick={() => void load()}>Retry</button>}
  </>;
  return <form className="admin-form login-form" onSubmit={(event) => void submit(event)}>
    {details.email && <p>{details.email}</p>}
    {details.expiresAt && <p>Link expires {new Date(details.expiresAt).toLocaleString()}.</p>}
    <label className="field" htmlFor="password-username">Username
      <input id="password-username" name="username" defaultValue={details.username ?? ""} disabled={Boolean(details.username)}
        required minLength={3} maxLength={64} pattern="[a-z0-9][a-z0-9._-]{2,63}" autoComplete="username" />
    </label>
    {!recovery && details.credentialsSet && <label className="field" htmlFor="current-password">Current password
      <input id="current-password" name="currentPassword" type="password" required autoComplete="current-password" />
    </label>}
    <label className="field" htmlFor="new-password">New password
      <input id="new-password" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      <span className="chart-caption">Use 12-128 characters with uppercase, lowercase, a number, and a symbol.</span>
    </label>
    <label className="field" htmlFor="confirm-password">Confirm new password
      <input id="confirm-password" name="confirmation" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
    </label>
    <p>Saving signs out all existing sessions. Account identity, roles, publication access and content are preserved.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    <button type="submit" disabled={busy}>{busy ? "Saving..." : "Save password"}</button>
  </form>;
}
