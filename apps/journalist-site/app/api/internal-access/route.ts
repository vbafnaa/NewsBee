import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/admin-session";
import { getDatabase } from "@/pipeline/storage/mongo";
import { logger } from "@/pipeline/core/log";
import { INTERNAL_COOKIE, INTERNAL_TTL, internalReturnPath, internalToken, passwordMatches } from "@/lib/internal-access";

export const dynamic = "force-dynamic";
const log = logger("map-access");

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ detail: "Cross-origin map access requests are not allowed." }, { status: 403 });
  try {
    const password = process.env.NEWSBEE_INTERNAL_PASSWORD;
    if (!password) return Response.json({ detail: "NEWSBEE_INTERNAL_PASSWORD is not configured." }, { status: 503 });
    const form = await request.formData();
    const returnTo = internalReturnPath(form.get("returnTo"));
    const db = await getDatabase();
    const window = Math.floor(Date.now() / 900_000);
    // Vercel overwrites this header; elsewhere use a shared bucket, not spoofable IP headers.
    const identity = process.env.VERCEL ? request.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim() || "shared" : "shared";
    const id = createHmac("sha256", password).update(`map-unlock:${identity}:${window}`).digest("hex");
    const attempts = await db.collection<{ _id: string; attempts: number; expires_at: Date }>("internal_access_attempts").findOneAndUpdate(
      { _id: id }, { $inc: { attempts: 1 }, $setOnInsert: { expires_at: new Date((window + 2) * 900_000) } }, { upsert: true, returnDocument: "after" },
    );
    await db.collection("internal_access_attempts").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    const supplied = form.get("password");
    const error = (attempts?.attempts ?? 11) > 10 ? "limited" : typeof supplied !== "string" || supplied.length > 1024 || !passwordMatches(supplied, password) ? "password" : null;
    const target = new URL(returnTo, request.headers.get("origin")!);
    if (error) target.searchParams.set("unlock", error);
    const response = NextResponse.redirect(target, 303);
    response.headers.set("Cache-Control", "no-store");
    if (!error) response.cookies.set(INTERNAL_COOKIE, internalToken(password), {
      httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: INTERNAL_TTL,
    });
    if (error === "limited") response.headers.set("Retry-After", String(Math.ceil(((window + 1) * 900_000 - Date.now()) / 1000)));
    return response;
  } catch (error) {
    log.error("map_unlock_failed", { error: error instanceof Error ? error.message : String(error) });
    return Response.json({ detail: "Map access is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return Response.json({ detail: "Cross-origin map access requests are not allowed." }, { status: 403 });
  const response = NextResponse.json({ locked: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(INTERNAL_COOKIE, "", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
  return response;
}
