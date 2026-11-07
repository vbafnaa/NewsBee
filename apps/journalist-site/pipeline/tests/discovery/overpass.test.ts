import { expect, it, vi } from "vitest";
import { queryOverpass, QUERY_SECONDS, REQUEST_MS } from "../../connectors/overpass";
import { methodDefinition, type DiscoveryContext } from "../../discovery/methods";
import type { HttpRequest, HttpTransport } from "../../core/http";
const response = (url: string, value: unknown, status = 200, headers = {}) => ({url,status,headers,body:new TextEncoder().encode(JSON.stringify(value))});
it("uses bounded GET, preserves failures and fails over on HTTP-200 error remarks", async () => {
 const transport = vi.fn(async (r: HttpRequest) => response(r.url,r.url.includes('first') ? {elements:[],remark:'runtime error: timed out'} : {elements:[]}));
 const result=await queryOverpass(transport,'[out:json];node(1);out;', ['https://first.example/api','https://second.example/api']);
 expect(result.endpoint).toContain('second');expect(result.attempts[0]).toContain('runtime error');
 expect(transport.mock.calls[0][0]).toMatchObject({method:'GET',timeoutMs:REQUEST_MS});
 expect(new URL(transport.mock.calls[0][0].url).searchParams.get('data')).toBe('[out:json];node(1);out;');
 expect(REQUEST_MS).toBeGreaterThan(QUERY_SECONDS*1000);
});
it("honors refusal cooldown and deduplicates endpoints", async () => {
 const endpoint='https://cooldown.example/api';const transport=vi.fn(async(r:HttpRequest)=>response(r.url,{},429,{'retry-after':'60'}));
 await expect(queryOverpass(transport,'query',[endpoint,endpoint])).rejects.toThrow('HTTP 429');
 await expect(queryOverpass(transport,'query',[endpoint])).rejects.toThrow('cooling down');expect(transport).toHaveBeenCalledTimes(1);
});
it("rejects malformed responses and accepts a valid empty area", async () => {
 const transport:HttpTransport=async r=>response(r.url,{});
 await expect(queryOverpass(transport,'query',['https://invalid.example/api'])).rejects.toThrow('missing elements');
 expect((await queryOverpass(async r=>response(r.url,{elements:[]}), 'query',['https://empty.example/api'])).data.elements).toEqual([]);
});
it("queries the saved bbox and filters institution types and location", async () => {
 let request:HttpRequest|undefined;
 const transport:HttpTransport=async r=>{request=r;return response(r.url,{elements:[
  {lat:47.69,lon:-122.29,tags:{name:'Test School',amenity:'school',website:'https://school.example/'}},
  {lat:47.67,lon:-122.29,tags:{name:'Outside School',amenity:'school',website:'https://outside.example/'}},
  {lat:47.69,lon:-122.29,tags:{name:'Shop',shop:'clothes',website:'https://shop.example/'}},
 ]});};
 const context={transport,location:{latitude:47.69,longitude:-122.29,community:{name:'Test',parent_name:'Seattle',geography:{area:{method:'approximate_bbox',bbox:[-122.30808,47.6830397,-122.2797623,47.6975789]}}}}} as unknown as DiscoveryContext;
 const result=await methodDefinition('osm')!.run(context);
 expect(new URL(request!.url).searchParams.get('data')).toContain('(47.6830397,-122.30808,47.6975789,-122.2797623)');
 expect(result.candidates.map(c=>c.name)).toEqual(['Test School']);expect(result.detail).toContain('success');
});
