import { cookies } from "next/headers";
import { INTERNAL_COOKIE, validInternalToken } from "./internal-access";
import { currentPrincipal } from "./admin-session";

const passwordUnlocked = async () => validInternalToken((await cookies()).get(INTERNAL_COOKIE)?.value, process.env.NEWSBEE_INTERNAL_PASSWORD);
/** A signed-in journalist needs no password. The password cookie is checked first, so it never needs a sign-in lookup. */
const signedIn = async () => Boolean(await currentPrincipal().catch(() => null));

export async function internalUnlocked() {
  return await passwordUnlocked() || await signedIn();
}

export async function internalGuard() {
  if (await internalUnlocked()) return null;
  if (!process.env.NEWSBEE_INTERNAL_PASSWORD) {
    return Response.json({ detail: "Internal maps are unavailable: sign in, or configure NEWSBEE_INTERNAL_PASSWORD on the server." }, { status: 503 });
  }
  return Response.json({ detail: "Sign in, or unlock internal maps with the shared internal password." }, { status: 403 });
}
