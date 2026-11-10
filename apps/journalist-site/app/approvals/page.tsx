import { redirect } from "next/navigation";

/** The approval inbox is gone: every run uses the keys of whoever starts it. Old links land on the workspace. */
export default function ApprovalsPage() {
  redirect("/locations");
}
