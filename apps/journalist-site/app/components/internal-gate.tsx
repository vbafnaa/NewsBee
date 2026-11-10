import type { ReactNode } from "react";
import { internalUnlocked } from "@/lib/internal-session";
import { internalReturnPath } from "@/lib/internal-access";

export default async function InternalGate({ returnTo, error, children }: { returnTo: string; error?: string; children: ReactNode }) {
  if (await internalUnlocked()) return children;
  const configured = Boolean(process.env.NEWSBEE_INTERNAL_PASSWORD);
  return <section className="panel internal-gate">
    <p className="eyebrow">Protected · Read-only access</p>
    <h2>Unlock internal maps</h2>
    <p>Signed-in journalists open these maps directly. Without an account, use the shared password; access lasts eight hours. The maps are read-only: sources are edited in each location&rsquo;s workspace.</p>
    {!configured ? <p className="alert" role="alert">Internal maps are locked. Configure NEWSBEE_INTERNAL_PASSWORD on the server to enable access.</p> :
      <form method="post" action="/api/internal-access" className="unlock-form">
        <input type="hidden" name="returnTo" value={internalReturnPath(returnTo)} />
        <label className="field">Internal password<input name="password" type="password" autoComplete="current-password" required maxLength={1024} /></label>
        <button type="submit">Unlock maps</button>
        {error && <p className="alert" role="alert">{error === "limited" ? "Too many attempts. Try again in 15 minutes." : "The password was not accepted."}</p>}
      </form>}
  </section>;
}
