"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The newsroom a shared review component is working inside. Inside the journalist workspace it scopes every
 * community-level API call to that newsroom and keeps links in the workspace; elsewhere (Operations) it is empty.
 */
const PublicationScopeContext = createContext<{ publicationId: string; base: string } | null>(null);

export function PublicationScope({ publicationId, children }: { publicationId: string; children: ReactNode }) {
  return <PublicationScopeContext.Provider value={{ publicationId, base: `/newsroom/${encodeURIComponent(publicationId)}` }}>{children}</PublicationScopeContext.Provider>;
}

export const usePublicationScope = () => useContext(PublicationScopeContext);
