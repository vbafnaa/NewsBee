import Link from "next/link";
import type { ReactNode } from "react";

export default function MapShell({ page, title, description, children }: { page: "source-map" | "interest-usage"; title: string; description: string; children: ReactNode }) {
  return <div className="map-layout">
    <a className="skip-link" href="#map-content">Skip to map</a>
    <header className="map-header"><Link href="/reader" className="map-brand">Newsbee</Link>
      <nav aria-label="Protected maps"><Link href="/source-map" aria-current={page === "source-map" ? "page" : undefined}>Source map</Link><Link href="/interest-usage" aria-current={page === "interest-usage" ? "page" : undefined}>Interest and usage</Link><Link href="/reader">Newsletter</Link></nav>
      <Link href="/dashboard">Journalist sign-in</Link>
    </header>
    <main id="map-content"><p className="eyebrow">Password-protected maps</p><h1>{title}</h1><p className="map-intro">{description}</p>{children}</main>
  </div>;
}
