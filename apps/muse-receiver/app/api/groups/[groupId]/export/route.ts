import { storage } from "@/lib/storage";
import { findGroup, notFound, type GroupContext } from "@/lib/groups";
import { apiError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: GroupContext) {
  try {
    const store = storage();
    const group = await findGroup(store, context);
    if (!group) return notFound();
    const posts = store.exportPosts(group.id)[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(`{"version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"group":${JSON.stringify(group)},"posts":[`));
          let first = true;
          for await (const post of { [Symbol.asyncIterator]: () => posts }) {
            controller.enqueue(encoder.encode(`${first ? "" : ","}${JSON.stringify(post)}`));
            first = false;
          }
          controller.enqueue(encoder.encode("]}"));
          controller.close();
        } catch (error) { controller.error(error); }
      },
      async cancel() { await posts.return?.(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="muse-posts-${group.id}.json"`,
      "Cache-Control": "no-store",
    } });
  } catch (error) { return apiError(error); }
}
