import { redirect } from "next/navigation";
import { GOOGLE_ANALYTICS_URL } from "@/lib/analytics";

export default function InterestUsagePage() {
  redirect(GOOGLE_ANALYTICS_URL);
}
