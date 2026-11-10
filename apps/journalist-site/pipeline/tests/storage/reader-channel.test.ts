import { MongoClient } from "mongodb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readerData, readerFolderId } from "../../../../reader-site/src/lib/reader-data";
import { DEFAULT_READER_DRIVE_FOLDER_ID, resolveReaderDriveFolderId, type ReaderChannel } from "../../../../../shared/reader-folder";
import { publishToReader, writeReaderDirectory } from "../../orchestration/publish";
import { LocalArtifacts } from "../../storage/artifacts";

const mocks = vi.hoisted(() => ({
  findOne: vi.fn<() => Promise<ReaderChannel | null>>(),
  collection: vi.fn(),
}));

vi.mock("mongodb", async (importOriginal) => ({
  ...await importOriginal<typeof import("mongodb")>(),
  MongoClient: class {
    async connect() { return this; }
    db() { return { collection: mocks.collection }; }
  },
}));

const edition = { id: "fixture-edition", location_id: "fixture-wa" };
const store = new LocalArtifacts("unused-mocked-store");
const db = new MongoClient("mongodb://fixture.invalid").db("fixture");
let saveJson: ReturnType<typeof vi.spyOn<LocalArtifacts, "saveJson">>;

beforeEach(() => {
  vi.stubEnv("MONGODB_URI", "mongodb://fixture.invalid");
  vi.stubEnv("MONGODB_DATABASE", "fixture");
  vi.stubEnv("NEWSBEE_OUTPUT_CHANNEL_ID", "fixture-channel");
  vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "fallback-folder");
  const client = new MongoClient("mongodb://fixture.invalid");
  vi.stubGlobal("newsbeeReaderMongo", {
    uri: "mongodb://fixture.invalid", client, promise: Promise.resolve(client),
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network access"); }));
  mocks.findOne.mockReset().mockResolvedValue({
    _id: "fixture-channel", enabled: true, drive_folder_id: "channel-folder",
  });
  mocks.collection.mockReset().mockImplementation((name: string) => {
    if (name === "output_channels") return { findOne: mocks.findOne };
    if (name === "editions") return { distinct: async () => ["fixture-wa"] };
    if (name === "locations") return {
      find: () => ({ toArray: async () => [{ id: "fixture-wa", name: "Fixture", systems: [] }] }),
    };
    throw new Error(`Unexpected collection: ${name}`);
  });
  saveJson = vi.spyOn(store, "saveJson").mockResolvedValue("mocked-file");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("resolves the same channel for reader, publisher and directory before the fallback", async () => {
  vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "invalid/fallback");
  await expect(readerFolderId()).resolves.toBe("channel-folder");
  await expect(publishToReader(db, store, edition)).resolves.toBe("channel-folder");
  await expect(writeReaderDirectory(db, store)).resolves.toEqual(["fixture-wa"]);
  expect(mocks.findOne).toHaveBeenCalledTimes(3);
  expect(mocks.findOne).toHaveBeenCalledWith(
    { _id: "fixture-channel" }, { projection: { _id: 1, enabled: 1, drive_folder_id: 1 } },
  );
  expect(saveJson.mock.calls.map(([folder]) => folder)).toEqual([
    "channel-folder", "channel-folder", "channel-folder",
  ]);
});

it.each(["fallback-folder", DEFAULT_READER_DRIVE_FOLDER_ID])(
  "uses %s only when the channel is absent", async (folder) => {
    mocks.findOne.mockResolvedValue(null);
    if (folder === DEFAULT_READER_DRIVE_FOLDER_ID) vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "");
    await expect(readerFolderId()).resolves.toBe(folder);
    await expect(publishToReader(db, store, edition)).resolves.toBe(folder);
    await expect(writeReaderDirectory(db, store)).resolves.toEqual(["fixture-wa"]);
    expect(saveJson.mock.calls.map(([selected]) => selected)).toEqual([folder, folder, folder]);
  },
);

it.each([
  { _id: "fixture-channel", enabled: false, drive_folder_id: "channel-folder" },
  { _id: "fixture-channel", enabled: true, drive_folder_id: "invalid/folder" },
  { _id: "fixture-channel", drive_folder_id: "channel-folder" },
  { _id: "fixture-channel", enabled: "true", drive_folder_id: "channel-folder" },
  { _id: "fixture-channel", enabled: true },
  { _id: "fixture-channel", enabled: true, drive_folder_id: 123 },
  { _id: "fixture-channel", enabled: true, drive_folder_id: "short" },
])("fails closed for an invalid channel: %j", async (channel) => {
  mocks.findOne.mockResolvedValue(channel);
  await expect(readerData()).rejects.toThrow(/Reader output channel/);
  await expect(publishToReader(db, store, edition)).rejects.toThrow(/Reader output channel/);
  await expect(writeReaderDirectory(db, store)).rejects.toThrow(/Reader output channel/);
  expect(saveJson).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not bypass channel database errors, even with cached reader data", async () => {
  vi.stubGlobal("newsbeeReaderData", {
    data: { folderId: "fallback-folder", expiresAt: Date.now() + 60_000, locations: [], editions: [] },
  });
  mocks.findOne.mockRejectedValue(new Error("Fixture database unavailable"));
  await expect(readerData()).rejects.toThrow("Fixture database unavailable");
  await expect(publishToReader(db, store, edition)).rejects.toThrow("Fixture database unavailable");
  await expect(writeReaderDirectory(db, store)).rejects.toThrow("Fixture database unavailable");
  expect(saveJson).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["MONGODB_URI", "MONGODB_DATABASE"])("surfaces missing %s instead of using the environment folder", async (key) => {
  vi.stubEnv(key, "");
  await expect(readerData()).rejects.toThrow(`${key} is not configured`);
  expect(mocks.findOne).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("defaults to the reader-site channel id", async () => {
  const find = vi.fn(async () => null);
  await expect(resolveReaderDriveFolderId(find, {})).resolves.toBe(DEFAULT_READER_DRIVE_FOLDER_ID);
  expect(find).toHaveBeenCalledWith("reader-site");
});

it("rejects an invalid fallback when the channel is absent", async () => {
  mocks.findOne.mockResolvedValue(null);
  vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "invalid/fallback");
  await expect(readerFolderId()).rejects.toThrow("NEWSBEE_READER_DRIVE_FOLDER_ID");
  await expect(publishToReader(db, store, edition)).rejects.toThrow("NEWSBEE_READER_DRIVE_FOLDER_ID");
  expect(saveJson).not.toHaveBeenCalled();
});

it("preserves explicit folder overrides without querying the channel", async () => {
  mocks.findOne.mockRejectedValue(new Error("Must not query"));
  await expect(publishToReader(db, store, edition, "explicit-folder")).resolves.toBe("explicit-folder");
  expect(mocks.findOne).not.toHaveBeenCalled();
  expect(saveJson.mock.calls.map(([folder]) => folder)).toEqual(["explicit-folder", "explicit-folder"]);
});
