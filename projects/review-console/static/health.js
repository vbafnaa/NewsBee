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
    if (!["ok", "degraded"].includes(report.status) || !report.components) {
      throw new Error("Health API returned an invalid report");
    }
    summary.textContent = `Overall: ${report.status}`;
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
    document.querySelector("#jobs").textContent = "Unavailable";
    document.querySelector("#completed").textContent = "Last completed job: unavailable";
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", refreshHealth);
refreshHealth();
