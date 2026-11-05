import { cookies } from "next/headers";
import { INTERNAL_COOKIE, validInternalToken } from "./internal-access";

export async function internalUnlocked() {
  return validInternalToken((await cookies()).get(INTERNAL_COOKIE)?.value, process.env.NEWSBEE_INTERNAL_PASSWORD);
}

export async function internalGuard() {
  if (!process.env.NEWSBEE_INTERNAL_PASSWORD) {
    return Response.json({ detail: "Internal maps are unavailable: configure NEWSBEE_INTERNAL_PASSWORD on the server." }, { status: 503 });
  }
  if (!(await internalUnlocked())) return Response.json({ detail: "Unlock internal maps with the shared internal password." }, { status: 403 });
  return null;
}
