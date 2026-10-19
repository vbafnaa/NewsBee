import Link from "next/link";
import { auth, isAdminEmail, signOut } from "@/auth";
import { redirect } from "next/navigation";
import AdminManagement from "./admin-management";

export default async function AdministratorsPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !(await isAdminEmail(email))) redirect("/login");

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Newsbee operations</p>
          <h1>Administrator access</h1>
          <p>Manage who can sign in to the journalist workspace.</p>
        </div>
        <nav className="topbar-actions" aria-label="Page navigation">
          <Link className="nav-button" href="/">Back to dashboard</Link>
          <form action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}>
            <span>{email}</span>
            <button className="secondary" type="submit">Sign out</button>
          </form>
        </nav>
      </header>
      <AdminManagement />
    </main>
  );
}
