import { redirect } from "next/navigation";
import { GOOGLE_ANALYTICS_URL } from "@/lib/analytics";
import { requireOperatorPrincipal } from "@/lib/portal-access";

export default async function InterestUsagePage() {
  await requireOperatorPrincipal();
  redirect(GOOGLE_ANALYTICS_URL);
}
