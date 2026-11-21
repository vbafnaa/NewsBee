"use client";

import { useEffect, useState } from "react";

export type PublicationWriteAccess = { canWrite: boolean; supportExpiresAt: number | null };

export function usePublicationWriteAccess(access: PublicationWriteAccess | null) {
  const [now, setNow] = useState(Date.now);
  const expiresAt = access?.supportExpiresAt;
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = expiresAt ? window.setTimeout(refresh, Math.max(0, expiresAt - Date.now())) : undefined;
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [expiresAt]);
  return access?.canWrite === true && (!expiresAt || expiresAt > now);
}
