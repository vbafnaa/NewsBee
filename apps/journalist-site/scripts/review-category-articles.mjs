/** Unpublished, loopback-only writer evaluation. No provider keys, publishing, or policy changes.
 * node scripts/review-category-articles.mjs INPUT.json OUTPUT.json [installed Ollama model]
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const args=process.argv.slice(2); const revalidate=args.includes('--revalidate'); const resume=revalidate||args.includes('--resume'); const onlyArg=args.find(x=>x.startsWith('--only='));
const [inputPath, outputPath, selectedModel='mistral:latest']=args.filter(x=>!x.startsWith('--'));
const only=onlyArg?new Set(onlyArg.slice(7).split(',')):null;
if (!inputPath || !outputPath || resolve(inputPath)===resolve(outputPath)) throw new Error('Use separate input and output files.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const server=await createServer({root,configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
 const {writeItem,WRITING_POLICY,requiredDetails,validateItem,sourceBrief}=await server.ssrLoadModule('/pipeline/model/story-writer.ts');
 const {OllamaRuntime}=await server.ssrLoadModule('/pipeline/model/runtime.ts');
 const {groupItems}=await server.ssrLoadModule('/pipeline/editions/assemble.ts');
 const {floorFlags,floorInstructions}=await server.ssrLoadModule('/pipeline/editorial/floor.ts');
 const input=JSON.parse(await readFile(inputPath,'utf8'));
 const model=new OllamaRuntime('http://127.0.0.1:11434',selectedModel);
 if(!revalidate){const health=await model.health();if(health.status!=='ok')throw new Error(health.detail);}
 let output={scope:input.scope,as_of:input.as_of,model:selectedModel,policy:WRITING_POLICY,started_at:new Date().toISOString(),published:false,full_pipeline:false,items:[]};
 await mkdir(dirname(resolve(outputPath)),{recursive:true});
 if(resume){output=JSON.parse(await readFile(outputPath,'utf8'));delete output.finished_at;output.policy=WRITING_POLICY;}else await writeFile(outputPath,JSON.stringify(output,null,2),{flag:'wx'});
 for(const sample of input.items){
  if(only&&!only.has(sample.review_id))continue;
  const prior=output.items.find(x=>x.id===sample.review_id);
  if(resume&&!only&&prior&&!revalidate)continue;
  const documents=sample.sources??[sample.facts];
  const groups=groupItems(documents);
  const merged=documents.length===1 || new Set(groups).size===1;
  const facts=sample.facts;
  const description=documents.map(s=>s.description??'').join('\n');
  const flags=floorFlags({...facts,description});
  const story={...facts,id:sample.review_id,description,as_of:input.as_of,source_date:facts.event_date,venues:facts.venue?[facts.venue]:[],floor_flags:flags,floor_instructions:floorInstructions(flags),people:[],verification_sources:documents.map((s,i)=>({id:`source-${i+1}`,url:s.source_url,text:[s.title,s.description??'',s.schedule_text??''].filter(Boolean).join('\n')}))};
  let result;
  if(revalidate&&prior){
    const brief=prior.result.source_brief?sourceBrief(story):null;
    const draft=brief?.draft??prior.result.draft;
    const errors=!merged?['unresolved_merge_group']:!draft?['no_draft']:prior.result.source_brief&&!brief?['source_brief:unavailable']:validateItem(story,draft);
    result={...prior.result,...(brief??{}),policy:WRITING_POLICY,draft,validation_errors:errors,checks_passed:errors.length===0,disposition:errors.length?'held':'checks_passed',deterministic_revalidated_at:new Date().toISOString()};
  }else result=merged?await writeItem(model,story,{verify:true}):{disposition:'held',checks_passed:false,validation_errors:['unresolved_merge_group']};
  if(prior){output.previous_attempts??=[];output.previous_attempts.push(prior);output.items=output.items.filter(x=>x.id!==sample.review_id);}
  output.items.push({id:sample.review_id,category:sample.category,capture:sample.source_capture??'Selected factual source excerpt; checked November 9, 2026',source_date:facts.event_date,schedule:facts.schedule_text??null,venue:facts.venue??null,required_details:requiredDetails(story).map(({id,quote})=>({id,quote})),sources:documents.map(s=>({name:s.source_name,url:s.source_url,title:s.title,date:s.event_date})),merging:{input_documents:documents.length,groups,merged},result});
  output.updated_at=new Date().toISOString();await writeFile(outputPath+'.tmp',JSON.stringify(output,null,2));await rename(outputPath+'.tmp',outputPath);
  console.log(JSON.stringify({id:sample.review_id,status:result.disposition,errors:result.validation_errors,brief:result.source_brief,seconds:result.wall_seconds}));
 }
 output.finished_at=new Date().toISOString();output.items.sort((a,b)=>input.items.findIndex(x=>x.review_id===a.id)-input.items.findIndex(x=>x.review_id===b.id));await writeFile(outputPath+'.tmp',JSON.stringify(output,null,2));await rename(outputPath+'.tmp',outputPath);
} finally {await server.close();}
