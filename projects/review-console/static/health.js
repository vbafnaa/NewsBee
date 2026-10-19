const summary = document.querySelector("#summary");
const refresh = document.querySelector("#refresh");

async function refreshHealth() {
  refresh.disabled = true;
  summary.textContent = "Checking local services...";
  try {
    const response = await fetch("/api/health", { signal: AbortSignal.timeout(10000) });
    if (response.status !== 200 && response.status !== 503) {
      throw new Error(`Health API returned HTTP ${response.status}`);
    }
    const report = await response.json();
    if (!["ok", "degraded"].includes(report.status) || !report.components
        || !report.capabilities) {
      throw new Error("Health API returned an invalid report");
    }
    summary.textContent = `Ingestion: ${report.capabilities.ingestion.status}. All-service health: ${report.status}.`;
    const capabilities = document.querySelector("#capabilities");
    capabilities.replaceChildren();
    for (const [name, capability] of Object.entries(report.capabilities)) {
      const item = document.createElement("li");
      item.textContent = `${name}: ${capability.status} - ${capability.detail}`;
      capabilities.append(item);
    }
    const run = report.latest_ingestion;
    document.querySelector("#latest-ingestion").textContent = report.jobs === null
      ? "Latest ingestion unavailable"
      : run === null ? "No ingestion runs yet"
      : `${run.location_id}: ${run.status} (attempts: ${run.attempts}, job: ${run.id})`
        + (run.event_count === null ? "" : `; events: ${run.event_count}`)
        + (run.skipped_other_venues === null ? "" : `; other venues skipped: ${run.skipped_other_venues}`)
        + (run.skipped_outside_window === null ? "" : `; outside 7-day window: ${run.skipped_outside_window}`)
        + (run.duration_seconds === null ? "" : `; duration: ${run.duration_seconds}s`)
        + (run.error ? `; last attempt error: ${run.error}` : "");
    const locations = document.querySelector("#locations");
    locations.replaceChildren();
    if (report.locations === null) {
      locations.textContent = "Location status unavailable";
    } else if (report.locations.length === 0) {
      locations.textContent = "No onboarded locations";
    }
    for (const location of report.locations ?? []) {
      const item = document.createElement("li");
      const latest = location.latest_ingestion;
      const systems = (latest?.systems ?? [])
        .map((system) => `${system.name}: ${system.status} (${system.event_count} events)`)
        .join("; ");
      item.textContent = `${location.name}: ${location.websites_resolved}/${location.library_systems} websites resolved; `
        + (latest ? `latest ingestion ${latest.status}` : "not ingested yet")
        + (location.latest_edition_id ? "; edition published" : "; no edition yet")
        + (systems ? ` - ${systems}` : "");
      locations.append(item);
    }
    const edition = report.latest_edition;
    document.querySelector("#latest-edition").textContent = report.jobs === null
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
    const services = document.querySelector("#services");
    services.replaceChildren();
    for (const [name, component] of Object.entries(report.components)) {
      const item = document.createElement("li");
      item.textContent = `${name}: ${component.status} - ${component.detail}`;
      services.append(item);
    }
    document.querySelector("#jobs").textContent = report.jobs === null
      ? "Job counts unavailable"
      : Object.entries(report.jobs).map(([status, count]) => `${status}: ${count}`).join("\n");
    document.querySelector("#completed").textContent = report.last_completed_job_at === null
      ? "Last completed job: none"
      : `Last completed job: ${new Date(report.last_completed_job_at * 1000).toISOString()}`;
  } catch (error) {
    summary.textContent = `Health unavailable: ${error.message}`;
    document.querySelector("#services").replaceChildren();
    document.querySelector("#capabilities").replaceChildren();
    document.querySelector("#locations").replaceChildren();
    document.querySelector("#latest-ingestion").textContent = "Latest ingestion unavailable";
    document.querySelector("#latest-edition").textContent = "Latest edition unavailable";
    document.querySelector("#jobs").textContent = "Unavailable";
    document.querySelector("#completed").textContent = "Last completed job: unavailable";
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", refreshHealth);
refreshHealth();
