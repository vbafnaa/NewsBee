import Link from "next/link";
import type { ReactNode } from "react";

export default function MapShell({ page, title, description, children }: { page: "source-map" | "edition-map" | "interest-usage"; title: string; description: string; children: ReactNode }) {
  return <div className="map-layout">
    <a className="skip-link" href="#map-content">Skip to map</a>
    <header className="map-header"><Link href="/reader" className="map-brand">Newsbee</Link>
      <nav aria-label="Protected maps">
        <div className="map-nav-group"><span>Internal maps</span><Link href="/source-map" aria-current={page === "source-map" ? "page" : undefined}>Source map</Link><Link href="/edition-map" aria-current={page === "edition-map" ? "page" : undefined}>Edition map</Link></div>
        <div className="map-nav-group"><span>Analytics</span><Link href="/interest-usage" aria-current={page === "interest-usage" ? "page" : undefined}>Interest and usage</Link></div>
        <Link href="/reader">Newsletter</Link>
      </nav>
      <Link href="/locations">Journalist sign-in</Link>
    </header>
    <main id="map-content"><p className="eyebrow">Internal maps · read-only</p><h1>{title}</h1><p className="map-intro">{description}</p>{children}</main>
  </div>;
}
