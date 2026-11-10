import { redirect } from "next/navigation";

/** Alerts now sit in each location's Overview, next to what fixes them; the newsroom overview counts them. */
export default function AlertsPage() {
  redirect("/locations");
}
