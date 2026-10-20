import { zipSync, strToU8 } from "fflate";
import { expect, it } from "vitest";
import { ensureDirectories } from "../../communities/bootstrap";
import { searchPlaces } from "../../communities/directory";
import { type HttpTransport } from "../../core/http";
import { withMongo } from "../support/mongo";

const mongo = withMongo();
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])));
function transport() {
  const requests: string[] = [];
  const fetch: HttpTransport = async ({ url }) => {
    requests.push(url);
    const body = url.includes("Gaz_place") ? zip({ "2023_Gaz_place_national.txt":
      "GEOID\tUSPS\tNAME\tFUNCSTAT\tINTPTLAT\tINTPTLONG\n5363000\tWA\tSeattle city\tA\t47.6\t-122.3\n" }) :
      zip({
        "PLS_FY22_AE_pud22i.csv": "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,LATITUDE,LONGITUD\nWA,WA0001,SEATTLE PUBLIC LIBRARY,100 MAIN ST,SEATTLE,47.6,-122.3\n",
        "pls_fy22_outlet_pud22i.csv": "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,C_OUT_TY\nWA,WA0001,CENTRAL LIBRARY,100 MAIN ST,SEATTLE,CE\n",
      });
    return { url, status: 200, headers: {}, body };
  };
  return { fetch, requests };
}

it("prepares reference data on first use and does not redownload it for later searches", async () => {
  const replay = transport();
  await ensureDirectories(mongo.db, replay.fetch);
  expect((await searchPlaces(mongo.db, "Seattle"))[0]).toMatchObject({ id: "seattle-wa", branch_count: 1, system_count: 1 });
  await ensureDirectories(mongo.db, replay.fetch);
  expect(replay.requests).toHaveLength(2);
  expect(await mongo.db.collection("directory_setup").countDocuments()).toBe(0);
});

it("shares directory setup across concurrent searches and retries after download failures", async () => {
  const replay = transport();
  await expect(ensureDirectories(mongo.db, async () => { throw new Error("Download unavailable"); })).rejects.toThrow("Download unavailable");
  expect(await mongo.db.collection("directory_setup").countDocuments()).toBe(0);
  await Promise.all([ensureDirectories(mongo.db, replay.fetch), ensureDirectories(mongo.db, replay.fetch)]);
  expect(replay.requests).toHaveLength(2);
  expect((await searchPlaces(mongo.db, "Sea"))[0].id).toBe("seattle-wa");
});
