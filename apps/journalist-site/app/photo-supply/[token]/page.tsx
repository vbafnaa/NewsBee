import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PhotoSupplyForm from "./photo-supply-form";

export const metadata: Metadata = { title: "Share photographs | Newsbee", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function PhotoSupplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{64}$/.test(token)) notFound();
  return <main><p className="eyebrow">Newsbee · Community photographs</p><h1>Share your photographs</h1><PhotoSupplyForm token={token} /></main>;
}
