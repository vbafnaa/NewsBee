import type { Metadata } from "next";
import PasswordForm from "../account/password-form";

export const metadata: Metadata = {
  title: "Recover your Newsbee password",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return <main className="login">
    <p className="eyebrow">Operator-shared link</p>
    <h1>Recover your password</h1>
    <p>This single-use link sets credentials for your existing account. It does not enable a disabled account or change access.</p>
    <PasswordForm recovery />
  </main>;
}
