/** Run the production writer locally on frozen real-source inputs. Never publishes.
 * Usage: node scripts/review-article-sample.mjs INPUT.json OUTPUT.json [installed-ollama-model]
 * Add --revalidate to check saved generated drafts without model calls.
 * This is a writer-only diagnostic, not a full edition, locality, or publication run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const revalidate = process.argv.includes('--revalidate');
const verifySaved = process.argv.includes('--verify-saved');
const [inputPath, outputPath, selectedModel = 'llama3.2:latest'] = process.argv.slice(2).filter((arg) => arg !== '--revalidate' && arg !== '--verify-saved');
if (!inputPath || !outputPath) throw new Error('Provide INPUT.json and OUTPUT.json; no defaults overwrite saved evidence.');
if (resolve(inputPath) === resolve(outputPath)) throw new Error('Output must not overwrite the input evidence.');
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root: site, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { writeItem, itemPrompt, validateItem, WRITING_POLICY } = await server.ssrLoadModule('/pipeline/model/story-writer.ts');
  const { verifyArticle, VERIFICATION_POLICY } = await server.ssrLoadModule('/pipeline/model/claim-verifier.ts');
  const { OllamaRuntime } = await server.ssrLoadModule('/pipeline/model/runtime.ts');
  const { emptyDetails, mergeDetails, detailsText } = await server.ssrLoadModule('/pipeline/editions/details.ts');
  const { floorFlags, floorInstructions } = await server.ssrLoadModule('/pipeline/editorial/floor.ts');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  if (revalidate) {
    const result = { checked_at: new Date().toISOString(), writing_policy: WRITING_POLICY, scope: 'Revalidation of saved drafts only. No regeneration, model calls or publication.', baseline: resolve(inputPath), items: input.items.map((sample) => {
      const errors = sample.result.draft ? validateItem(sample.input, sample.result.draft) : ['no_draft'];
      return { review_id: sample.review_id, baseline_disposition: sample.result.disposition, disposition: errors.length ? 'held' : 'checks_passed', validation_errors: errors };
    }) };
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } else {
  const model = new OllamaRuntime('http://127.0.0.1:11434', selectedModel);
  const health = await model.health();
  if (health.status !== 'ok') throw new Error(health.detail);
  await writeFile(outputPath, '{}\n', { flag: 'wx' });
  const output = { started_at: new Date().toISOString(), scope: input.scope, provider: model.provider, model: selectedModel, writing_policy: WRITING_POLICY, input_path: resolve(inputPath), published: false, full_pipeline: false, items: [] };
  for (const sample of input.items) {
    if (verifySaved) {
      const draft = sample.result.draft;
      const verification = draft ? await verifyArticle(model, sample.input, draft) : { checks_passed: false, errors: ['no_draft'], claims: [] };
      output.items.push({ review_id: sample.review_id, baseline_disposition: sample.result.disposition, verification_policy: VERIFICATION_POLICY, draft, verification });
      output.updated_at = new Date().toISOString();
      await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
      console.log(JSON.stringify({ id: sample.review_id, verified: verification.checks_passed, errors: verification.errors }));
      continue;
    }
    const facts = sample.facts;
    const details = mergeDetails(emptyDetails(), facts.details);
    const flags = floorFlags(facts);
    const story = { ...facts, as_of: input.as_of ?? null, id: sample.review_id, description: [detailsText(details, { withholdPeople: flags.withholdNames }), facts.description ?? ''].filter(Boolean).join(' '), floor_flags: flags, floor_instructions: floorInstructions(flags), people: details.people, venues: facts.venue ? [facts.venue] : [] };
    const result = await writeItem(model, story, { verify: true });
    output.items.push({ review_id: sample.review_id, title: facts.title, source_url: facts.source_url, input: story, prompt: itemPrompt(story), result });
    output.updated_at = new Date().toISOString();
    await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify({ id: sample.review_id, disposition: result.disposition, errors: result.validation_errors, seconds: result.wall_seconds }));
  }
  }
} finally { await server.close(); }
