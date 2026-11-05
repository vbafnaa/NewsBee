/**
 * Police and fire calls written up as incidents, not a log. Calls at the same block within
 * two hours become one incident (a six-unit fire response reads as a fire, not six rows);
 * agency codes become plain words; addresses are placed at the block level. Incidents worth
 * a story are kept as items; routine calls are counted in one weekly summary item.
 */
export const CALL_PLAIN: Array<[RegExp, string]> = [
  [/aid response|\baid\b|first aid/i, "Medical aid call"],
  [/medic|\bems\b|medical|person down|unconscious|overdose|cardiac|breathing/i, "Medical emergency"],
  [/car prowl|vehicle prowl|auto prowl|theft from (auto|vehicle)/i, "Car break-in"],
  [/auto theft|vehicle theft|stolen (car|vehicle|auto)|\bmvt\b/i, "Stolen vehicle"],
  [/shoplift/i, "Shoplifting"],
  [/burglar/i, "Burglary"],
  [/robbery/i, "Robbery"],
  [/shots? fired|shooting|gunfire|\bshots\b/i, "Shots fired"],
  [/assault|\bfight\b/i, "Assault or fight"],
  [/domestic|\bdv\b/i, "Domestic dispute"],
  [/weapon|\bgun\b|knife/i, "Weapon reported"],
  [/trespass/i, "Trespassing"],
  [/suspicious/i, "Suspicious person or vehicle"],
  [/noise|disturb|nuisance/i, "Disturbance or noise"],
  [/traffic stop|onview.*traffic|traffic violation/i, "Traffic stop"],
  [/collision|\bmvc\b|\bmva\b|crash|accident|hit and run/i, "Traffic collision"],
  [/\bdui\b|impaired/i, "Impaired driving"],
  [/fire alarm|\bafa\b|automatic alarm/i, "Fire alarm"],
  [/(building|structure|residential|commercial|house|apartment|fire in) .*fire|(building|structure|residential|commercial|house|apartment) fire|fire in (building|single family|multifamily|commercial)/i, "Building fire"],
  [/(vehicle|car|auto) fire/i, "Vehicle fire"],
  [/(brush|grass|rubbish|dumpster|trash|outside|bark) fire/i, "Outdoor fire"],
  [/\bfire\b/i, "Fire"],
  [/gas leak|odor|hazmat|hazardous|natural gas/i, "Gas leak or hazardous materials"],
  [/water rescue|rescue/i, "Rescue"],
  [/theft|larceny|stolen/i, "Theft"],
  [/vandal|graffiti|property damage|destruction|mischief/i, "Vandalism"],
  [/welfare|check on/i, "Welfare check"],
  [/missing|runaway/i, "Missing person"],
  [/narcotic|drug/i, "Drug activity"],
  [/alarm/i, "Alarm"],
  [/parking|abandoned vehicle/i, "Parking or abandoned vehicle"],
];

/** Incidents of these kinds are worth a story on their own. */
const NOTABLE = /^(Building fire|Vehicle fire|Outdoor fire|Fire|Shots fired|Robbery|Rescue|Traffic collision|Missing person|Gas leak or hazardous materials|Assault or fight|Weapon reported|Burglary|Stolen vehicle)$/;
export const NOTABLE_UNITS = 3;

export function tidyCode(text: string) {
  const value = String(text ?? "").replace(/^[^A-Za-z0-9]+/, "").replace(/\s+/g, " ").trim().replace(/^-+|-+$/g, "").trim();
  return value === value.toUpperCase() ? value.charAt(0) + value.slice(1).toLowerCase() : value;
}
export function plainCall(raw: string) {
  for (const [pattern, label] of CALL_PLAIN) if (pattern.test(raw ?? "")) return label;
  return tidyCode(raw) || "Call for service";
}
/** '5432 Ballard Ave NW' -> '5400 block of Ballard Ave NW'. */
export function toBlock(address: string) {
  const value = String(address ?? "").replace(/\s+/g, " ").trim();
  const match = /^(\d+)[A-Za-z]?\s+(?!block\b|blk\b)(.+)$/i.exec(value);
  if (match) return `${Math.floor(Number(match[1]) / 100) * 100} block of ${match[2]}`;
  return value.replace(/\b(\d+)\s+blk\b/i, "$1 block of");
}
export function mapLink(lat: number | null, lon: number | null) {
  return lat === null || lon === null ? null : `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}`;
}

export type Call = { id: string; at: Date; raw: string; what: string; block: string; outcome: string; priority: string; area: string; lat: number | null; lon: number | null; units: number };
export type Incident = { key: string; first: Date; last: Date; block: string; area: string; calls: Call[]; what: string; lat: number | null; lon: number | null; outcome: string; priority: string };

const RANK = (what: string) => {
  const order = ["Building fire", "Shots fired", "Rescue", "Robbery", "Traffic collision", "Vehicle fire", "Outdoor fire", "Fire", "Gas leak or hazardous materials", "Missing person", "Assault or fight", "Weapon reported", "Burglary", "Stolen vehicle"];
  const index = order.indexOf(what);
  return index < 0 ? order.length : index;
};

/** Calls at the same block (or within 150 m) within two hours become one incident. */
export function groupIncidents(calls: Call[]): Incident[] {
  const sorted = [...calls].sort((a, b) => a.at.getTime() - b.at.getTime());
  const incidents: Incident[] = [];
  for (const call of sorted) {
    const near = (incident: Incident) => {
      if (call.at.getTime() - incident.last.getTime() > 2 * 3600_000) return false;
      if (call.block && incident.block && call.block.toLowerCase() === incident.block.toLowerCase()) return true;
      if (call.lat !== null && call.lon !== null && incident.lat !== null && incident.lon !== null) {
        const dLat = (call.lat - incident.lat) * 111_000, dLon = (call.lon - incident.lon) * 111_000 * Math.cos(call.lat * Math.PI / 180);
        return Math.hypot(dLat, dLon) < 150;
      }
      return false;
    };
    const match = incidents.find(near);
    if (match) {
      match.calls.push(call);
      match.last = call.at;
      if (RANK(call.what) < RANK(match.what)) match.what = call.what;
      match.outcome ||= call.outcome;
      match.priority ||= call.priority;
    } else {
      incidents.push({ key: call.id, first: call.at, last: call.at, block: call.block, area: call.area, calls: [call], what: call.what, lat: call.lat, lon: call.lon, outcome: call.outcome, priority: call.priority });
    }
  }
  return incidents;
}

export function units(incident: Incident) {
  return incident.calls.reduce((sum, call) => sum + Math.max(1, call.units), 0);
}
export function notable(incident: Incident) {
  return NOTABLE.test(incident.what) || units(incident) >= NOTABLE_UNITS || /^1$|^p1$|high|emergency/i.test(incident.priority.trim());
}

export function counts(calls: Call[]) {
  const by = new Map<string, number>();
  for (const call of calls) by.set(call.what, (by.get(call.what) ?? 0) + 1);
  return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
