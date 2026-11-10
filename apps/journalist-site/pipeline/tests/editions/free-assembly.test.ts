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
