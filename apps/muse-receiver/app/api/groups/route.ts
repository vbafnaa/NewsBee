import { randomUUID } from "node:crypto";
import { storage } from "@/lib/storage";
import { apiError, jsonRequest } from "@/lib/http";
import { validateGroup, type Group } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const groups = await storage().listGroups();
    return Response.json({ groups });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const input = validateGroup(await jsonRequest(request, 4096));
    const group: Group = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
    await storage().createGroup(group);
    return Response.json({ group }, { status: 201 });
  } catch (error) { return apiError(error); }
}
