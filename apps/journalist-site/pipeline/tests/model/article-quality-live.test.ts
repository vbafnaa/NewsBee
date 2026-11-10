/** Opt-in actual local-model evaluation. Output is review evidence, never publication. */
import { it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { OllamaRuntime } from "../../model/runtime";
import { writeItem, WRITING_POLICY, type StoryInput } from "../../model/story-writer";
import { rank } from "../../model/newsworthiness";

it.skipIf(process.env.NEWSBEE_ARTICLE_EVAL !== "1")("evaluates actual model writing and ranking against recorded sources and civic fixtures", async () => {
  const output = process.env.NEWSBEE_ARTICLE_EVAL_OUTPUT;
  if (!output) throw new Error("Set NEWSBEE_ARTICLE_EVAL_OUTPUT to a local JSON report path");
  const model = new OllamaRuntime("http://127.0.0.1:11434", process.env.NEWSBEE_ARTICLE_EVAL_MODEL ?? "qwen2.5-coder:latest");
  expect((await model.health()).status).toBe("ok");
  const recorded = JSON.parse(readFileSync(resolve("../../research/evidence/reader_repairs/2026-11-07T02-43-03-636Z/results.json"), "utf8"));
  const events = recorded.results.flatMap((result: { events?: StoryInput[] }) => result.events ?? []);
  const titles = ["No School Veterans Day", "Family Story Time", "Genealogy Drop-In"];
  const stories: StoryInput[] = titles.map((title, index) => {
    const event = events.find((item: StoryInput) => item.title === title);
    if (!event) throw new Error(`Missing recorded event: ${title}`);
    return { ...event, id: `recorded-${index}`, venues: event.venue ? [String(event.venue)] : [] };
  });
  stories.push(
    { id: "proposal", title: "Cedar Park playground proposal", kind: "local_news", description: "The council will consider a proposal for a Cedar Park playground on Tuesday. No vote has taken place. The proposed budget is $50,000. Residents can submit comments before the meeting.", venues: ["Cedar Park"] },
    { id: "approved", title: "Cedar Park playground approved", kind: "local_news", description: "The council approved $50,000 for a Cedar Park playground on Tuesday. Construction has not started. The council will publish a construction schedule after selecting a contractor.", venues: ["Cedar Park"] },
    { id: "sparse", title: "Garden meeting", kind: "local_news", description: "A garden meeting is planned. Further details have not been announced.", venues: [] },
  );
  const report = { scope: "Local Ollama writing/ranking only; recorded public connector text plus explicitly synthetic civic fixtures; no production data writes or publication", model: model.model, policy: WRITING_POLICY, started_at: new Date().toISOString(), stories: [] as unknown[], ranking: null as unknown };
  const save = () => { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2)); };
  save();
  for (const story of stories) {
    const result = await writeItem(model, story);
    report.stories.push({ source_kind: story.id.startsWith("recorded-") ? "recorded_public_connector" : "synthetic_fixture", input: story, result }); save();
    console.log(story.id, result.disposition, result.validation_errors ?? result.error);
  }
  const candidates = stories.map((story) => ({ ...story, occurrences: 1, venues: story.venues ?? [], first_date: "2026-11-08" }));
  const [ranked, details] = await rank(model, candidates);
  report.ranking = { ranked, details }; save();
  console.log("Article evaluation saved:", output);
}, 1800_000);
