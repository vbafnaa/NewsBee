# Source runs: what to change before production

The source map pipeline (Pipeline 1) is a "find all sources" run. It runs about once or twice a
month for each place. Today it is set up for **testing**: every run is exhaustive, test mode keeps
each run's results apart, and the limits are sized to compare tools rather than to run cheaply.

This is a checklist, not code. Once testing is done, decide and change each item below.

## 1. Which tools to keep

- [ ] Decide which search and reading services stay: **Dorking** (Bright Data or SerpApi),
      **Exa**, **Tavily**, **ScrapingBee** and **Bright Data** page opening.
- [ ] Base it on the tool diagnostics in Source runs → a run → **By tool** and the **Search grid**:
      "Found only by this tool", accepted pages only this tool found, and hits per search (the yield
      curve). A tool that rarely finds anything the others don't is a candidate to drop.

## 2. How many tries each tool gets

- [ ] The misses in a row before a cell goes dry: now 3 (`general.stop.agent_cell_dry`), and 2 for
      Dorking (`general.stop.agent_cell_dry_dork`).
- [ ] The angles: the 12 families and each category's vocabulary (`playbook/general.yaml`). Drop
      families that never produce hits.
- [ ] The share per category: each tool's per-run cap divided by the number of categories. It
      follows the caps in section 3.
- [ ] Proposals a round (`general.stop.agent_round_proposals`, now 40) and triage chunk sizes
      (`agent_triage_categories`, `agent_triage_results`).

## 3. Which limits to set

- [ ] Per-run caps for each service (the run budgets in `NEWSBEE_PAID_BUDGETS` and the hard limits
      in `playbook/general.yaml`, `general.stop.limit_*`).
- [ ] Monthly allowances: Tavily's 900 credits, SerpApi's monthly searches, Exa's spend guard and
      Bright Data's 4,000 requests.
- [ ] Gemini's 450 calls a day are shared with the rest of Newsbee (editions, the model check,
      the final review). A full exhaustive run is expected to use about 60 to 100 model calls, so
      only a few runs fit in a day.
- [ ] **Exhaustive-only is a testing choice.** Production needs a cheaper mode (for example, stop
      once each category has enough good sources) or a paid model tier.

## 4. How the work is batched so Vercel doesn't time out

- [ ] Today the work runs as jobs of about 200 seconds. Each job saves the round's state after
      every step, and the next job resumes at the saved step.
- [ ] **Known gap:** if a job crashes or never starts, the run stays at "running" and nothing
      resumes it. Add a watchdog or a queue that retries stuck runs before production.
- [ ] Consider moving long runs off serverless functions, for example to a worker or a scheduled
      job host, so a run isn't cut into short jobs at all.

## 5. Roll back test mode

- [x] Runs write the source map again: `NEWSBEE_SOURCE_RUNS_ISOLATED` is off by default (Nov 10, 2026),
      and decisions made on test-mode pages still stand. Check that the deployment doesn't set it
      to `on` in its environment, which would still win.
- [x] What passes both checks goes live: `NEWSBEE_PROPOSED_UNTIL_APPROVED` is off by default
      (Nov 10, 2026). A source that passes the code check and that the model check accepts goes on
      active with no approval; a model check rejection is a rejected row a person can overrule; a
      source not judged waits as proposed and is never read. Check the deployment doesn't set it
      to `on`, which would still hold everything as proposed.
