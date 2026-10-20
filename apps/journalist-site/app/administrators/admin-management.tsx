"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

type AdminAccount = { email: string; enabled: boolean };

export default function AdminManagement() {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/journalist-admins", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      setAccounts(data.accounts as AdminAccount[]);
      setLoaded(true);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/journalist-admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(formData.get("admin-email") ?? "") }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      setNotice(`Admin access enabled for ${data.account.email}.`);
      form.reset();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Administrator access</h2>
            <p>Only listed accounts can sign in to this journalist workspace.</p>
          </div>
        </div>
        <form className="admin-form" onSubmit={(event) => void addAdmin(event)}>
          <label className="field" htmlFor="admin-email">
            <span>Google account email</span>
            <input id="admin-email" name="admin-email" type="email" autoComplete="email"
              placeholder="editor@example.com" required maxLength={254} />
          </label>
          <button type="submit" disabled={busy}>Add administrator</button>
        </form>
        <div className="admin-list" aria-live="polite">
          {accounts.map((account) => (
            <div className="admin-row" key={account.email}>
              <span>{account.email}</span>
              <span className={account.enabled ? "state active" : "state"}>
                {account.enabled ? "Can sign in" : "Disabled"}
              </span>
            </div>
          ))}
          {accounts.length === 0 && (
            <p>{loaded ? "No administrator accounts found." : "Loading administrator accounts..."}</p>
          )}
        </div>
      </section>
    </>
  );
}
