import { downloadSummary, matchingDownload } from '../src/background/downloads';
it('does not expose local directories or invent completion from bytes',()=>{
 expect(downloadSummary({id:1,filename:'C:\\Users\\Person\\report.csv',state:'in_progress',bytesReceived:10,totalBytes:10} as any)).toMatchObject({filename:'report.csv',state:'in_progress',complete:false});
 expect(downloadSummary({id:1,filename:'/private/report.csv',state:'complete'} as any).complete).toBe(true);
});
it('requires explicit binding even for one same-URL candidate and never crosses operations',()=>{
 const item={id:1,operationId:'op',bound:false};
 expect(()=>matchingDownload([item],'op',1)).toThrow();
 expect(()=>matchingDownload([{...item,bound:true}],'other',1)).toThrow();
 expect(matchingDownload([{...item,bound:true}],'op',1).id).toBe(1);
});

it('registers download observation when permission is granted after worker startup',async()=>{
 const {downloads}=await import('../src/background/downloads');let added!:()=>void;const listener=vi.fn();
 vi.stubGlobal('chrome',{permissions:{onAdded:{addListener:(fn:()=>void)=>{added=fn;}},onRemoved:{addListener:vi.fn()}},storage:{session:{get:async()=>({}),set:async()=>{}}}});
 downloads(()=>undefined,()=>true);
 (chrome as any).downloads={onCreated:{addListener:listener,removeListener:vi.fn()}};
 expect(typeof added).toBe('function');added();expect(listener).toHaveBeenCalledTimes(1);added();expect(listener).toHaveBeenCalledTimes(1);vi.unstubAllGlobals();
});

it('keeps simultaneous same-name candidates unbound across 300 events and limits recovery',async()=>{
 const {downloads}=await import('../src/background/downloads');const state:Record<string,unknown>={};let created!:(d:any)=>void;
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true,onAdded:{addListener:vi.fn()}},storage:{session:{get:async(key:string)=>({[key]:state[key]}),set:async(d:any)=>{Object.assign(state,d);}}},downloads:{onCreated:{addListener:(fn:any)=>{created=fn;}},search:async(q:any)=>q.id?[{id:q.id,filename:'same.txt',state:'complete'}]:[]}});
 try {const service=downloads(()=> 'op',()=>true);await service.observe('op');for(let id=0;id<300;id++)created({id,filename:'same.txt',state:'complete'});
 const result=await service.list('op');expect(result.downloads).toHaveLength(30);expect(result.downloads.every(d=>d.bound===false)).toBe(true);
 for(const item of result.downloads)await expect(service.handle({operationId:'op',action:'status',downloadId:item.id},new AbortController().signal)).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
 }finally{vi.unstubAllGlobals();}
});

it.each(['interrupted','paused','revoked','cancelled','missing'])('wait preserves %s without restarting a download',async scenario=>{
 const {downloads}=await import('../src/background/downloads');let allowed=true,calls=0;const cancel=new AbortController();
 const item={id:1,filename:'report.txt',state:'in_progress',danger:'safe',paused:false,totalBytes:-1,bytesReceived:0};
 vi.stubGlobal('chrome',{permissions:{contains:async()=>allowed,onAdded:{addListener:vi.fn()}},storage:{session:{get:async()=>({advancedDownloads:[{id:1,operationId:'op',bound:true,at:Date.now()}]})}},downloads:{onCreated:{addListener:vi.fn()},search:async()=>{calls++;if(scenario==='revoked'){allowed=false;return [item];}if(scenario==='cancelled'){cancel.abort();return [item];}return scenario==='missing'?[]:[{...item,...(scenario==='paused'?{paused:true}:{state:'interrupted',error:'NETWORK_FAILED'})}];}}});
 try {const service=downloads(()=> 'op',()=>true),pending=service.handle({operationId:'op',action:'wait',downloadId:1,timeoutMs:1000},cancel.signal);
 if(scenario==='interrupted')expect(await pending).toMatchObject({complete:false,state:'interrupted',totalBytes:null,error:'NETWORK_FAILED'});
 else if(scenario==='paused')expect(await pending).toMatchObject({complete:false,userDecisionRequired:true});
 else if(scenario==='cancelled')await expect(pending).rejects.toMatchObject({name:'AbortError'});
 else await expect(pending).rejects.toMatchObject({code:scenario==='revoked'?'FORBIDDEN_METHOD':'ELEMENT_NOT_FOUND'});
 expect(calls).toBe(1);
 }finally{vi.unstubAllGlobals();}
});
