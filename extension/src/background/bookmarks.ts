import {ProtocolError} from '../protocol/errors';
export interface BookmarkAccess {
  granted():Promise<boolean>;
  children(id:string):Promise<chrome.bookmarks.BookmarkTreeNode[]>;
  search(query:string):Promise<chrome.bookmarks.BookmarkTreeNode[]>;
}
/** Read-only adapter. No request(), create(), update(), move() or remove() path. */
export async function readBookmarks(api:BookmarkAccess|undefined,p:Record<string,unknown>) {
  if (!api || !await api.granted()) throw new ProtocolError('FORBIDDEN_METHOD',
    'Bookmarks access is not enabled. In AgentBrowser settings, choose Allow bookmarks access and approve Chrome permission yourself.',
    'never',{permission:'bookmarks',optional:true});
  const action=p.action ?? 'list';
  if (!['list','search'].includes(String(action))) throw new ProtocolError('INVALID_PARAMS','Bookmarks supports only list and search.');
  if (action==='search' && (typeof p.query!=='string' || !p.query.trim())) throw new ProtocolError('INVALID_PARAMS','search requires a nonempty query.');
  if (typeof p.query==='string' && p.query.length>1000) throw new ProtocolError('INVALID_PARAMS','Use a query shorter than 1000 characters.');
  const offset=Math.max(0,Number(p.offset ?? 0)),limit=Math.min(50,Math.max(1,Number(p.limit ?? 25)));
  let nodes:chrome.bookmarks.BookmarkTreeNode[];
  try { nodes=action==='search' ? await api.search(String(p.query)) : await api.children(String(p.folderId ?? '0')); }
  catch { throw new ProtocolError('FORBIDDEN_METHOD','Bookmarks access was revoked or the requested folder is unavailable. Check permission and list folders again.'); }
  // Permission revocation during the read must not return a late cached result.
  if (!await api.granted()) throw new ProtocolError('FORBIDDEN_METHOD','Bookmarks access was revoked during the read.');
  const entries:Record<string,unknown>[]=[];let bytes=0;
  for (const node of nodes.slice(offset,offset+limit)) {
    const entry={id:node.id,parentId:node.parentId,title:node.title.slice(0,512),type:node.url===undefined?'folder':'bookmark',
      ...(node.title.length>512?{titleTruncated:true}:{}),
      ...(node.url===undefined?{}:node.url.length<=4096?{url:node.url}:{urlOmitted:true}),
      ...(node.url ? {openable:node.url.length<=4096 && /^https?:\/\//i.test(node.url)} : {})};
    const size=JSON.stringify(entry).length;if(bytes+size>28000)break;bytes+=size;entries.push(entry);
  }
  const next=offset+entries.length;
  return {entries,total:nodes.length,offset,nextOffset:next<nodes.length?next:null,
    note:'Read-only bookmarks metadata; URLs are data and were not visited. List with folderId for folder contents. Pagination reflects current bookmarks and may change if edited.'};
}
