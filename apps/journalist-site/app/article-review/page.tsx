import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redirect, notFound } from 'next/navigation';
import { currentPrincipal } from '@/lib/admin-session';
import AdminShell from '../admin-shell';
export const dynamic = 'force-dynamic';
type ReviewItem = {
 id:string; category:string; capture:string; source_date:string; schedule?:string; venue?:string;
 sources:Array<{name:string;url:string;date:string}>;
 merging:{input_documents:number;groups:number[];merged:boolean};
 required_details:Array<{id:string;quote:string}>;
 result:{disposition:string;draft?:{headline:string;summary:string};validation_errors?:string[];error?:string;source_brief?:boolean;attempts?:number;verification?:{checks_passed:boolean;method?:string}};
};
type Review = {scope:string;as_of:string;model:string;policy:string;finished_at?:string;items:ReviewItem[]};
export default async function ArticleReviewPage(){
 const principal=await currentPrincipal();if(!principal)redirect('/login');
 // Review evidence is a local development artifact, never Reader content.
 if(process.env.NEWSBEE_MODE!=='local'||process.env.VERCEL||process.env.NODE_ENV==='production')notFound();
 let report:Review|null=null;
 try{report=JSON.parse(await readFile(path.join(process.env.NEWSBEE_ROOT??path.resolve(process.cwd(),'../..'),'.local/article-review/report.json'),'utf8'));}catch{}
 const passed=report?.items.filter(x=>x.result.disposition==='checks_passed').length??0;
 return <AdminShell email={principal.email} page="locations" title="Article generation review" description="Local, unpublished category evaluation using the production writer and factual checks.">
  <section className="panel"><h2>Ten-category review</h2>
   <p>This is a writing and merging evaluation, not a current Wedgwood edition. Historical and Seattle-area source examples are labeled. No articles here are published to Reader.</p>
   {report?<><p><strong>{passed} validated · {report.items.length-passed} held · {report.items.length}/10 completed</strong> · {report.finished_at?'Finished':'Generation in progress'}</p><p>Model: {report.model} · Evidence as of {report.as_of}. <a href="/article-review">Refresh results</a></p><p>{report.scope}</p>
   <nav aria-label="Review categories">{report.items.map(item=><p key={item.id}><a href={`#${item.id}`}>{item.category}</a> — {item.result.disposition==='checks_passed'?'validated':'held'}</p>)}</nav></>:<p>No local review report yet.</p>}
  </section>
  {report?.items.map(item=><article className="panel" key={item.id} id={item.id}>
   <p><strong>{item.category}</strong> · {item.result.disposition==='checks_passed'?'Validated draft':'Held draft — needs review'}{item.result.source_brief?' · exact-source brief':''}</p>
   <h2>{item.result.draft?.headline??item.sources[0]?.name??item.id}</h2>
   {item.result.draft?<p>{item.result.draft.summary}</p>:<p>No publishable draft generated.</p>}
   <p><strong>Source record date:</strong> {item.source_date}{item.schedule?` · When: ${item.schedule}`:''}{item.venue?` · Where: ${item.venue}`:''}</p>
   <p>{item.capture}</p>
   {item.sources.length>1&&<p><strong>Merge test:</strong> {item.merging.input_documents} reports → {new Set(item.merging.groups).size} story group(s). Primary source is listed first.</p>}
   <p><strong>Sources:</strong></p><ol>{item.sources.map((source,index)=><li key={`${source.url}:${index}`}>{/^https?:\/\//i.test(source.url)?<a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a>:source.name} · {source.date}</li>)}</ol>
   {item.required_details.length>0&&<details><summary>Important source conditions checked</summary><ul>{item.required_details.map(fact=><li key={fact.id}>{fact.quote}</li>)}</ul></details>}
   {Boolean(item.result.validation_errors?.length)&&<p role="status">Review reasons: {item.result.validation_errors!.join('; ')}</p>}
   {item.result.error&&<p>Generation error: {item.result.error}</p>}
  </article>)}
 </AdminShell>;
}
