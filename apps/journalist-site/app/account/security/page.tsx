import Link from "next/link";
import { requireSignedInPrincipal } from "@/lib/portal-access";
import { defaultPortal } from "@/lib/portal-access";
import PasswordForm from "../password-form";

export default async function AccountSecurityPage() {
  const principal = await requireSignedInPrincipal();
  return <main className="login">
    <p className="eyebrow">Your account</p>
    <h1>Password & sign-in</h1>
    <p>{principal.email}</p>
    <p>Set up or change your own username/password credentials. Provider settings are not part of this page.</p>
    <PasswordForm />
    <Link href={defaultPortal(principal.role)}>Back to workspace</Link>
  </main>;
}
