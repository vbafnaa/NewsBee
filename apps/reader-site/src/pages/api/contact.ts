import type { APIRoute } from "astro";
import { receiveCommunityIntake } from "../../lib/community-intake-request";
export const prerender = false;
export const POST: APIRoute = ({ request, url }) => receiveCommunityIntake("contact", request, url);
