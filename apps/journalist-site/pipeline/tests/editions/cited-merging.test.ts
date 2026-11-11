import { expect, it } from 'vitest';
import { groupItems } from '../../editions/assemble';
import type { CollectedEvent } from '../../connectors/types';
const original='https://www.wedgwoodcc.org/2026/09/06/wedgwood-center-development-hits-a-pause-again/';
const a={title:'Wedgwood Center Development Hits a Pause Again',kind:'local_news',event_date:'2026-09-06',source_url:original} as CollectedEvent;
const b={title:'Development Watch: A Wedgwood Center Pause',kind:'news_report',event_date:'2026-09-08',source_url:'https://www.neseattlewire.com/p/another-developer-walks-away-from-wedgwood-center-the-seahawks-play-on-a-wednesday',details:{links:[original]}} as CollectedEvent;
it('merges real reworded coverage with a direct article citation across publication dates',()=>expect(groupItems([a,b])).toEqual([0,0]));
it('does not merge the same topic merely because both publishers mention it',()=>expect(groupItems([a,{...b,details:{links:[]}} as CollectedEvent])).toEqual([0,1]));
it('does not merge a subsequent episode beyond the bounded coverage window',()=>expect(groupItems([a,{...b,event_date:'2026-11-08'}])).toEqual([0,1]));
it('keeps proposals separate from approvals even with a citation',()=>expect(groupItems([{...a,title:'Wedgwood Center proposal'}, {...b,title:'Wedgwood Center approved'}])).toEqual([0,1]));
it('does not join unrelated news through a generic homepage citation',()=>expect(groupItems([{...a,source_url:'https://www.wedgwoodcc.org/'},{...b,details:{links:['https://www.wedgwoodcc.org/']}} as CollectedEvent])).toEqual([0,1]));
it('does not let a related bridge fuse unrelated groups',()=>expect(groupItems([a,b,{...b,title:'Maple Leaf Center Development',source_url:'https://example.org/maple'}])).toEqual([0,0,2]));

it('does not merge an entire multi-topic newsletter merely because it cites one related report',()=>expect(groupItems([a,{...b,title:'Another Developer Walks Away From Wedgwood Center. The Seahawks Play on a Wednesday'}])).toEqual([0,1]));
