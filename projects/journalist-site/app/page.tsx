import { auth, isAdminEmail, signOut } from "@/auth";
import { redirect } from "next/navigation";
import Dashboard from "./dashboard";

export default async function Home() {
  const session = await auth();
  if (!(await isAdminEmail(session?.user?.email))) redirect("/login");

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Newsbee operations</p>
          <h1>Journalist workspace</h1>
          <p>Manage active sources and run ingestion for onboarded communities.</p>
        </div>
        <form action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}>
          <span>{session.user.email}</span>
          <button className="secondary" type="submit">Sign out</button>
        </form>
      </header>
      <Dashboard />
    </main>
  );
}
