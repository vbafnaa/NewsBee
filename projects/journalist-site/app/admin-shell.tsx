import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/auth";

type AdminPage = "dashboard" | "sources" | "administrators";

export default function AdminShell({
  email,
  page,
  title,
  description,
  children,
}: {
  email: string;
  page: AdminPage;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const navItems: { id: AdminPage; label: string; href: string }[] = [
    { id: "dashboard", label: "Dashboard", href: "/" },
    { id: "sources", label: "Sources", href: "/sources" },
    { id: "administrators", label: "Administrators", href: "/administrators" },
  ];

  return (
    <main className="admin-shell">
      <aside className="sidebar">
        <Link className="brand" href="/">Newsbee</Link>
        <p className="eyebrow">Journalist workspace</p>
        <nav aria-label="Administration">
          {navItems.map((item) => (
            <Link
              aria-current={page === item.id ? "page" : undefined}
              className={page === item.id ? "sidebar-link active" : "sidebar-link"}
              href={item.href}
              key={item.id}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-account">
          <span title={email}>{email}</span>
          <form action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}>
            <button className="secondary" type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="admin-content">
        <header className="page-heading">
          <p className="eyebrow">Newsbee operations</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        {children}
      </div>
    </main>
  );
}
