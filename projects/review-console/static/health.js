const $ = (selector) => document.querySelector(selector);
const summary = $("#summary");
const refresh = $("#refresh");
const windowSelect = $("#window");
const SVG = "http://www.w3.org/2000/svg";
let inFlight = false;

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function percent(rate) {
  return rate === null || rate === undefined ? "–" : `${Math.round(rate * 1000) / 10}%`;
}

function age(seconds) {
  if (seconds === null || seconds === undefined) return "never";
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 360) / 10}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function tone(value, good, warn, higherIsBetter = true) {
  if (value === null || value === undefined) return "neutral";
  if (higherIsBetter) return value >= good ? "ok" : value >= warn ? "warn" : "bad";
  return value <= good ? "ok" : value <= warn ? "warn" : "bad";
}

const STATUS_TONES = {
  ok: "ok", ready: "ok", completed: "ok", ingested: "ok",
  not_configured: "neutral", not_implemented: "neutral", pending: "neutral", running: "neutral",
  no_feed: "warn", unresolved_website: "warn", blocked: "warn",
};

function statusTiles(list, entries) {
  list.replaceChildren();
  for (const [name, item] of entries) {
    list.append(element("li", { class: `tile ${STATUS_TONES[item.status] ?? "bad"}`, title: item.detail },
      element("strong", {}, `${name}: ${item.status}`),
      element("span", { class: "detail" }, item.detail)));
  }
}

function kpi(label, value, detail, state = "neutral") {
  return element("div", { class: `kpi ${state}` },
    element("span", { class: "label" }, label),
    element("span", { class: "value" }, String(value)),
    element("span", { class: "detail" }, detail));
}

function barChart(container, days, series, label) {
  container.replaceChildren();
  const width = 480, height = 100, pad = 18;
  const totals = days.map((day) => series.reduce((sum, item) => sum + day[item.key], 0));
  const max = Math.max(1, ...totals);
  const slot = (width - pad) / days.length;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height + pad}`);
  svg.setAttribute("role", "img");
  const total = totals.reduce((sum, value) => sum + value, 0);
  svg.setAttribute("aria-label", `${label}: ${total} over ${days.length} days`);
  const axis = document.createElementNS(SVG, "text");
  axis.setAttribute("x", 0);
  axis.setAttribute("y", 10);
  axis.setAttribute("class", "axis");
  axis.textContent = String(max);
  svg.append(axis);
  days.forEach((day, index) => {
    let y = height;
    for (const item of series) {
      const value = day[item.key];
      if (!value) continue;
      const barHeight = (value / max) * (height - 14);
      y -= barHeight;
      const bar = document.createElementNS(SVG, "rect");
      bar.setAttribute("x", pad + index * slot + slot * 0.15);
      bar.setAttribute("y", y);
      bar.setAttribute("width", slot * 0.7);
      bar.setAttribute("height", barHeight);
      bar.setAttribute("class", item.cls);
      const tip = document.createElementNS(SVG, "title");
      tip.textContent = `${day.day}: ${value} ${item.label}`;
      bar.append(tip);
      svg.append(bar);
    }
    const every = Math.ceil(days.length / 7);
    if (index % every === 0 || index === days.length - 1) {
      const tick = document.createElementNS(SVG, "text");
      tick.setAttribute("x", pad + index * slot + slot / 2);
      tick.setAttribute("y", height + 13);
      tick.setAttribute("text-anchor", "middle");
      tick.setAttribute("class", "axis");
      tick.textContent = day.day.slice(5);
      svg.append(tick);
    }
  });
  const baseline = document.createElementNS(SVG, "line");
  baseline.setAttribute("x1", pad);
  baseline.setAttribute("x2", width);
  baseline.setAttribute("y1", height);
  baseline.setAttribute("y2", height);
  baseline.setAttribute("class", "baseline");
  svg.append(baseline);
  container.append(svg);
  container.append(element("div", { class: "legend" },
    ...series.map((item) => element("span", { class: `key ${item.cls}` }, item.label)),
    element("span", { class: "muted" }, `total ${total}`)));
}

function table(target, headers, rows, empty = "None") {
  if (rows.length === 0) {
    target.replaceChildren(element("caption", {}, empty));
    return;
  }
  target.replaceChildren(
    element("thead", {}, element("tr", {}, ...headers.map((header) => element("th", { scope: "col" }, header)))),
    element("tbody", {}, ...rows.map((cells) => element("tr", {},
      ...cells.map((cell) => cell instanceof Node ? element("td", {}, cell) : element("td", {}, String(cell)))))));
}

function badge(text, state) {
  return element("span", { class: `badge ${state}` }, text);
}

function renderHealth(report) {
  summary.textContent = `Ingestion: ${report.capabilities.ingestion.status}. All-service health: ${report.status}.`;
  statusTiles($("#services"), Object.entries(report.components));
  statusTiles($("#capabilities"), Object.entries(report.capabilities));
  const run = report.latest_ingestion;
  $("#latest-ingestion").textContent = report.jobs === null
    ? "Latest ingestion unavailable"
    : run === null ? "No ingestion runs yet"
    : `${run.location_id}: ${run.status} (attempts: ${run.attempts}, job: ${run.id})`
      + (run.event_count === null ? "" : `; events: ${run.event_count}`)
      + (run.skipped_other_venues === null ? "" : `; other venues skipped: ${run.skipped_other_venues}`)
      + (run.skipped_outside_window === null ? "" : `; outside 7-day window: ${run.skipped_outside_window}`)
      + (run.duration_seconds === null ? "" : `; duration: ${run.duration_seconds}s`)
      + (run.error ? `; last attempt error: ${run.error}` : "");
  const locations = $("#locations");
  locations.replaceChildren();
  if (report.locations === null) locations.textContent = "Location status unavailable";
  else if (report.locations.length === 0) locations.textContent = "No onboarded locations";
  for (const location of report.locations ?? []) {
    const latest = location.latest_ingestion;
    const systems = (latest?.systems ?? [])
      .map((system) => `${system.name}: ${system.status} (${system.event_count} events)`)
      .join("; ");
    locations.append(element("li", {}, `${location.name}: ${location.websites_resolved}/${location.library_systems} websites resolved; `
      + (latest ? `latest ingestion ${latest.status}` : "not ingested yet")
      + (location.latest_edition_id ? "; edition published" : "; no edition yet")
      + (systems ? ` - ${systems}` : "")));
  }
  const edition = report.latest_edition;
  $("#latest-edition").textContent = report.jobs === null
    ? "Latest edition unavailable"
    : !edition ? "No editions yet"
    : `${edition.community_id}, ${edition.window_start} to ${edition.window_end}: ${edition.status} (model: ${edition.model})`
      + (edition.included === null ? "" : `; included: ${edition.included}`)
      + (edition.held === null ? "" : `; held: ${edition.held}`)
      + (edition.attempted === null ? "" : `; attempted: ${edition.attempted}`)
      + (edition.stories === null || edition.stories === undefined ? "" : `; stories: ${edition.stories}`)
      + (edition.ranking_fallback_ratings ? `; rule-rated: ${edition.ranking_fallback_ratings}` : "")
      + (edition.front_fallback === null || edition.front_fallback === undefined ? ""
        : `; headline: ${edition.front_fallback ? "fixed fallback" : "model"}`)
      + (edition.duration_seconds === null ? "" : `; duration: ${edition.duration_seconds}s`)
      + (edition.error ? `; error: ${edition.error}` : "");
  const emails = $("#email-deliveries");
  emails.replaceChildren();
  if (report.email_deliveries === null || report.email_deliveries === undefined) {
    emails.textContent = "Email delivery status unavailable";
  } else if (report.email_deliveries.length === 0) {
    emails.textContent = "No email previews yet";
  }
  for (const sent of report.email_deliveries ?? []) {
    emails.append(element("li", {}, `${sent.location_id}: sent ${sent.sent}, pending ${sent.pending}, failed ${sent.failed}`
      + (sent.errors.length ? ` - ${sent.errors.join("; ")}` : "")));
  }
  $("#jobs").textContent = report.jobs === null
    ? "Job counts unavailable"
    : Object.entries(report.jobs).map(([status, count]) => `${status}: ${count}`).join("\n");
  $("#completed").textContent = report.last_completed_job_at === null
    ? "Last completed job: none"
    : `Last completed job: ${new Date(report.last_completed_job_at * 1000).toISOString()}`;
}

function clearHealth(error) {
  summary.textContent = `Health unavailable: ${error.message}`;
  for (const id of ["#services", "#capabilities", "#locations", "#email-deliveries"]) {
    $(id).replaceChildren();
  }
  $("#latest-ingestion").textContent = "Latest ingestion unavailable";
  $("#latest-edition").textContent = "Latest edition unavailable";
  $("#jobs").textContent = "Unavailable";
  $("#completed").textContent = "Last completed job: unavailable";
}

function renderMetrics(metrics, health) {
  $("#metrics-error").hidden = true;
  $("#window-label").textContent = metrics.window_days === 1 ? "(last 24 hours)" : `(last ${metrics.window_days} days)`;
  const { ingestion, editions, email, queue } = metrics;
  $("#kpis").replaceChildren(
    kpi("Ingestion success", percent(ingestion.success_rate),
      `${ingestion.completed}/${ingestion.runs} runs; ${ingestion.retried} retried`,
      tone(ingestion.success_rate, 0.95, 0.8)),
    kpi("Events ingested", ingestion.events,
      `median run ${ingestion.median_duration_seconds ?? "–"}s; p95 ${ingestion.p95_duration_seconds ?? "–"}s`),
    kpi("Editions published", editions.completed,
      `${percent(editions.publish_rate)} of ${editions.runs} runs; median ${editions.median_duration_seconds ?? "–"}s`,
      tone(editions.publish_rate, 0.95, 0.8)),
    kpi("Items held", percent(editions.held_rate),
      `${editions.held} held; ${editions.included} published`,
      tone(editions.held_rate, 0.2, 0.4, false)),
    kpi("Model fallback", percent(editions.ranking_fallback_rate),
      `${editions.ranking_fallback_ratings}/${editions.ranked} rule-rated; ${editions.headline_fallbacks} fixed headlines`,
      tone(editions.ranking_fallback_rate, 0.05, 0.25, false)),
    kpi("Email delivery", percent(email.delivery_rate),
      `sent ${email.sent}; pending ${email.pending}; failed ${email.failed}`,
      tone(email.delivery_rate, 0.99, 0.9)),
    kpi("Queue depth", queue.pending + queue.running,
      `${queue.pending} pending; ${queue.running} running; oldest ${queue.oldest_pending_age_seconds === null ? "–" : age(queue.oldest_pending_age_seconds)}`,
      tone(queue.oldest_pending_age_seconds ?? 0, 300, 1800, false)),
    kpi("Failed jobs (24h)", queue.failed_last_24h, "after all retries",
      queue.failed_last_24h ? "bad" : "ok"),
    kpi("Worker heartbeat", age(queue.worker_heartbeat_age_seconds), "updates every few seconds",
      queue.worker_heartbeat_age_seconds === null ? "bad" : tone(queue.worker_heartbeat_age_seconds, 15, 60, false)),
  );
  const runs = [{ key: "completed", label: "completed", cls: "ok" }, { key: "failed", label: "failed", cls: "bad" }];
  barChart($("#ingestion-chart"), ingestion.daily, runs, "Ingestion runs");
  barChart($("#events-chart"), ingestion.daily, [{ key: "items", label: "events", cls: "info" }], "Events ingested");
  barChart($("#editions-chart"), editions.daily, runs, "Edition runs");
  barChart($("#published-chart"), editions.daily, [{ key: "items", label: "items", cls: "info" }], "Items published");
  table($("#sources"), ["Source type", "Sources", "Ingested", "Events"],
    ingestion.by_source.map((source) => [
      source.kind === "government" ? "Government meetings" : "Libraries",
      source.sources,
      badge(`${source.ingested}/${source.sources}`, source.sources ? tone(source.ingested / source.sources, 1, 0.5) : "neutral"),
      source.events,
    ]));
  table($("#queue"), ["Job kind", "Pending", "Running", "Failed (24h)"],
    Object.entries(queue.by_kind).map(([kind, counts]) => [
      kind, counts.pending, counts.running,
      badge(String(counts.failed_last_24h), counts.failed_last_24h ? "bad" : "ok"),
    ]), "No queued, running or recently failed jobs");
  const websites = new Map((health?.locations ?? []).map((location) => [location.id, location]));
  table($("#location-table"), ["Location", "Latest ingestion", "Last ingested", "Events", "Sources ingested", "Websites", "Government", "Last published"],
    metrics.locations.map((location) => {
      const site = websites.get(location.id);
      return [
        location.name,
        badge(location.ingestion_status ?? "never", STATUS_TONES[location.ingestion_status] ?? (location.ingestion_status ? "bad" : "neutral")),
        badge(age(location.last_ingested_age_seconds), tone(location.last_ingested_age_seconds ?? Infinity, 86400, 604800, false)),
        location.events ?? "–",
        `${location.sources_ingested}/${location.sources}`,
        site ? `${site.websites_resolved}/${site.library_systems}` : "–",
        location.government_platform ?? "none",
        badge(age(location.last_published_age_seconds), tone(location.last_published_age_seconds ?? Infinity, 86400 * 2, 86400 * 8, false)),
      ];
    }), "No onboarded locations");
}

function clearMetrics(error) {
  const banner = $("#metrics-error");
  banner.hidden = false;
  banner.textContent = `Metrics unavailable: ${error.message}`;
  for (const id of ["#kpis", "#ingestion-chart", "#events-chart", "#editions-chart", "#published-chart", "#sources", "#queue", "#location-table"]) {
    $(id).replaceChildren();
  }
}

async function getJson(url, accepted) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!accepted.includes(response.status)) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function refreshDashboard() {
  if (inFlight) return;
  inFlight = true;
  refresh.disabled = true;
  summary.textContent = "Checking local services...";
  const [health, metrics] = await Promise.allSettled([
    getJson("/api/health", [200, 503]).then((report) => {
      if (!["ok", "degraded"].includes(report.status) || !report.components || !report.capabilities) {
        throw new Error("Health API returned an invalid report");
      }
      return report;
    }),
    getJson(`/api/metrics?days=${windowSelect.value}`, [200]),
  ]);
  try {
    if (health.status === "fulfilled") renderHealth(health.value);
    else clearHealth(health.reason);
  } catch (error) {
    clearHealth(error);
  }
  try {
    if (metrics.status === "fulfilled") renderMetrics(metrics.value, health.value);
    else clearMetrics(metrics.reason);
  } catch (error) {
    clearMetrics(error);
  }
  $("#updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  refresh.disabled = false;
  inFlight = false;
}

refresh.addEventListener("click", refreshDashboard);
windowSelect.addEventListener("change", refreshDashboard);
setInterval(() => {
  if ($("#auto").checked && !document.hidden) refreshDashboard();
}, 30000);
refreshDashboard();
