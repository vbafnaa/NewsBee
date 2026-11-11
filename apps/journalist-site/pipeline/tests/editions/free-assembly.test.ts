import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { assemble, collectedItems, type CollectedItem } from '../../editions/assemble';
import { loadSettings } from '../../core/config';
import { Fetcher } from '../../connectors/fetcher';
import { defaultRunOptions, withRunContext } from '../../core/run-options';
import type { LocationProfile } from '../../connectors/types';
vi.mock('../../connectors/locality',async(original)=>({...await original<typeof import('../../connectors/locality')>(),localityFor:async(context: {location:LocationProfile})=>({location:context.location,landmarks:[]})}));
let server:MongoMemoryServer,client:MongoClient,db:Db;
beforeAll(async()=>{server=await MongoMemoryServer.create();client=await MongoClient.connect(server.getUri());db=client.db('free-assembly');});
afterAll(async()=>{await client?.close();await server?.stop();});
beforeEach(async()=>{await db.dropDatabase();});
const location={id:'test',name:'Test, WA',state:'WA',systems:[],community:{name:'Fixture',parent_name:'Town',coverage_terms:[]}} as LocationProfile;
async function pool(facts:Record<string,unknown>[]){
  await collectedItems(db).insertMany(facts.map((f,i)=>({_id:`run:${i}`,run_id:'run',location_id:'test',source_id:`source:${i}`,source_name:'Fixture',created_at:1,status:'collected',reason:null,step:'reader',title:f.title,url:f.source_url,event_date:f.event_date,facts:{source_event_id:String(i),venue:'Library',schedule_text:'November 10',needs_locality:false,...f}} as CollectedItem)));
  const transport=vi.fn(async()=>{throw new Error('Unexpected network request');});
  return withRunContext({db,runId:'run',locationId:'test',options:{...defaultRunOptions({NEWSBEE_GUARDRAILS_OFF:'none'}),paid:{},count_history:false}},()=>assemble({db,runId:'run',location,today:'2026-11-06',settings:loadSettings({NEWSBEE_MODE:'local'}),transport,fetcher:new Fetcher(transport),log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
}
it('merges tracking URL variants of the same story across discovered source pages',async()=>{
  const result=await pool([{title:'Park restroom construction update',kind:'local_news',event_date:'2026-11-02',source_url:'https://example.org/update?utm_source=feed',tier:'local'},{title:'Updated restroom construction schedule',kind:'local_news',event_date:'2026-11-02',source_url:'https://example.org/update',tier:'local'}]);
  expect(result.funnel.after_merge).toBe(1);expect(result.funnel.pooled).toBe(1);
});
it('retains verified nearby library events while excluding unverified nearby events',async()=>{
  const result=await pool([{title:'Family Story Time',kind:'event',event_date:'2026-11-10',source_url:'https://example.org/1',tier:'nearby',serves_community:true,locality:{method:'verified_venue',distance_km:1.5,matches:['https://example.org/library']}},{title:'Distant poetry gathering',kind:'event',event_date:'2026-11-10',source_url:'https://example.org/2',tier:'nearby'}]);
  expect(result.funnel.pooled).toBe(1);expect(result.events[0].facts.tier).toBe('nearby');
  expect(await collectedItems(db).countDocuments({status:'dropped'})).toBe(1);
});

it('does not merge different events that share a calendar listing URL and day',async()=>{
  const result=await pool([{title:'Morning family story time',kind:'event',event_date:'2026-11-10',source_url:'https://example.org/calendar',tier:'local'},{title:'Evening genealogy workshop',kind:'event',event_date:'2026-11-10',source_url:'https://example.org/calendar',tier:'local'}]);
  expect(result.funnel.after_merge).toBe(2);
});

it('uses an authority-selected school calendar for closures without localizing its off-site events',async()=>{
  await db.collection('source_map').insertOne({location_id:'test',source_id:'source:0',name:'Fixture Elementary Calendar',url:'https://school.example/calendar',section:'schools',found_by:{method:'directories'},params:{directory_selection:'School name matches Fixture',authority_directory_url:'https://district.example/schools'}});
  await db.collection('source_map').insertOne({location_id:'test',source_id:'source:1',name:'Fixture Elementary Calendar',url:'https://school.example/calendar',section:'schools',found_by:{method:'directories'},params:{directory_selection:'School name matches Fixture',authority_directory_url:'https://district.example/schools'}});
  const result=await pool([{title:'No School Veterans Day',kind:'event',event_date:'2026-11-11',source_url:'https://school.example/closure',needs_locality:true},{title:'Enrollment Information Session',kind:'event',event_date:'2026-11-19',source_url:'https://district.example/enrollment',needs_locality:true}]);
  expect(result.funnel.pooled).toBe(1);expect(result.events[0].facts.locality).toMatchObject({method:'school_calendar_scope'});
});

it.each(["rejected", "paused", "proposed"])("does not pool previously collected items from a source now %s", async (status) => {
  await db.collection("source_map").insertOne({ location_id: "test", source_id: "source:0", status });
  const result = await pool([{ title: "Fixture council update", kind: "local_news", event_date: "2026-11-05", source_url: "https://example.org/update", tier: "local" }]);
  expect(result.funnel.pooled).toBe(0);
  expect(await collectedItems(db).findOne({ _id: "run:0" })).toMatchObject({ status: "dropped", step: "source_review", reason: expect.stringContaining(status) });
});

it('keeps same-title reports on different days separate',async()=>{
  const result=await pool(['2026-11-02','2026-11-03'].map(event_date=>({title:'Council considers housing proposal',kind:'news_report',event_date,source_url:`https://example.org/${event_date}`,tier:'local'})));
  expect(result.funnel.after_merge).toBe(2);expect(result.funnel.pooled).toBe(2);
});
it('keeps identically named events at different venues separate',async()=>{
  const result=await pool(['North Library','South Library'].map(venue=>({title:'Family Story Time',kind:'event',event_date:'2026-11-10',venue,source_url:'https://example.org/calendar',tier:'local'})));
  expect(result.funnel.after_merge).toBe(2);expect(result.funnel.pooled).toBe(2);
});
it('does not join an unrelated report to an incident on the same street',async()=>{
  const result=await pool([{title:'Vehicle collision reported',kind:'safety_incident',event_date:'2026-11-05',incident:{block:'100 block of Example Avenue'},source_url:'https://example.org/incident',tier:'local'},{title:'Example Avenue park receives funding',description:'Example Avenue park funding was announced.',kind:'news_report',event_date:'2026-11-05',source_url:'https://example.org/park',tier:'local'}]);
  expect(result.funnel.after_merge).toBe(2);
});
it('merges strongly matching reworded reports while retaining both occurrences',async()=>{
  const result=await pool([{title:'Dahl park restroom renovation schedule',kind:'local_news',event_date:'2026-11-05',source_url:'https://primary.example/renovation',tier:'local',source_tier:'official',source_name:'Parks Department'},{title:'Dahl park restroom renovation schedule update',kind:'news_report',event_date:'2026-11-05',source_url:'https://news.example/renovation',tier:'local',source_tier:'local_reporting',source_name:'Local News'}]);
  expect(result.funnel.after_merge).toBe(1);expect(result.events).toHaveLength(2);
});
it('does not transitively merge reports whose endpoints lack shared identity',async()=>{
  const result=await pool(['Dahl park restroom renovation','Dahl park restroom renovation project','Dahl park restroom project'].map((title,i)=>({title,kind:'news_report',event_date:'2026-11-05',source_url:`https://example.org/${i}`,tier:'local'})));
  expect(result.funnel.after_merge).toBe(2);
});
it('records conflicting structured times instead of silently choosing one',async()=>{
  const result=await pool(['10:00 AM','11:00 AM'].map((when,i)=>({title:'Library genealogy workshop',kind:'event',event_date:'2026-11-10',source_url:`https://example.org/${i}`,tier:'local',details:{when}})));
  expect(result.events.find(event=>event.facts.lead)?.facts.merge_conflicts).toEqual(['conflicting_source_times']);
});
it('preserves publication history across the more precise story identity',async()=>{
  const { recordPublished } = await import('../../editions/ledger');
  const { storyId } = await import('../../editions/stories');
  const legacy = storyId('news_report:council considers housing proposal');
  await recordPublished(db,'2026-10-26',{id:'old',location_id:'test',items:[{story_id:'precise-earlier-id',legacy_story_id:legacy,event_date:'2026-10-25',kind:'news_report'}]});
  const result=await pool([{title:'Council considers housing proposal',kind:'news_report',event_date:'2026-11-02',source_url:'https://example.org/report',tier:'local'}]);
  expect(result.funnel.pooled).toBe(0);
});
it('keeps the chosen primary source first after collapsing merged occurrences',async()=>{
  const { collapse } = await import('../../editions/stories');
  const result=await pool([{title:'Dahl park restroom renovation schedule',kind:'local_news',event_date:'2026-11-05',source_url:'https://primary.example/record',tier:'local',source_tier:'official',schedule_text:'November 5 afternoon'},{title:'Dahl park restroom renovation schedule update',kind:'news_report',event_date:'2026-11-05',source_url:'https://news.example/report',tier:'local',source_tier:'local_reporting',schedule_text:'November 5 morning'}]);
  expect(collapse(result.events)[0].first.source_url).toBe('https://primary.example/record');
});
it('keeps similarly worded reports about different named places separate',async()=>{
  const result=await pool(['Cedar','Maple'].map((park,i)=>({title:`Council approves new park renovation project at ${park}`,kind:'news_report',event_date:'2026-11-05',source_url:`https://example.org/${i}`,tier:'local'})));
  expect(result.funnel.after_merge).toBe(2);
});
it('does not treat a newsroom listing URL as the identity of every story on it',async()=>{
  const result=await pool([{title:'Cedar playground renovation announcement',kind:'news_report',event_date:'2026-11-05',source_url:'https://example.org/news',tier:'local'},{title:'Maple library opens for residents',kind:'news_report',event_date:'2026-11-05',source_url:'https://example.org/news',tier:'local'}]);
  expect(result.funnel.after_merge).toBe(2);
});
it('assembles cited real-source coverage as one story without treating publication dates as conflicting event times',async()=>{
 const original='https://www.wedgwoodcc.org/2026/09/06/wedgwood-center-development-hits-a-pause-again/';
 const result=await pool([
  {title:'Wedgwood Center Development Hits a Pause Again',kind:'local_news',event_date:'2026-09-06',source_url:original,source_tier:'organisation',source_name:'Wedgwood Community Council',description:'The property owner confirmed Madison Development Group chose not to move forward.',details:{when:'September 6, 2026',links:[]}},
  {title:'Development Watch: A Wedgwood Center Pause',kind:'news_report',event_date:'2026-09-08',source_url:'https://www.neseattlewire.com/p/another-developer-walks-away-from-wedgwood-center-the-seahawks-play-on-a-wednesday',source_tier:'local_reporting',source_name:'Northeast Seattle Wire',description:'The owner is looking for a developer, according to the Wedgwood Community Council.',details:{when:'September 8, 2026',links:[original]}},
 ]);
 expect(result.funnel.after_merge).toBe(1);
 expect(result.events).toHaveLength(2);
 expect(result.events.find(x=>x.facts.lead)?.facts.source_url).toBe(original);
 expect(result.events.find(x=>x.facts.lead)?.facts.merge_conflicts).toEqual([]);
});
