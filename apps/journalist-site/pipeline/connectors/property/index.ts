/**
 * The property reader: recorded home sales, with prices, from whatever a county publishes.
 *
 *   socrata  a sales dataset on an open-data portal (found by the opendata method)
 *   csv      a sales data file (found by operator search)
 *   attom    ATTOM's sale snapshot by postal code, when ticked (paid; if county records are thin)
 *
 * Each county publishes differently, so columns are matched by name, and a source that doesn't
 * fit reports why. Strict runs print address, price, date and property details. Buyer and
 * seller names print only when the run's topic_content rules are off.
 */
import { addDays, plainText } from "../common";
import { runCollector, SourceUnavailable } from "../parents/shared";
import { sha256 } from "../wider/adapters";
import { newestFirst } from "../web";
import { datasetColumns } from "../opendata";
import type { CollectedEvent, Connector, ConnectorContext, DroppedItem, SourceResult, SourceTask } from "../types";
import { currentOptions, itemCap, rulesOff } from "../../core/run-options";
import { rangesFor } from "../../core/time";
import { datasetWindow } from "../../sourcemap/windows";
import { logApiCall, paidCall } from "../../trace/gateway";

const MAX_ITEMS = 40;
const MAX_FILE = 8 * 1024 * 1024;
const PRICE = /sale_?price|sale_?amount|saleamt|price|consideration|sales?_?amt/i;
const DATE = /sale_?date|document_?date|recorded|transfer_?date|date_?of_?sale|^date$/i;
const ADDRESS = /address|situs|location|street/i;
const CITY = /city|municipality|town/i;
const POSTAL = /zip|postal/i;
const BUYER = /buyer|grantee/i;
const SELLER = /seller|grantor/i;
const DETAIL = /bedroom|bathroom|sq_?ft|square|living_?area|year_?built|property_?type|use_?code/i;

function money(value: string) {
  const number = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}
function dayOf(value: string) {
  const iso = /(\d{4})[-/](\d{2})[-/](\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
  return us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` : null;
}
function csvRows(text: string) {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cell = "", quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
      else cell += char;
    }
    cells.push(cell);
    rows.push(cells.map((value) => value.trim()));
  }
  return rows;
}

type Sale = { address: string; price: number; day: string; buyer?: string | null; seller?: string | null; details?: string[] };

function saleItem(task: SourceTask, sale: Sale, url: string | null): CollectedEvent {
  const parties = rulesOff("topic_content") ? [sale.buyer ? `Buyer: ${sale.buyer}.` : "", sale.seller ? `Seller: ${sale.seller}.` : ""].filter(Boolean).join(" ") : "";
  const price = `$${Math.round(sale.price).toLocaleString("en-US")}`;
  return {
    source_event_id: sha256(`${sale.address}:${sale.day}:${sale.price}`).slice(0, 16), title: `${sale.address} sold for ${price}`, event_date: sale.day, schedule_text: `Recorded ${sale.day}`, venue: task.name, room: null,
    source_url: url, kind: "home_sale", source_name: task.name, description: plainText([`${sale.address} sold for ${price}, recorded ${sale.day}.`, sale.details?.join(", "), parties].filter(Boolean).join(" "), 600),
    needs_locality: true, section_hint: "real_estate", source_tier: "official",
  } as CollectedEvent;
}

function inPlace(row: { city: string | null; address: string; postal: string | null }, context: ConnectorContext) {
  const names = [context.location.community?.name, context.location.community?.parent_name, context.location.name.split(",")[0]].filter(Boolean).map((name) => String(name).toLowerCase());
  return !row.city || names.includes(row.city.toLowerCase()) || names.some((name) => row.address.toLowerCase().includes(name));
}

async function readCsv(task: SourceTask, context: ConnectorContext, record: SourceResult, from: string) {
  const url = String(task.params?.url ?? "");
  const [finalUrl, body] = await context.fetcher.get(url, MAX_FILE, "text/csv, text/plain;q=0.9, */*;q=0.5").catch((error: unknown) => { throw new SourceUnavailable(error instanceof Error && error.name === "DiscoveryBlockedError" ? "blocked" : "failed", error instanceof Error ? error.message : String(error)); });
  await logApiCall("county_records", false, "ok", url);
  const rows = csvRows(new TextDecoder().decode(body));
  const header = rows[0] ?? [];
  const index = (pattern: RegExp) => header.findIndex((name) => pattern.test(name));
  const [price, date, address] = [index(PRICE), index(DATE), index(ADDRESS)];
  if (price < 0 || date < 0 || address < 0) throw new SourceUnavailable("no_feed", `This file has no price, date and address columns (columns: ${header.slice(0, 12).join(", ")})`);
  const [city, postal, buyer, seller] = [index(CITY), index(POSTAL), index(BUYER), index(SELLER)];
  const detail = header.flatMap((name, position) => DETAIL.test(name) ? [position] : []);
  record.website = finalUrl;
  const sales: Sale[] = [];
  for (const row of rows.slice(1)) {
    const day = dayOf(row[date] ?? ""), amount = money(row[price] ?? ""), place = row[address] ?? "";
    if (!day || day < from || day > context.today || !amount || !place) continue;
    if (!inPlace({ city: city >= 0 ? row[city] : null, address: place, postal: postal >= 0 ? row[postal] : null }, context)) continue;
    sales.push({ address: place, price: amount, day, buyer: buyer >= 0 ? row[buyer] : null, seller: seller >= 0 ? row[seller] : null, details: detail.map((position) => `${header[position].replace(/_/g, " ")}: ${row[position]}`).filter((value) => !value.endsWith(": ")) });
  }
  return sales;
}

async function readSocrata(task: SourceTask, context: ConnectorContext, record: SourceResult, from: string) {
  const domain = String(task.params?.domain ?? ""), dataset = String(task.params?.dataset ?? "");
  const columns = await datasetColumns(context, domain, dataset);
  const field = (pattern: RegExp) => columns.find((column) => pattern.test(column.field))?.field ?? null;
  const [price, date, address] = [field(PRICE), field(DATE), field(ADDRESS)];
  if (!price || !date || !address) throw new SourceUnavailable("no_feed", "This dataset has no price, date and address columns");
  const [buyer, seller, city] = [field(BUYER), field(SELLER), field(CITY)];
  const params = new URLSearchParams({ $where: `${date} >= '${from}T00:00:00'`, $order: `${date} DESC`, $limit: "500" });
  const response = await context.transport({ url: `https://${domain}/resource/${dataset}.json?${params}`, headers: { Accept: "application/json" }, timeoutMs: 30_000 });
  if (response.status >= 400) throw new SourceUnavailable("failed", `Dataset returned HTTP ${response.status}`);
  await logApiCall("socrata", false, "ok", `${domain}/${dataset}`);
  record.website = `https://${domain}/d/${dataset}`;
  return (JSON.parse(new TextDecoder().decode(response.body)) as Array<Record<string, string>>).flatMap((row): Sale[] => {
    const day = dayOf(String(row[date] ?? "")), amount = money(String(row[price] ?? "")), place = String(row[address] ?? "");
    if (!day || !amount || !place || !inPlace({ city: city ? row[city] : null, address: place, postal: null }, context)) return [];
    return [{ address: place, price: amount, day, buyer: buyer ? row[buyer] : null, seller: seller ? row[seller] : null }];
  });
}

async function readAttom(task: SourceTask, context: ConnectorContext, record: SourceResult, from: string) {
  const key = context.settings.integrations.attomKey;
  if (!key) throw new SourceUnavailable("no_feed", "NEWSBEE_ATTOM_API_KEY is not set");
  const stamp = (day: string) => day.replace(/-/g, "/");
  const params = new URLSearchParams({ postalCode: String(task.params?.postal_code ?? ""), startSaleSearchDate: stamp(from), endSaleSearchDate: stamp(context.today) });
  const outcome = await paidCall("attom", async () => {
    const response = await context.transport({ url: `https://api.gateway.attomdata.com/propertyapi/v1.0.0/sale/snapshot?${params}`, headers: { Accept: "application/json", APIKey: key }, timeoutMs: 30_000 });
    if (response.status >= 400) throw new Error(`ATTOM returned HTTP ${response.status}`);
    return JSON.parse(new TextDecoder().decode(response.body)) as { property?: Array<{ address?: { oneLine?: string }; sale?: { saleSearchDate?: string; saleTransDate?: string; amount?: { saleamt?: number; saleAmt?: number } } }> };
  });
  if (outcome.refused) throw new SourceUnavailable("no_feed", outcome.refused);
  record.website = "https://www.attomdata.com/";
  return (outcome.value?.property ?? []).flatMap((row): Sale[] => {
    const amount = row.sale?.amount?.saleamt ?? row.sale?.amount?.saleAmt, day = dayOf(row.sale?.saleSearchDate ?? row.sale?.saleTransDate ?? ""), place = row.address?.oneLine;
    return amount && day && place ? [{ address: place, price: amount, day }] : [];
  });
}

export const propertyConnector: Connector = {
  type: "property",
  meta: {
    name: "Home sales",
    formats: "County sales data files, open-data sales datasets and, when ticked, ATTOM's paid sale snapshot",
    manual: false,
    coverage: { group: "local", label: "recorded home sales" },
    storyKinds: ["home_sale"],
  },
  window: datasetWindow("permits"),
  rank: newestFirst,
  sources() { return []; },
  async collect(task, context) {
    const dropped: DroppedItem[] = [];
    const collected = await runCollector(task, context, async (record) => {
      if (currentOptions().external_off.includes("county_records") && task.params?.backend !== "attom") throw new SourceUnavailable("no_feed", "County records are switched off for this run");
      const from = rangesFor(context, datasetWindow("permits")).back?.[0] ?? addDays(context.today, -21);
      record.feed_kind = String(task.params?.backend ?? "csv");
      const sales = task.params?.backend === "socrata" ? await readSocrata(task, context, record, from) : task.params?.backend === "attom" ? await readAttom(task, context, record, from) : await readCsv(task, context, record, from);
      const keep = itemCap(MAX_ITEMS);
      record.detail = `${sales.length} recorded sales since ${from}${sales.length > keep ? `; newest ${keep} kept` : ""}`;
      return sales.sort((a, b) => b.day.localeCompare(a.day)).slice(0, keep).map((sale) => saleItem(task, sale, record.website));
    });
    return { ...collected, dropped };
  },
};
