import { signIn } from "@/auth";

export default function Login() {
  return (
    <main className="login">
      <p className="eyebrow">Newsbee operations</p>
      <h1>Journalist workspace</h1>
      <p>Sign in with an authorized Google account to manage sources and trigger ingestion.</p>
      <form action={async () => {
        "use server";
        await signIn("google", { redirectTo: "/" });
      }}>
        <button type="submit">Continue with Google</button>
      </form>
    </main>
  );
}
