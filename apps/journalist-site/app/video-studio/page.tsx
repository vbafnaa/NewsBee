import { redirect } from "next/navigation";

/** Keep the old entry point working while sending video creation to publishing channels. */
export default async function VideoStudioPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const { location } = await searchParams;
  redirect(location ? `/publishing?location=${encodeURIComponent(location)}` : "/publishing");
}
