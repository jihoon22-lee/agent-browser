import {readBookmarks,type BookmarkAccess} from '../src/background/bookmarks';
const node=(id:string,title:string,url?:string)=>({id,title,url,syncing:false});
it('denied permission does not touch the bookmark API',async()=>{
 const children=vi.fn();await expect(readBookmarks({granted:async()=>false,children,search:vi.fn()},{})).rejects.toMatchObject({code:'FORBIDDEN_METHOD',details:{permission:'bookmarks'}});
 expect(children).not.toHaveBeenCalled();
});
it('lists folders and pages results without visiting URLs',async()=>{
 const children=vi.fn(async()=>[node('a','Folder'),node('b','Link','https://example.test/'),node('c','Script','javascript:void(0)')]);
 const api:BookmarkAccess={granted:async()=>true,children,search:vi.fn()};
 const first=await readBookmarks(api,{folderId:'a',limit:2});expect(children).toHaveBeenCalledWith('a');expect(first.nextOffset).toBe(2);
 expect(first.entries[0]).toMatchObject({id:'a',type:'folder'});
 expect((await readBookmarks(api,{offset:2})).entries[0]).toMatchObject({openable:false});
});
it('search uses only the requested query and refuses mutation actions',async()=>{
 const search=vi.fn(async()=>[]),api:BookmarkAccess={granted:async()=>true,children:vi.fn(),search};
 await readBookmarks(api,{action:'search',query:'fixture'});expect(search).toHaveBeenCalledWith('fixture');
 await expect(readBookmarks(api,{action:'delete'})).rejects.toMatchObject({code:'INVALID_PARAMS'});
 await expect(readBookmarks(api,{action:'search',query:' '})).rejects.toMatchObject({code:'INVALID_PARAMS'});
});
it('revocation during a read discards the result',async()=>{
 let granted=true;const api:BookmarkAccess={granted:async()=>granted,children:async()=>{granted=false;return[node('s','Private')];},search:vi.fn()};
 await expect(readBookmarks(api,{})).rejects.toMatchObject({code:'FORBIDDEN_METHOD'});
});
it('bounds output and never exposes a truncated URL as an actionable destination',async()=>{
 const api:BookmarkAccess={granted:async()=>true,children:async()=>Array.from({length:50},(_,i)=>node(String(i),'X'.repeat(600),'https://example.test/'+ 'x'.repeat(i===0?5000:3500))),search:vi.fn()};
 const result=await readBookmarks(api,{limit:50});expect(JSON.stringify(result).length).toBeLessThan(32000);
 expect(result.entries[0]).toMatchObject({urlOmitted:true,openable:false});expect(result.entries[0]).not.toHaveProperty('url');expect(result.nextOffset).toBeGreaterThan(0);
});
