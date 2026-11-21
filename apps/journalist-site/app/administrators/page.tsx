import { redirect } from "next/navigation";

export default async function AdministratorsPage() {
  redirect("/admin/access");
}
