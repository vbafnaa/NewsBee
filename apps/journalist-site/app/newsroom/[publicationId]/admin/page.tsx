import Link from "next/link";
import { newsroomServiceStatus, type ServiceCard, type ServiceSection } from "@/pipeline/publications/newsroom-admin-status";
import { Icon, PageHeader, StatusPill, type IconName } from "../../newsroom-ui";
import { loadNewsroom } from "../newsroom-context";

const SECTION_ICONS: Record<ServiceSection["id"], IconName> = { system: "settings", storage: "storage", transfer: "transfer", environment: "code" };
const STATE_PILL = { active: ["ok", "Active"], attention: ["warning", "Needs attention"], unchecked: ["muted", "Not checked"] } as const;

/**
 * Newsroom admin (frame 13): a read-only status view of the services behind the newsroom, open to everyone. Statuses
 * come from the same records as the Operations pages and are never invented. Each card's arrow opens its Operations
 * page for people allowed there; journalists see it locked ("Admins only"), and admins see Import & export locked
 * ("Owner only"). The Operations pages themselves are unchanged.
 */
export default async function NewsroomAdminPage({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  const { principal, db } = await loadNewsroom(publicationId);
  const owner = principal.role === "owner";
  const sections = await newsroomServiceStatus(db);
  const locked = (section: ServiceSection) => principal.role === "editor" ? "Admins only"
    : section.ownerOnly && !owner ? "Owner only" : null;
  return <section className="jw-admin" aria-labelledby="workspace-title">
    <h1 id="workspace-title" className="visually-hidden">Newsroom admin</h1>
    {sections.map((section) => <section className="jw-admin-section" key={section.id} aria-labelledby={`admin-${section.id}`}>
      <PageHeader eyebrow={section.eyebrow} title={section.title} titleId={`admin-${section.id}`} description={section.description}
        actions={section.docs ? <a className="jw-button secondary" href={section.docs} target="_blank" rel="noopener noreferrer">View documentation<Icon name="external" size={14} /></a> : undefined} />
      <div className="jw-service-grid">
        {section.cards.map((card) => <ServiceCardView key={card.name} card={card} icon={SECTION_ICONS[section.id]} locked={locked(section)} />)}
      </div>
    </section>)}
  </section>;
}

function ServiceCardView({ card, icon, locked }: { card: ServiceCard; icon: IconName; locked: string | null }) {
  const [pill, label] = STATE_PILL[card.state];
  const body = <>
    <span className="jw-service-icon"><Icon name={icon} size={18} /></span>
    <span className="jw-service-text"><strong>{card.name}</strong><small>{card.detail}</small></span>
    <StatusPill status={pill}>{label}</StatusPill>
  </>;
  return locked
    ? <div className="jw-card jw-service-card is-locked" title={locked}>
      {body}<span className="jw-service-arrow" aria-label={`${card.name}: ${locked}`}><Icon name="lock" size={14} /></span>
    </div>
    : <Link className="jw-card jw-service-card" href={card.href} aria-label={`${card.name}: ${label}. Open in Operations`}>
      {body}<span className="jw-service-arrow"><Icon name="arrow" size={16} /></span>
    </Link>;
}
