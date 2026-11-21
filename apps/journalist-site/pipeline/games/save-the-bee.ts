import { createHash } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { US_STATES } from "../../../../shared/geography";
import { parseBeePuzzle } from "../../../../shared/save-the-bee";

const LOCAL_TOPICS = [
  { word: "LIBRARY", clue: "A local place to borrow books." },
  { word: "PARK", clue: "A local green space for walks and picnics." },
  { word: "TRAIL", clue: "A local path for walking or cycling." },
  { word: "MARKET", clue: "A local gathering of stalls and sellers." },
  { word: "FERRY", clue: "A boat carrying local travelers across the water." },
  { word: "BRIDGE", clue: "A local crossing over water or a road." },
  { word: "HARBOR", clue: "A sheltered local place for boats." },
  { word: "BEACH", clue: "A local stretch of shore for a sandy stroll." },
  { word: "LAKE", clue: "A local body of fresh water." },
  { word: "RIVER", clue: "A flowing waterway mentioned in this edition." },
  { word: "MUSEUM", clue: "A local place to explore art or history." },
  { word: "BAKERY", clue: "A local stop for fresh bread and pastries." },
];
type Word = { word: string; clue: string };
type Shout = { attemptId: string; nickname: string; score: number };
export type BeeGame = {
  publication_id?: string;
  _id: string; locationId: string; editionId: string; version: 1; revision: number;
  word: string; clue: string; status: "draft" | "approved" | "frozen" | "published";
  approvedBy?: string; approvedAt?: number; publishedAt?: number; closesAt?: number;
  previousGameId?: string; shoutouts: Shout[]; shoutoutsReviewed: boolean; activityRevision?: number;
};
export type BeeGameAccess = (at: number) => Promise<{ game: BeeGame; rankedOpen: boolean }>;
type Attempt = {
  publication_id?: string;
  _id: string; gameId: string; owner: string; ranked: boolean; word: string; clue: string;
  guesses: string[]; revision: number; status: "playing" | "won" | "lost"; score: number;
  createdAt: number; expiresAt: Date; finishedAt?: number; nickname: string | null; public: boolean; shoutout: boolean;
};
type EditionRow = {
  id: string; location_id: string; location_name?: string; status: string; published_at?: number;
  published?: { location_name?: string; items?: Array<{ headline?: string; blurb?: string; kind?: string }> };
};
export class BeeError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const key = (location: string, edition: string) => hash(JSON.stringify([location, edition, 1]));
const games = (db: Db) => db.collection<BeeGame>("bee_games");
const attempts = (db: Db) => db.collection<Attempt>("bee_attempts");
const editions = (db: Db) => db.collection<EditionRow>("editions");
export function beeIdentity(token: string) { return hash(token); }

async function editionExists(db: Db, location: string, edition: string) {
  const row = await editions(db).findOne({ location_id: location, id: edition });
  if (!row || !["built", "published"].includes(row.status)) throw new BeeError("Edition is not ready.", 404);
  return row;
}

async function localSuggestions(db: Db, edition: EditionRow): Promise<Word[]> {
  const profile = await db.collection<{ _id: string; name?: string; state?: string; community?: { name?: string } }>("locations")
    .findOne({ _id: edition.location_id });
  const name = profile?.community?.name ?? profile?.name ?? edition.location_name ?? edition.published?.location_name
    ?? edition.location_id.replace(/-[a-z]{2}$/i, "").replaceAll("-", " ");
  const state = profile?.state ?? edition.location_id.split("-").at(-1)?.toUpperCase() ?? "";
  const parts = (text: string) => text.split(",")[0].normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().match(/[A-Z]+/g) ?? [];
  const words: Word[] = parts(name).map(word => ({ word, clue: "Part of this neighborhood's name." }));
  const stories = (edition.published?.items ?? []).filter(item =>
    ["local_news", "event", "business_opening", "reader_story"].includes(item.kind ?? ""));
  const text = stories.map(item => `${item.headline ?? ""} ${item.blurb ?? ""}`).join(" ");
  words.push(...LOCAL_TOPICS.filter(topic => new RegExp(`\\b${topic.word}s?\\b`, "i").test(text)));
  words.push(...parts(US_STATES[state] ?? "").map(word => ({ word, clue: "Part of this state's name." })));
  const seen = new Set<string>();
  const eligible = words.filter(({ word, clue }) => {
    if (!/^[A-Z]{3,12}$/.test(word) || seen.has(word) || clue.toUpperCase().includes(word)) return false;
    seen.add(word); return true;
  });
  if (!eligible.length) throw new BeeError("Add a location name or local story before generating a word.", 422);
  return eligible;
}

export async function previewBeeGame(db: Db, location: string, edition: string) {
  const row = await editionExists(db, location, edition);
  const id = key(location, edition);
  const existing = await games(db).findOne({ _id: id });
  if (existing) return existing;
  const suggestions = await localSuggestions(db, row);
  const word = suggestions[parseInt(id.slice(0, 8), 16) % suggestions.length];
  await games(db).updateOne({ _id: id }, { $setOnInsert: {
    _id: id, locationId: location, editionId: edition, version: 1, revision: 0,
    ...word, status: "draft", shoutouts: [], shoutoutsReviewed: false,
  } }, { upsert: true });
  return (await games(db).findOne({ _id: id }))!;
}

export async function shoutoutCandidates(db: Db, location: string, edition: string, now = Date.now()) {
  const prior = await games(db).find({ locationId: location, editionId: { $ne: edition }, status: "published", publication_id: { $exists: false } })
    .sort({ publishedAt: -1 }).limit(1).next();
  if (!prior) return { previousGameId: undefined, finalized: true, candidates: [] as Shout[] };
  const live = await editions(db).find({ location_id: location, status: "published" }).sort({ published_at: -1, id: 1 }).limit(1).next();
  const finalized = now >= prior.closesAt! || live?.id !== prior.editionId;
  if (!finalized) return { previousGameId: prior._id, finalized: false, candidates: [] as Shout[] };
  // Fence guesses already in flight at the automatic deadline before reading final scores.
  await games(db).updateOne({ _id: prior._id }, { $min: { closesAt: now }, $inc: { activityRevision: 1 } });
  const eligible = await attempts(db).find({ gameId: prior._id, ranked: true, status: "won", public: true, shoutout: true })
    .sort({ score: -1, _id: 1 }).limit(20).toArray();
  return { previousGameId: prior._id, finalized: true, candidates: eligible.map(a => ({ attemptId: a._id, nickname: a.nickname!, score: a.score })) };
}

export async function closePreviousBeeGame(db: Db, location: string, edition: string) {
  const current = await previewBeeGame(db, location, edition);
  if (!["draft", "approved"].includes(current.status)) throw new BeeError("This edition's game is already frozen.");
  const previous = await shoutoutCandidates(db, location, edition);
  const at = Date.now();
  if (previous.previousGameId) await games(db).updateOne({ _id: previous.previousGameId, closesAt: { $gt: at } },
    { $set: { closesAt: at } });
}

const indexPromises = new WeakMap<Db["client"], Map<string, Promise<unknown>>>();
export async function beeIndexes(db: Db) {
  let databases = indexPromises.get(db.client);
  if (!databases) { databases = new Map(); indexPromises.set(db.client, databases); }
  let pending = databases.get(db.databaseName);
  if (!pending) {
    pending = Promise.all([
      games(db).createIndex({ locationId: 1, status: 1, publishedAt: -1 }),
      attempts(db).createIndex({ gameId: 1, ranked: 1, public: 1, score: -1 }),
      attempts(db).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection("bee_request_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]).catch(error => { databases.delete(db.databaseName); throw error; });
    databases.set(db.databaseName, pending);
  }
  await pending;
}

export async function editBeeGame(db: Db, location: string, edition: string, input: {
  revision: number; action: "save" | "regenerate" | "approve"; word?: string; clue?: string; shoutoutIds?: string[];
}, by: string) {
  const current = await previewBeeGame(db, location, edition);
  if (!["draft", "approved"].includes(current.status)) throw new BeeError("Published game words and rules are frozen.");
  if (input.revision !== current.revision) throw new BeeError("Game changed. Reload the preview.");
  let word: Word;
  if (input.action === "regenerate") {
    const suggestions = await localSuggestions(db, await editionExists(db, location, edition));
    const index = suggestions.findIndex(w => w.word === current.word);
    word = suggestions[(index + 1) % suggestions.length];
  } else {
    word = { word: String(input.word ?? current.word).trim().toUpperCase(), clue: String(input.clue ?? current.clue).trim() };
  }
  try { word = parseBeePuzzle(word); }
  catch (error) { throw new BeeError(error instanceof Error ? error.message.replace("hint", "clue") : String(error), 422); }
  const source = await shoutoutCandidates(db, location, edition);
  const ids = input.shoutoutIds ?? [];
  if (!Array.isArray(ids) || ids.length > 3 || ids.some(id => !source.candidates.some(a => a.attemptId === id))) {
    throw new BeeError("Choose up to three eligible finalized results.", 422);
  }
  const approved = input.action === "approve";
  const result = await games(db).findOneAndUpdate(
    { _id: current._id, revision: current.revision, status: { $in: ["draft", "approved"] } },
    { $set: { ...word, status: approved ? "approved" : "draft", approvedBy: approved ? by : undefined,
      approvedAt: approved ? Date.now() : undefined, previousGameId: source.previousGameId,
      shoutouts: source.candidates.filter(a => ids.includes(a.attemptId)), shoutoutsReviewed: approved },
      $inc: { revision: 1 } }, { returnDocument: "after" });
  if (!result) throw new BeeError("Game changed. Reload the preview.");
  return result;
}

/** Freezing is a compare-and-swap against editor changes, before any edition goes live. */
export async function freezeBeeGame(db: Db, location: string, edition: string) {
  const game = await games(db).findOne({ _id: key(location, edition) });
  if (!game || !["approved", "frozen", "published"].includes(game.status) || !game.shoutoutsReviewed) {
    throw new BeeError("Preview and explicitly approve Guide the Bee Home and its shout-outs before publishing.");
  }
  if (game.status !== "approved") return game;
  const frozen = await games(db).findOneAndUpdate({ _id: game._id, revision: game.revision, status: "approved" },
    { $set: { status: "frozen" } }, { returnDocument: "after" });
  if (!frozen) throw new BeeError("Game changed. Review it again before publishing.");
  return frozen;
}

export async function publishBeeGame(db: Db, location: string, edition: string, now = Date.now()) {
  await games(db).updateOne({ _id: key(location, edition), status: "frozen" },
    { $set: { status: "published", publishedAt: now, closesAt: now + 7 * 86400_000 } });
}

export async function closeOtherBeeGames(db: Db, location: string, edition: string, now = Date.now()) {
  await games(db).updateMany({ locationId: location, editionId: { $ne: edition }, status: "published", closesAt: { $gt: now }, publication_id: { $exists: false } },
    { $set: { closesAt: now } });
}

async function publicGame(db: Db, location: string, edition: string, now: number, session?: ClientSession, access?: BeeGameAccess) {
  if (access) return access(now);
  const row = await editions(db).findOne({ location_id: location, id: edition, status: "published" }, { session });
  const game = await games(db).findOne({ _id: key(location, edition), status: "published" }, { session });
  if (!row || !game) throw new BeeError("Guide the Bee Home is not published for this edition.", 404);
  const live = await editions(db).find({ location_id: location, status: "published" }, { session }).sort({ published_at: -1, id: 1 }).limit(1).next();
  return { game, rankedOpen: live?.id === edition && now < game.closesAt! };
}

/** A game-document write fences attempt mutations against editorial closing.
 * Transactions need a replica set (Atlas, or the isolated local fixture replica set). */
async function mutate<T>(db: Db, location: string, edition: string, now: number | undefined,
  handler: (game: BeeGame, rankedOpen: boolean, session: ClientSession, at: number) => Promise<T>, access?: BeeGameAccess) {
  if (access) {
    const { game } = await access(now ?? Date.now());
    await games(db).updateOne({ _id: game._id }, { $setOnInsert: game }, { upsert: true });
  }
  const session = db.client.startSession();
  try {
    return await session.withTransaction(async () => {
      const at = now ?? Date.now();
      const { game, rankedOpen } = await publicGame(db, location, edition, at, session, access);
      await games(db).updateOne({ _id: game._id }, { $inc: { activityRevision: 1 } }, { session });
      return handler(game, rankedOpen, session, at);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally { await session.endSession(); }
}

function view(a: Attempt) {
  const misses = a.guesses.filter(letter => !a.word.includes(letter)).length;
  return { id: a._id, ranked: a.ranked, version: 1, revision: a.revision, clue: a.clue,
    letters: [...a.word].map(letter => a.guesses.includes(letter) || a.status !== "playing" ? letter : null),
    guesses: a.guesses, incorrect: a.guesses.filter(letter => !a.word.includes(letter)), misses, remaining: 6 - misses, status: a.status, score: a.score,
    nickname: a.nickname, public: a.public, shoutout: a.shoutout };
}
export type BeeAttemptView = ReturnType<typeof view>;
export async function beeState(db: Db, location: string, edition: string, owner: string, now = Date.now(), access?: BeeGameAccess) {
  const { game, rankedOpen } = await publicGame(db, location, edition, now, undefined, access);
  const ranked = await attempts(db).findOne({ _id: hash(`${game._id}:${owner}`), owner });
  const rows = await attempts(db).find({ gameId: game._id, ranked: true, public: true, status: { $ne: "playing" } })
    .sort({ score: -1, _id: 1 }).limit(100).toArray();
  const leaderboard = rows.map(a => ({ nickname: a.nickname, score: a.score, rank: rows.findIndex(b => b.score === a.score) + 1, yours: a.owner === owner }));
  const shoutouts: Array<{ nickname: string; score: number }> = [];
  for (const shout of game.shoutouts) {
    const stillConsenting = await attempts(db).findOne({ _id: shout.attemptId, gameId: game.previousGameId, public: true, shoutout: true });
    if (stillConsenting) shoutouts.push({ nickname: shout.nickname, score: shout.score });
  }
  return { version: game.version, rankedOpen, closesAt: game.closesAt, ranked: ranked ? view(ranked) : null,
    leaderboard, shoutouts };
}

export async function startBeeAttempt(db: Db, location: string, edition: string, owner: string, practice: boolean, now?: number, access?: BeeGameAccess) {
  if (practice) throw new BeeError("Practice games are not available.", 422);
  return mutate(db, location, edition, now, async (game, rankedOpen, session, at) => {
    const id = hash(`${game._id}:${owner}`);
    const existing = await attempts(db).findOne({ _id: id, owner }, { session });
    if (existing) return view(existing);
    if (!rankedOpen) throw new BeeError("A new puzzle will be here soon.");
    const attempt: Attempt = { _id: id, gameId: game._id, owner, ranked: true,
      ...(game.publication_id ? { publication_id: game.publication_id } : {}),
      word: game.word, clue: game.clue, guesses: [], revision: 0, status: "playing", score: 0,
      createdAt: at, expiresAt: new Date(at + 90 * 86400_000), nickname: null, public: false, shoutout: false };
    await attempts(db).insertOne(attempt, { session });
    return view(attempt);
  }, access);
}

export async function guessBeeLetter(db: Db, location: string, edition: string, owner: string, attemptId: string, letter: string, now?: number, access?: BeeGameAccess) {
  letter = letter.toUpperCase();
  if (!/^[A-Z]$/.test(letter)) throw new BeeError("Guess one letter A-Z.", 422);
  return mutate(db, location, edition, now, async (game, rankedOpen, session, at) => {
    const a = await attempts(db).findOne({ _id: attemptId, gameId: game._id, owner, ranked: true }, { session });
    if (!a) throw new BeeError("Attempt not found for this browser and edition.", 404);
    if (a.status !== "playing" || a.guesses.includes(letter)) return view(a);
    if (!rankedOpen) throw new BeeError("A new puzzle will be here soon.");
    const guesses = [...a.guesses, letter];
    const misses = guesses.filter(l => !a.word.includes(l)).length;
    const won = [...a.word].every(l => guesses.includes(l));
    const status = won ? "won" : misses >= 6 ? "lost" : "playing";
    const result = await attempts(db).findOneAndUpdate({ _id: a._id, revision: a.revision },
      { $set: { guesses, status, score: won ? 100 - misses * 10 : 0, ...(status !== "playing" ? { finishedAt: at } : {}) },
        $inc: { revision: 1 } }, { returnDocument: "after", session });
    if (result) return view(result);
    throw new BeeError("Another tab is updating this game. Please retry.");
  }, access);
}

export async function consentBeeResult(db: Db, location: string, edition: string, owner: string, input: {
  public: boolean; shoutout: boolean; nickname: string | null;
}, access?: BeeGameAccess) {
  if (typeof input.public !== "boolean" || typeof input.shoutout !== "boolean" || (input.shoutout && !input.public)) {
    throw new BeeError("Choose separate sharing permissions.", 422);
  }
  const raw = input.nickname ?? "";
  const nickname = input.public ? raw.normalize("NFKC").trim().replace(/ +/g, " ") : null;
  if (input.public && (!nickname || [...nickname].length < 2 || [...nickname].length > 24 ||
    /\p{C}/u.test(raw) || !/^[\p{L}\p{M}\p{N} .'-]+$/u.test(nickname) || !/\p{L}/u.test(nickname) ||
    /\b(?:fuck|shit|cunt|nigger|nazi)\w*\b/i.test(nickname) || /\b(?:www|https?)\b/i.test(nickname) ||
    /\b[\p{L}\p{N}-]+\.(?:com|org|net|io|co|edu|gov)\b/iu.test(nickname))) {
    throw new BeeError("Use a 2-24 character nickname, without links or contact details.", 422);
  }
  return mutate(db, location, edition, undefined, async (game, rankedOpen, session) => {
    const a = await attempts(db).findOne({ _id: hash(`${game._id}:${owner}`), gameId: game._id, owner, ranked: true, status: { $ne: "playing" } }, { session });
    if (!a) throw new BeeError("Finish your ranked game first.");
    if (!rankedOpen && input.public && (!a.public || a.nickname !== nickname || (!a.shoutout && input.shoutout))) {
      throw new BeeError("Results are finalized. You may still withdraw either permission.");
    }
    const result = await attempts(db).findOneAndUpdate({ _id: a._id, revision: a.revision },
      { $set: { public: input.public, shoutout: input.public && input.shoutout, nickname },
        $inc: { revision: 1 } }, { returnDocument: "after", session });
    if (!result) throw new BeeError("Consent changed in another tab. Reload and retry.");
    return view(result);
  }, access);
}
