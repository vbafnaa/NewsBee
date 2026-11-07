/**
 * Queries are written once, with Google operators. Google-operator services run them as written;
 * Tavily and Exa lack most operators, so this turns a query into their request, following what
 * playbook/services.yaml says about each operator. A dated operator is matched exactly as written.
 */
import { PLAYBOOK_SERVICES, type Service } from "../playbook";

const DATED = new Set(["after", "before"]);

function stripped(service: Service, query: string) {
  const names = [...new Set(Object.entries(service.operators).filter(([, action]) => action !== "keep").map(([name]) => name.replace(/^-/, "")))].join("|");
  const { match, ignore_case: ignoreCase } = service.strip!;
  const flags = ignoreCase ? "gi" : "g";
  const plain = match === "after_space" ? query.replace(new RegExp(`(^|\\s)-?\\b(${names}):\\S+`, flags), " ") : query.replace(new RegExp(`-?\\b(${names}):\\S+`, flags), " ");
  return plain.replace(/\s+/g, " ").trim();
}

function parameters(service: Service, query: string) {
  const out: Record<string, unknown> = {};
  for (const [name, action] of Object.entries(service.operators)) {
    if (typeof action !== "object") continue;
    if (DATED.has(name)) {
      const day = new RegExp(`(?:^|\\s)${name}:(\\d{4}-\\d{2}-\\d{2})`).exec(query)?.[1];
      if (day) out[action.parameter] = day;
      continue;
    }
    const values = [...query.matchAll(new RegExp(`(?:^|\\s)${name}:(\\S+)`, "gi"))].map((found) => found[1].toLowerCase()).filter((value) => !(action.wildcards === "drop" && value.startsWith(".")));
    if (values.length) out[action.parameter] = values;
  }
  return out;
}

/** What a non-Google service is sent for one query. */
export function adaptedRequest(name: string, query: string) {
  const service = PLAYBOOK_SERVICES[name];
  if (!service?.strip) throw new Error(`The playbook has no adapter for ${name}`);
  return { query: stripped(service, query), ...service.request, ...parameters(service, query) };
}
