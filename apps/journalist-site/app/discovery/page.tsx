import { redirect } from "next/navigation";

/** Discovery is part of collecting a location's sources, in its Collect sources tab. */
export default function DiscoveryPage() {
  redirect("/locations");
}
