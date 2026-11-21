import { signIn } from "@/auth";
import { headers } from "next/headers";
import { loginDestination } from "@/lib/login-destination";
import CredentialLogin from "./credential-login";

export default async function Login({ searchParams }: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") === "http" ? "http" : "https";
  const destination = loginDestination((await searchParams).callbackUrl, host ? `${protocol}://${host}` : undefined);
  return (
    <main className="login">
      <p className="eyebrow">Newsbee operations</p>
      <h1>Journalist workspace</h1>
      <p>Sign in with your Newsbee editor credentials or an authorized Google account.</p>
      <CredentialLogin destination={destination} />
      <p>Forgot your password? Ask your Newsbee owner or admin for a manually shared recovery link.</p>
      <p className="login-divider">or</p>
      <form action={async () => {
        "use server";
        await signIn("google", { redirectTo: destination });
      }}>
        <button className="secondary" type="submit">Continue with Google</button>
      </form>
    </main>
  );
}
