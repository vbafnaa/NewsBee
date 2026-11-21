import { redirect } from "next/navigation";

export default async function VideoStudioPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  await searchParams;
  redirect("/newsroom?task=videos");
}
