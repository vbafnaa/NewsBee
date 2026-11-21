export type PublicationCapability =
  | "publication:read"
  | "publication:write"
  | "publication:inspect";

type CapabilityPrincipal = {
  role: "owner" | "admin" | "editor";
  capabilities?: PublicationCapability[];
};

export function canManageNewsrooms(principal: Pick<CapabilityPrincipal, "role">) {
  return principal.role === "owner" || principal.role === "admin";
}

const LEGACY_ROLE_CAPABILITIES: Record<CapabilityPrincipal["role"], PublicationCapability[]> = {
  owner: ["publication:read", "publication:write", "publication:inspect"],
  admin: ["publication:read", "publication:write", "publication:inspect"],
  editor: ["publication:read", "publication:write"],
};

export function publicationCapabilities(principal: CapabilityPrincipal): ReadonlySet<PublicationCapability> {
  const explicit = principal.role === "admin"
    ? principal.capabilities ?? []
    : (principal.capabilities ?? []).filter((capability) => capability !== "publication:inspect");
  return new Set([
    ...LEGACY_ROLE_CAPABILITIES[principal.role],
    ...explicit,
  ]);
}

export function hasPublicationCapability(principal: CapabilityPrincipal, capability: PublicationCapability) {
  return publicationCapabilities(principal).has(capability);
}

export class PublicationAccessDenied extends Error {
  constructor() {
    super("Publication access denied");
  }
}

export function requirePublicationCapability(
  principal: CapabilityPrincipal,
  capability: PublicationCapability,
) {
  if (!hasPublicationCapability(principal, capability)) throw new PublicationAccessDenied();
}
