import { auth, isAdminEmail, signOut } from "@/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import Dashboard from "./dashboard";

export default async function Home() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !(await isAdminEmail(email))) redirect("/login");

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Newsbee operations</p>
          <h1>Journalist workspace</h1>
          <p>Manage active sources and run ingestion for onboarded communities.</p>
        </div>
        <nav className="topbar-actions" aria-label="Page navigation">
          <Link className="nav-button" href="/administrators">Administrator access</Link>
          <form action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}>
            <span>{email}</span>
            <button className="secondary" type="submit">Sign out</button>
          </form>
        </nav>
      </header>
      <Dashboard />
    </main>
  );
}
