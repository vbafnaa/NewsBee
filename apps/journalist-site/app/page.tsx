import { currentAdmin } from "@/lib/admin-session";
import { redirect } from "next/navigation";

export default async function Home() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  redirect("/dashboard");
}
