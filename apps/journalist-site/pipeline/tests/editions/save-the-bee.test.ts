import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  beeIdentity, beeIndexes, beeState, closeOtherBeeGames, closePreviousBeeGame, consentBeeResult,
  editBeeGame, freezeBeeGame, guessBeeLetter, previewBeeGame, publishBeeGame, shoutoutCandidates, startBeeAttempt,
} from "../../games/save-the-bee";
import { publishEdition } from "../../orchestration/publish";
import type { ArtifactStore } from "../../storage/artifacts";
import { GET, POST } from "../../../../reader-site/src/pages/api/save-the-bee";
import { loadReaderPublication } from "../../../../reader-site/src/lib/reader-data";
import { fetchPublicationPreview, PreviewUnavailable } from "../../../../reader-site/src/lib/publication-preview";

vi.mock("../../../../reader-site/src/lib/reader-data", () => ({
  readerDatabase: async () => db,
  readerData: async () => ({ editions: [{ id: "week-1", location_id: "garden-wa" }] }),
  loadReaderPublication: vi.fn(),
}));
vi.mock("../../../../reader-site/src/lib/publication-preview", async (original) => ({
  ...await original<typeof import("../../../../reader-site/src/lib/publication-preview")>(),
  fetchPublicationPreview: vi.fn(),
}));

let server: MongoMemoryReplSet, client: MongoClient, db: Db;
const location = "garden-wa", edition = "week-1", owner = beeIdentity("browser-one");
const by = "editor@example.test";
async function seed(id = edition, place = location, publishedAt = Date.now() / 1000) {
  await db.collection("editions").insertOne({ id, location_id: place, status: "built", published_at: publishedAt,
    published: { id, location_id: place, headline: "A garden edition", items: [] } });
  const game = await previewBeeGame(db, place, id);
  return editBeeGame(db, place, id, { action: "approve", revision: game.revision, word: "CLOVER", clue: "A plant with three little leaves." }, by);
}
async function live(id = edition, place = location, at = Date.now()) {
  await seed(id, place, at / 1000);
  await freezeBeeGame(db, place, id);
  await db.collection("editions").updateOne({ id, location_id: place }, { $set: { status: "published" } });
  await publishBeeGame(db, place, id, at);
}
async function win(who = owner, misses = "") {
  let a = await startBeeAttempt(db, location, edition, who, false);
  for (const letter of `${misses}CLOVER`) a = await guessBeeLetter(db, location, edition, who, a.id, letter);
  return a;
}
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri()); db = client.db("save-the-bee");
});
beforeEach(async () => {
  await db.dropDatabase(); await client.close();
  client = await MongoClient.connect(server.getUri()); db = client.db("save-the-bee"); await beeIndexes(db);
});
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("editorial review and frozen publication", () => {
  it("generates repeatable location words and only uses lighter topics actually present in the edition", async () => {
    await db.collection("editions").insertOne({ id: edition, location_id: location, location_name: "Ballard, WA", status: "built",
      published: { items: [
        { kind: "local_news", headline: "A neighborhood market beside the library" },
        { kind: "safety_incident", headline: "An incident near the harbor" },
      ] } });
    const first = await previewBeeGame(db, location, edition);
    expect(await previewBeeGame(db, location, edition)).toEqual(first);
    const suggestions = new Map<string, string>([[first.word, first.clue]]);
    let game = first;
    for (let i = 0; i < 4; i++) {
      game = await editBeeGame(db, location, edition, { action: "regenerate", revision: game.revision }, by);
      suggestions.set(game.word, game.clue);
    }
    expect([...suggestions.keys()]).toEqual(expect.arrayContaining(["BALLARD", "MARKET", "LIBRARY"]));
    expect(suggestions.has("HARBOR")).toBe(false);
    expect([...suggestions].every(([word, clue]) => !clue.toUpperCase().includes(word))).toBe(true);
    expect(suggestions.get("BALLARD")).toContain("neighborhood");
  });

  it("generates a private preview, permits replacements, invalidates approval and rejects stale review", async () => {
    const initial = await seed();
    const next = await editBeeGame(db, location, edition, { action: "regenerate", revision: initial.revision }, by);
    expect(next.word).not.toBe(initial.word); expect(next.status).toBe("draft");
    await expect(editBeeGame(db, location, edition, { action: "approve", revision: initial.revision }, by)).rejects.toThrow("changed");
    await expect(freezeBeeGame(db, location, edition)).rejects.toThrow("approve");
    await expect(editBeeGame(db, location, edition, { action: "save", revision: next.revision, word: "BEE", clue: "BEE is the answer" }, by)).rejects.toThrow("clue");
    const approved = await editBeeGame(db, location, edition, { action: "approve", revision: next.revision, word: "TULIP", clue: "A cup-shaped spring flower." }, by);
    await freezeBeeGame(db, location, edition);
    await expect(editBeeGame(db, location, edition, { action: "save", revision: approved.revision }, by)).rejects.toThrow("frozen");
  });

  it("blocks edition publication until explicit approval, without writing the reader", async () => {
    await seed();
    const game = await previewBeeGame(db, location, edition);
    await editBeeGame(db, location, edition, { action: "save", revision: game.revision }, by);
    let writes = 0;
    const store = { saveJson: async () => { writes++; return "file"; } } as ArtifactStore;
    await expect(publishEdition(db, store, location, edition, by, "fixture")).rejects.toThrow("explicitly approve");
    expect(writes).toBe(0);
    expect((await db.collection("editions").findOne({ id: edition }))?.status).toBe("built");
    await expect(beeState(db, location, edition, owner)).rejects.toThrow("not published");
  });
});

describe("durable browser attempts and server scoring", () => {
  it("creates exactly one ranked attempt across concurrent tabs, without disclosing the answer", async () => {
    await live();
    const responses = await Promise.all(Array.from({ length: 10 }, () => startBeeAttempt(db, location, edition, owner, false)));
    expect(new Set(responses.map(a => a.id)).size).toBe(1);
    expect(await db.collection("bee_attempts").countDocuments()).toBe(1);
    expect(responses[0].letters).toEqual([null, null, null, null, null, null]);
    expect(JSON.stringify(responses[0])).not.toContain("CLOVER");
    expect(JSON.stringify(await beeState(db, location, edition, owner))).not.toContain("CLOVER");
  });

  it("resumes durable guesses after reconnect, ignores duplicate retries, and merges concurrent guesses", async () => {
    await live();
    const a = await startBeeAttempt(db, location, edition, owner, false);
    await Promise.all(["C", "X", "L", "X", "C", "O"].map(l => guessBeeLetter(db, location, edition, owner, a.id, l)));
    await client.close(); client = await MongoClient.connect(server.getUri()); db = client.db("save-the-bee");
    const resumed = await startBeeAttempt(db, location, edition, owner, false);
    expect(new Set(resumed.guesses)).toEqual(new Set(["C", "L", "O", "X"]));
    expect(resumed.revision).toBe(4); expect(resumed.misses).toBe(1);
    expect(resumed.letters).toEqual(["C", "L", "O", null, null, null]);
    const retry = await guessBeeLetter(db, location, edition, owner, a.id, "X");
    expect(retry).toEqual(resumed);
  });

  it("scores only on the server, without speed bonuses, and cannot change a finished result", async () => {
    await live();
    const won = await win(owner, "XZ");
    expect(won.status).toBe("won"); expect(won.score).toBe(80);
    const [retry, resumed, extra] = await Promise.all([
      guessBeeLetter(db, location, edition, owner, won.id, "R"),
      startBeeAttempt(db, location, edition, owner, false),
      guessBeeLetter(db, location, edition, owner, won.id, "Q"),
    ]);
    expect(retry).toEqual(won); expect(resumed).toEqual(won); expect(extra).toEqual(won);
    expect(await db.collection("bee_attempts").countDocuments({ ranked: true })).toBe(1);
  });

  it("ends at six misses, preserves the result, and does not create practice games", async () => {
    await live();
    await expect(startBeeAttempt(db, location, edition, owner, true)).rejects.toThrow("not available");
    let a = await startBeeAttempt(db, location, edition, owner, false);
    for (const letter of "XYZQJK") a = await guessBeeLetter(db, location, edition, owner, a.id, letter);
    expect(a.status).toBe("lost"); expect(a.score).toBe(0); expect(a.remaining).toBe(0);
    await expect(startBeeAttempt(db, location, edition, owner, true)).rejects.toThrow("not available");
    expect(await startBeeAttempt(db, location, edition, owner, false)).toEqual(a);
    expect(await db.collection("bee_attempts").countDocuments({ ranked: false })).toBe(0);
    expect((await beeState(db, location, edition, owner)).ranked).toEqual(a);
  });

  it("isolates browser, location and edition even when edition IDs match", async () => {
    await live(); await live(edition, "other-wa"); await live("week-2", location, Date.now() - 1000);
    const a = await startBeeAttempt(db, location, edition, owner, false);
    for (const [place, id, who] of [[location, edition, "another-browser"], ["other-wa", edition, owner], [location, "week-2", owner]]) {
      await expect(guessBeeLetter(db, place, id, who, a.id, "C")).rejects.toThrow("not found");
    }
    expect((await beeState(db, location, edition, owner)).ranked?.guesses).toEqual([]);
    await expect(guessBeeLetter(db, location, edition, owner, a.id, "CLOVER")).rejects.toThrow("one letter");
  });

  it("freezes scores at the deadline and preserves saved results on archived editions", async () => {
    await live();
    const a = await startBeeAttempt(db, location, edition, owner, false);
    const game = await previewBeeGame(db, location, edition);
    await expect(guessBeeLetter(db, location, edition, owner, a.id, "C", game.closesAt)).rejects.toThrow("new puzzle");
    await expect(startBeeAttempt(db, location, edition, "new-browser", false, game.closesAt)).rejects.toThrow("new puzzle");
    await live("week-2", location, Date.now() + 1000);
    expect((await beeState(db, location, edition, owner)).rankedOpen).toBe(false);
    expect(await startBeeAttempt(db, location, edition, owner, false)).toEqual(a);
    await expect(startBeeAttempt(db, location, edition, "new-browser", false)).rejects.toThrow("new puzzle");
  });
});

describe("consent, tied ranks and reviewed next-edition shout-outs", () => {
  it("keeps skipped results private, validates safe nicknames, and shares tied ranks", async () => {
    await live();
    await expect(consentBeeResult(db, location, edition, owner, { public: true, nickname: "Sunny Bee", shoutout: true })).rejects.toThrow("Finish");
    await win();
    expect((await beeState(db, location, edition, owner)).leaderboard).toEqual([]);
    await expect(consentBeeResult(db, location, edition, owner, { public: true, nickname: "<script>", shoutout: false })).rejects.toThrow("nickname");
    await expect(consentBeeResult(db, location, edition, owner, { public: false, nickname: null, shoutout: true })).rejects.toThrow("separate");
    await consentBeeResult(db, location, edition, owner, { public: true, nickname: "Sunny Bee", shoutout: false });
    await win("second"); await win("third", "X");
    await consentBeeResult(db, location, edition, "second", { public: true, nickname: "Poppy Bee", shoutout: false });
    await consentBeeResult(db, location, edition, "third", { public: true, nickname: "Daisy Bee", shoutout: true });
    const rows = (await beeState(db, location, edition, owner)).leaderboard;
    expect(rows.map(r => [r.rank, r.score])).toEqual([[1, 100], [1, 100], [3, 90]]);
    expect(JSON.stringify(rows)).not.toContain(owner);
  });

  it("accepts free-text nicknames after finishing, normalizes spacing and rejects unsafe or oversized names", async () => {
    await live(); await win();
    const shared = await consentBeeResult(db, location, edition, owner, { public: true, nickname: "  Jos\u00e9   R. ", shoutout: false });
    expect(shared.nickname).toBe("Jos\u00e9 R.");
    expect((await beeState(db, location, edition, owner)).leaderboard[0].nickname).toBe("Jos\u00e9 R.");
    for (const nickname of ["a", "x".repeat(25), "<img onerror=alert(1)>", "name@example.com", "www.example.com", "example.com", "Bee\u202eName", "1234567890"]) {
      await expect(consentBeeResult(db, location, edition, owner, { public: true, nickname, shoutout: false })).rejects.toThrow("nickname");
    }
    const renamed = await consentBeeResult(db, location, edition, owner, { public: true, nickname: "Maya O'Neil", shoutout: true });
    expect(renamed.nickname).toBe("Maya O'Neil");
  });

  describe("public HTTP boundary", () => {
    function browser(query = "location=garden-wa&edition=week-1") {
      const jar = new Map<string, string>();
      let cookieOptions: unknown;
      return {
        jar,
        get cookieOptions() { return cookieOptions; },
        async request(body?: Record<string, unknown>, origin = "http://localhost:4328") {
          const url = new URL(`http://localhost:4328/reader/api/save-the-bee?${query}`);
          const request = new Request(url, { method: body ? "POST" : "GET",
            ...(body ? { headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
          const context = { request, url, cookies: {
            get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined,
            set: (name: string, value: string, options: unknown) => { jar.set(name, value); cookieOptions = options; },
          } } as Parameters<typeof GET>[0];
          const response = await (body ? POST : GET)(context);
          return { status: response.status, headers: response.headers, body: await response.json() };
        },
      };
    }
    it("establishes an HttpOnly save cookie before starting, uses no-store, and rejects CSRF and malformed actions", async () => {
      await live(); const b = browser();
      expect((await b.request({ action: "start", practice: false })).status).toBe(409);
      const initial = await b.request();
      expect(initial.status).toBe(200); expect(initial.headers.get("cache-control")).toContain("no-store");
      expect(b.cookieOptions).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/reader", maxAge: 365 * 86400 });
      expect((await b.request({ action: "start", practice: false }, "https://attacker.example")).status).toBe(403);
      expect((await b.request({ action: "start", practice: "ranked" })).status).toBe(422);
      expect((await b.request({ action: "start", practice: true })).status).toBe(422);
      expect((await b.request({ action: "score", score: 100000 })).status).toBe(422);
      expect(await db.collection("bee_attempts").countDocuments()).toBe(0);
    });
    it("ignores forged scores, resumes after a retry, and never gives another browser the saved attempt", async () => {
      await live(); const b = browser(); await b.request();
      const started = await b.request({ action: "start", score: 9999, word: "HONEY" });
      expect(started.body.attempt.score).toBe(0); expect(JSON.stringify(started.body)).not.toContain("CLOVER");
      const id = started.body.attempt.id;
      await b.request({ action: "guess", attemptId: id, letter: "x", score: 9999 });
      expect((await b.request()).body.ranked).toMatchObject({ id, incorrect: ["X"], misses: 1, score: 0 });
      for (const letter of "clover") await b.request({ action: "guess", attemptId: id, letter, score: 9999 });
      expect((await b.request()).body.ranked).toMatchObject({ status: "won", score: 90 });
      const stranger = browser(); await stranger.request();
      expect((await stranger.request({ action: "guess", attemptId: id, letter: "C" })).status).toBe(404);
      expect((await stranger.request()).body.ranked).toBeNull();
    });
    it("rate-limits writes per save identity without IP tracking", async () => {
      await live(); const b = browser(); await b.request();
      const identity = beeIdentity(b.jar.get("newsbee-bee")!);
      await db.collection<{ _id: string; count: number }>("bee_request_limits").insertOne({
        _id: `${identity}:${Math.floor(Date.now() / 60_000)}`, count: 120,
      });
      expect((await b.request({ action: "start", practice: false })).status).toBe(429);
      expect(await db.collection("bee_attempts").countDocuments()).toBe(0);
    });
    it("plays the exact publication snapshot without a community edition or early answer disclosure", async () => {
      const loaded = {
        entry: { withdrawn: false },
        manifest: { latest: { release_id: "release-one" } },
        release: { release_id: "release-one", published_at: Date.now() / 1000,
          save_the_bee: { word: "TULIP", clue: "A cup-shaped spring flower." } },
      } as Awaited<ReturnType<typeof loadReaderPublication>>;
      vi.mocked(loadReaderPublication).mockResolvedValue(loaded);
      const b = browser("publication=paper&release=release-one");
      expect((await b.request()).status).toBe(200);
      const starts = await Promise.all([b.request({ action: "start" }), b.request({ action: "start" })]);
      expect(starts.map((result) => result.status)).toEqual([200, 200]);
      expect(starts[0].body.attempt.id).toBe(starts[1].body.attempt.id);
      expect(starts[0].body.attempt.clue).toBe("A cup-shaped spring flower.");
      expect(JSON.stringify(starts[0].body)).not.toContain("TULIP");
      expect(await db.collection("editions").countDocuments()).toBe(0);
      const id = starts[0].body.attempt.id;
      expect((await b.request({ action: "guess", attemptId: id, letter: "X" })).body.attempt.score).toBe(0);
      for (const letter of "TULIP") await b.request({ action: "guess", attemptId: id, letter });
      expect((await b.request()).body.ranked).toMatchObject({ status: "won", score: 90 });
      loaded!.manifest.latest = null;
      const stranger = browser("publication=paper&release=release-one");
      await stranger.request();
      expect((await stranger.request({ action: "start" })).status).toBe(409);
      loaded!.entry.withdrawn = true;
      expect((await b.request()).status).toBe(404);
      loaded!.entry.withdrawn = false;
      delete loaded!.release.save_the_bee;
      expect((await b.request()).status).toBe(404);
    });
    it("keeps authenticated exact-revision preview attempts private and separate from released games", async () => {
      const preview = { snapshot: { draft_revision: 7, save_the_bee: { word: "CLOVER", clue: "A plant with three little leaves." } } } as Awaited<ReturnType<typeof fetchPublicationPreview>>;
      vi.mocked(fetchPublicationPreview).mockResolvedValue(preview);
      const b = browser("publication=paper&draft=chosen-draft&revision=7");
      await b.request();
      const started = await b.request({ action: "start" });
      expect(started.status).toBe(200);
      expect(JSON.stringify(started.body)).not.toContain("CLOVER");
      vi.mocked(loadReaderPublication).mockResolvedValue({
        entry: { withdrawn: false }, manifest: { latest: { release_id: "chosen-draft" } },
        release: { release_id: "chosen-draft", published_at: Date.now() / 1000, save_the_bee: preview.snapshot.save_the_bee },
      } as Awaited<ReturnType<typeof loadReaderPublication>>);
      const released = browser("publication=paper&release=chosen-draft");
      released.jar.set("newsbee-bee", b.jar.get("newsbee-bee")!);
      expect((await released.request()).body.ranked).toBeNull();
      expect((await released.request({ action: "start" })).body.attempt.id).not.toBe(started.body.attempt.id);
      expect(await db.collection("bee_attempts").countDocuments({ publication_id: "paper" })).toBe(2);
      expect(fetchPublicationPreview).toHaveBeenLastCalledWith(expect.any(Request), "paper", "chosen-draft", "7");
      expect((await b.request({ action: "consent", public: true, nickname: "Sunny", shoutout: true })).status).toBe(422);
      vi.mocked(fetchPublicationPreview).mockRejectedValue(new PreviewUnavailable(409, "The draft changed."));
      expect((await b.request({ action: "guess", attemptId: started.body.attempt.id, letter: "C" })).status).toBe(409);
      expect((await db.collection("bee_attempts").findOne({ _id: started.body.attempt.id }))?.guesses).toEqual([]);
      vi.mocked(fetchPublicationPreview).mockRejectedValue(new PreviewUnavailable(403, "Permission revoked."));
      expect((await b.request()).status).toBe(403);
    });
  });

  it("requires finalized scores and explicit editor selection, and honors later withdrawal", async () => {
    await live(); await win();
    await consentBeeResult(db, location, edition, owner, { public: true, nickname: "Sunny Bee", shoutout: true });
    const next = await seed("week-2");
    expect((await shoutoutCandidates(db, location, "week-2")).finalized).toBe(false);
    await closePreviousBeeGame(db, location, "week-2");
    const source = await shoutoutCandidates(db, location, "week-2");
    expect(source.finalized).toBe(true); expect(source.candidates).toHaveLength(1);
    const unselected = await previewBeeGame(db, location, "week-2");
    expect(unselected.shoutouts).toEqual([]);
    await expect(editBeeGame(db, location, "week-2", { revision: next.revision, action: "approve", shoutoutIds: ["invented"] }, by)).rejects.toThrow("eligible");
    const approved = await editBeeGame(db, location, "week-2", { revision: next.revision, action: "approve", shoutoutIds: [source.candidates[0].attemptId] }, by);
    expect(approved.approvedBy).toBe(by);
    await freezeBeeGame(db, location, "week-2");
    await db.collection("editions").updateOne({ id: "week-2" }, { $set: { status: "published", published_at: Date.now() / 1000 + 1 } });
    await publishBeeGame(db, location, "week-2");
    expect((await beeState(db, location, "week-2", owner)).shoutouts).toEqual([{ nickname: "Sunny Bee", score: 100 }]);
    await consentBeeResult(db, location, edition, owner, { public: true, nickname: "Sunny Bee", shoutout: false });
    expect((await beeState(db, location, "week-2", owner)).shoutouts).toEqual([]);
    await expect(consentBeeResult(db, location, edition, owner, { public: true, nickname: "Sunny Bee", shoutout: true })).rejects.toThrow("finalized");
    await consentBeeResult(db, location, edition, owner, { public: false, nickname: null, shoutout: false });
    expect((await beeState(db, location, edition, owner)).leaderboard).toEqual([]);
  });

  it("fences an in-flight final guess against closing so finalized scores never change afterward", async () => {
    await live(); const a = await startBeeAttempt(db, location, edition, owner, false);
    for (const letter of "CLOVE") await guessBeeLetter(db, location, edition, owner, a.id, letter);
    await Promise.allSettled([
      guessBeeLetter(db, location, edition, owner, a.id, "R"),
      closeOtherBeeGames(db, location, "new-edition"),
    ]);
    const final = (await beeState(db, location, edition, owner)).ranked!;
    if (final.status === "playing") await expect(guessBeeLetter(db, location, edition, owner, a.id, "R")).rejects.toThrow("new puzzle");
    else expect(await guessBeeLetter(db, location, edition, owner, a.id, "R")).toEqual(final);
    expect((await beeState(db, location, edition, owner)).ranked).toEqual(final);
  });
});
