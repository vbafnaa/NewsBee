"use client";

import { useEffect, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";

type Invitation = { email: string; expiresAt: string };

export default function EditorSignup({ token }: { token: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("This invitation link is invalid or expired.");
      return;
    }
    void fetch(`/api/auth/editor-signup?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail ?? "Invitation unavailable");
        setInvitation(body as Invitation);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Invitation unavailable"));
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    if (password !== String(data.get("confirmation") ?? "")) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/editor-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          email: invitation?.email,
          username: data.get("username"),
          password,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? "Signup failed");
      const login = await signIn("credentials", {
        username: String(data.get("username") ?? ""),
        password,
        redirect: false,
        redirectTo: "/",
      });
      if (login?.error) throw new Error("Account created. Sign in from the login page.");
      window.location.assign(login?.url ?? "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Signup failed");
    } finally {
      setBusy(false);
    }
  }

  if (!invitation) return <p className={error ? "alert" : ""} role="status">{error || "Checking invitation…"}</p>;
  return <form className="admin-form login-form" onSubmit={(event) => void submit(event)}>
    <label className="field" htmlFor="signup-email">Invited email
      <input id="signup-email" value={invitation.email} disabled />
    </label>
    <label className="field" htmlFor="signup-username">Username
      <input
        id="signup-username"
        name="username"
        required
        minLength={3}
        maxLength={64}
        pattern="[a-z0-9][a-z0-9._-]{2,63}"
        autoComplete="username"
      />
    </label>
    <label className="field" htmlFor="signup-password">Password
      <input id="signup-password" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      <span className="chart-caption">Use 12-128 characters with uppercase, lowercase, a number, and a symbol.</span>
    </label>
    <label className="field" htmlFor="signup-confirmation">Confirm password
      <input id="signup-confirmation" name="confirmation" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
    </label>
    {error && <p className="alert" role="alert">{error}</p>}
    <button type="submit" disabled={busy}>{busy ? "Creating account…" : "Create editor login"}</button>
  </form>;
}
