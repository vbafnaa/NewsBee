/** Opt-in local research run: real queue/readers, no registry seeds, model or publication. */
import { it, expect } from 'vitest';
import { MongoClient } from 'mongodb';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings } from '../../core/config';
import { defaultRunOptions, withRunContext } from '../../core/run-options';
import { fetchTransport } from '../../core/http';
import { logger } from '../../core/log';
import { Fetcher } from '../../connectors/fetcher';
import { shareFetchState, ensureFetchStateIndexes } from '../../connectors/fetch-state';
import { NO_MODEL } from '../../accounts/runtime';
import { LocalArtifacts } from '../../storage/artifacts';
import { startMapRun, startRun, tick } from '../../orchestration/orchestrator';
import { getRun } from '../../orchestration/runs';
import { getLocation } from '../../communities/locations';
import { assemble } from '../../editions/assemble';
it.skipIf(process.env.NEWSBEE_FREE_RERUN !== '1')('runs free discovery, collection and locality assembly', async () => {
  const root=resolve('../..'), locationId='osm-r13915552-wa';
  const out=resolve(root,'research/evidence/free_sources_rerun',new Date().toISOString().replace(/[:.]/g,'-'));
  mkdirSync(out,{recursive:true});
  const save=(name:string,value:unknown)=>writeFileSync(resolve(out,name+'.json'),JSON.stringify(value,null,2));
  const client=new MongoClient('mongodb://127.0.0.1:27029');await client.connect();
  const db=client.db('wedgwood_independent');
  const settings=loadSettings({NEWSBEE_MODE:'local',NEWSBEE_ROOT:root,NEWSBEE_LLM_DISCOVERY:'off',NEWSBEE_AI_LINK_DISCOVERY:'off',NEWSBEE_COLLECT_CONCURRENCY:'3',NEWSBEE_COLLECT_BUDGET_MINUTES:'20'});
  const options={...defaultRunOptions({}),mode:'manual' as const,count_history:false,paid:{}};
  const deps={db,settings,model:NO_MODEL,store:new LocalArtifacts(resolve(root,'.local/wedgwood-independent/drive')),transport:fetchTransport};
  const ids:string[]=[];
  const exportEvidence=async()=>{
    for(const name of ['pipeline_runs','pipeline_jobs','collected_items','source_results','run_decisions','api_calls','job_logs'])save(name,await db.collection(name).find({$or:[{run_id:{$in:ids}},{_id:{$in:ids}}]}).toArray());
    for(const name of ['source_map','discovery_state'])save(name,await db.collection(name).find({location_id:locationId}).toArray());
    save('location',await getLocation(db,locationId));save('landmarks',await db.collection('location_landmarks').findOne({_id:locationId as never}));
  };
  try {
    shareFetchState(db);await ensureFetchStateIndexes(db);
    save('manifest',{started_at:new Date().toISOString(),scope:'Isolated local production queue/connectors and deterministic assembly; no model, authoring, publication or human registry seeds',options,concurrency:3,collection_budget_minutes:20});
    const wait=async(id:string,statuses:string[])=>{
      for(let i=0;i<100;i++){
        const run=await getRun(db,id);if(!run)throw new Error('Run vanished');
        console.log('RUN',id,run.status,run.sources?.length);
        if(statuses.includes(run.status))return run;
        if(['failed','cancelled','blocked'].includes(run.status))throw new Error(JSON.stringify(run));
        await tick(deps,{budgetMs:10000});await exportEvidence();await new Promise(r=>setTimeout(r,1000));
      }throw new Error('Run did not finish');
    };
    const existingId=process.env.NEWSBEE_FREE_ASSEMBLE_RUN;
    if (!existingId) {
      const map=await startMapRun(deps,locationId,{kind:'manual',by:'free-source-research'},options,false);ids.push(map.run._id);save('run_ids',ids);await wait(map.run._id,['mapped']);
      const edition=await startRun(deps,locationId,{kind:'manual',by:'free-source-research'},options);ids.push(edition.run._id);
    } else {
      const existing=await getRun(db,existingId);
      if(existing?.location_id!==locationId || existing.status!=='awaiting_authoring')throw new Error('Only this isolated location at the manual authoring gate can be reassembled');
      await db.collection('collected_items').updateMany({run_id:existingId,step:'locality',facts:{$ne:null}},{$set:{status:'collected',reason:null,step:'reader'}});
      ids.push(existingId);save('assembly_only',{collection_run_id:existingId,reason:'Recheck deterministic assembly on unchanged collected facts'});
    }
    save('run_ids',ids);
    const run=await wait(ids.at(-1)!,['awaiting_authoring']);
    const location=await getLocation(db,locationId);
    const pool=await withRunContext({options,db,runId:run._id,locationId},()=>assemble({db,settings,location,today:run.today,runId:run._id,transport:fetchTransport,fetcher:new Fetcher(fetchTransport),log:logger('free-rerun')}));
    save('pool',pool);await exportEvidence();expect((await getRun(db,run._id))?.status).toBe('awaiting_authoring');console.log('EVIDENCE',out,'POOL',pool.events.length);
  }finally{await exportEvidence();shareFetchState(null);await client.close();}
},2400000);
