import { expect, it } from "vitest";
import { directoryTown, searchTownDirectory } from "../../../../reader-site/src/lib/reader-data";
import { withMongo } from "../support/mongo";

const mongo = withMongo();

it("suggests unserved Census towns by prefix, ranks exact names first and filters states", async () => {
  await mongo.db.collection("census_places").insertMany([
    { _id: "seattle-wa" as never, name: "Seattle", name_lower: "seattle", state: "WA" },
    { _id: "seattle-heights-wa" as never, name: "Seattle Heights", name_lower: "seattle heights", state: "WA" },
    { _id: "kent-wa" as never, name: "Kent", name_lower: "kent", state: "WA" },
    { _id: "kent-oh" as never, name: "Kent", name_lower: "kent", state: "OH" },
  ]);
  expect(await mongo.db.collection("output_channels").countDocuments()).toBe(0);
  expect(await searchTownDirectory("Sea", mongo.db)).toEqual([
    { id: "seattle-wa", name: "Seattle, WA" }, { id: "seattle-heights-wa", name: "Seattle Heights, WA" },
  ]);
  expect(await searchTownDirectory("kent, wa", mongo.db)).toEqual([{ id: "kent-wa", name: "Kent, WA" }]);
  expect(await directoryTown("kent-wa", mongo.db)).toEqual({ id: "kent-wa", name: "Kent, WA" });
  expect(await directoryTown("unknown", mongo.db)).toBeNull();
  expect(await searchTownDirectory("S", mongo.db)).toEqual([]);
  expect(await searchTownDirectory(".*", mongo.db)).toEqual([]);
});
