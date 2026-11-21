import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import NewsletterDelivery from "./newsletter-delivery";
export default async function NewsletterPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="newsletter" title="Audience & delivery history" description="Read-only historical audience, consent and delivery status. Email sending is unavailable."><NewsletterDelivery /></AdminShell>;
}
