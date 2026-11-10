import { describe, it, expect, vi } from 'vitest';
import { areaPlaces, outsideEventVenue, parseLandmarks, type Locality } from '../../connectors/locality';
import { venuePoint } from '../../connectors/web/page';
import { datasetGeography } from '../../connectors/opendata';
import { scopeMeeting } from '../../connectors/meetings';
import { collectionPriority } from '../../orchestration/orchestrator';
import { fail, type Job } from '../../orchestration/jobs';
import { HttpStatusError } from '../../core/http';
import type { LocationProfile, SourceTask } from '../../connectors/types';
const location={id:'test',name:'Seattle, WA',state:'WA',systems:[],community:{name:'Wedgwood',coverage_terms:[],venues:[],parent_name:'Seattle',latitude:47.69,longitude:-122.29,geography:{area:{method:'approximate_bbox',bbox:[-122.31,47.68,-122.28,47.70]}}}} as LocationProfile;
describe('bounded free source improvements',()=>{
  it('recognizes geolocated landmark aliases but excludes outside and generic places',()=>{
    const names=parseLandmarks({elements:[{lat:47.69,lon:-122.29,tags:{name:'Example Playfield',alt_name:'Example Park;Park'}},{lat:48,lon:-122.29,tags:{name:'Outside School',alt_name:'Inside School'}}]},location.community!.geography!.area!,[-122.29,47.69]);
    expect(names).toEqual(['Example Field','Example Park','Example Playfield']);
  });
  it('does not issue duplicate Overpass requests when another worker holds refresh lease',async()=>{
    const transport=vi.fn();
    const collection={findOne:async()=>({names:['Stale School'],sites:[],checked_at:'2020-01-01',area_key:'different boundary'}),findOneAndUpdate:async()=>{throw {code:11000}}};
    const ctx={db:{collection:()=>collection},location,today:'2026-11-06',transport,log:{info:vi.fn()}} as unknown as Parameters<typeof areaPlaces>[0];
    expect(await areaPlaces(ctx,[-122.29,47.69],location.community!.geography!.area!)).toEqual({names:[],sites:[]});expect(transport).not.toHaveBeenCalled();
  });
  it('builds Socrata NW/SE bounding query and preserves requested city filters',()=>{
    expect(datasetGeography({point:'location'} as Parameters<typeof datasetGeography>[0],location)).toBe('within_box(location, 47.7, -122.31, 47.68, -122.28)');
    expect(datasetGeography({point:'location',city:'city'} as Parameters<typeof datasetGeography>[0],location,'city')).toBe("upper(city) = 'SEATTLE'");
  });
  it('uses explicit official venue coordinates and rejects missing or invalid ones',()=>{
    expect(venuePoint('<div data-map-markerlat="47.68" data-map-markerlng="-122.29"></div>')).toEqual([-122.29,47.68]);
    expect(venuePoint('<div>Seattle library</div>')).toBeNull();
    expect(venuePoint('<div data-map-markerlat="999" data-map-markerlng="-122.29"></div>')).toBeNull();
  });
  it('keeps a landmark agenda item without treating the meeting venue as neighborhood impact',()=>{
    const meeting={body:'Wedgwood council',venue:'Wedgwood',items:[{title:'Example Park improvements'},{title:'Unrelated citywide procurement'}]} as Parameters<typeof scopeMeeting>[0];
    const result=scopeMeeting(meeting,location,{location,landmarks:['Example Park']} as Locality);
    expect(result.items).toHaveLength(1);expect(result.community_relevance).toEqual([{method:'landmark',matches:['Example Park']}]);
  });
  it('schedules direct primary sources ahead of broad optional search',()=>{
    const task=(type:string,section?:string)=>({type,params:{section}} as SourceTask);
    expect(collectionPriority(task('web','schools'))).toBeLessThan(collectionPriority(task('newssearch')));
    expect(collectionPriority(task('opendata'))).toBeLessThan(collectionPriority(task('web','news')));
  });
  it('stops a supplemental news search after one rate-limit retry',async()=>{
    const updateOne=vi.fn(async()=>({modifiedCount:1}));const db={collection:()=>({updateOne})} as unknown as Parameters<typeof fail>[0];
    const job={_id:'test',kind:'collect_source',attempts:1,claim_token:'lease',rate_limit_retries:1,payload:{task:{type:'newssearch'}}} as Job;
    expect(await fail(db,job,new HttpStatusError(429,'https://api.gdeltproject.org',120),true)).toBe('failed');
    expect(updateOne.mock.calls.length).toBe(1);
  });
});

it('does not mistake an off-site calendar venue for the publishing school location',async()=>{
  const locality={area:location.community!.geography!.area!,center:[-122.29,47.69],town:'Seattle',state:'WA',budget:{geocodes:2,articles:0},geocoder:{geocode:vi.fn(async()=>({point:[-122.36,47.70],matched:'10525 3RD AVE NW'}))}} as unknown as Locality;
  expect(await outsideEventVenue(locality,'Location: Viewlands Elementary, 10525 3rd Ave. NW, Seattle, WA 98177.')).toBe('10525 3RD AVE NW');
  expect(await outsideEventVenue(locality,'No school for Veterans Day.')).toBeNull();
});
