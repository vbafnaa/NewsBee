"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { legacyNewsroomTarget } from "../newsroom-routes";

/** Older single-page links (`#editions`, `?draft=…#editorial-workspace-title`) move to their real routes. */
export function LegacyNewsroomRedirect({ publicationId }: { publicationId: string }) {
  const router = useRouter();
  useEffect(() => {
    const target = legacyNewsroomTarget(publicationId, window.location.search, window.location.hash);
    if (target) router.replace(target);
  }, [publicationId, router]);
  return null;
}

function greeting(hour: number) {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export function Greeting({ name, newsroom }: { name: string; newsroom: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  return <>
    <p className="jw-eyebrow" suppressHydrationWarning>
      {now ? now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "Overview"}
    </p>
    <h1 id="workspace-title" tabIndex={-1}>{now ? greeting(now.getHours()) : "Welcome"}, {name}.</h1>
    <p className="jw-page-description">Here&apos;s what&apos;s happening across the {newsroom} newsroom.</p>
  </>;
}
