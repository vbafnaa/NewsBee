"use client";

import { signIn } from "next-auth/react";
import { useState, type FormEvent } from "react";
import { loginDestination } from "@/lib/login-destination";

export default function CredentialLogin({ destination }: { destination: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await signIn("credentials", {
        username: String(data.get("username") ?? ""),
        password: String(data.get("password") ?? ""),
        redirect: false,
        redirectTo: destination,
      });
      if (result?.error) {
        setError("Invalid username or password, or this account is no longer enabled.");
        return;
      }
      window.location.assign(loginDestination(result?.url ?? destination, window.location.origin));
    } catch {
      setError("Sign-in is temporarily unavailable. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="admin-form login-form" onSubmit={(event) => void submit(event)}>
    <label className="field" htmlFor="login-username">Username
      <input id="login-username" name="username" required autoComplete="username" maxLength={64} />
    </label>
    <label className="field" htmlFor="login-password">Password
      <input id="login-password" name="password" type="password" required autoComplete="current-password" maxLength={128} />
    </label>
    {error && <p className="alert" role="alert">{error}</p>}
    <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
  </form>;
}
