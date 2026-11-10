import { redirect } from "next/navigation";

/** Model usage is part of the System page. */
export default function ModelUsagePage() {
  redirect("/health?view=usage");
}
