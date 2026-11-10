import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { getYouTubeLocationSettings, saveYouTubeLocationSettings } from "../../youtube-location-settings";

describe("location YouTube settings", () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    db = client.db("youtube-location-settings");
  });

  beforeEach(async () => {
    await db.dropDatabase();
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it("remembers a channel and playlist per location and owner, scoped to the connected Google account", async () => {
    await saveYouTubeLocationSettings(
      db, "moses-lake-wa", "owner-1", "Owner@Example.com",
      { id: "channel-1", title: "Newsbee Local" },
      { id: "playlist-1", title: "Moses Lake Updates" },
    );
    await saveYouTubeLocationSettings(
      db, "moses-lake-wa", "owner-2", "other@example.com",
      { id: "channel-2", title: "Other News" },
      null,
    );

    await expect(getYouTubeLocationSettings(db, "moses-lake-wa", "owner-1", "owner@example.com"))
      .resolves.toMatchObject({
        channel_id: "channel-1",
        playlist_id: "playlist-1",
        playlist_title: "Moses Lake Updates",
      });
    await expect(getYouTubeLocationSettings(db, "moses-lake-wa", "owner-1", "other@example.com"))
      .resolves.toBeNull();
    await expect(getYouTubeLocationSettings(db, "other-place", "owner-1", "owner@example.com"))
      .resolves.toBeNull();
  });
});
