import {inputRecovery} from '../src/background/input-recovery';
function fixture(){const data:Record<string,unknown>={};let documentId='original',source='child';const storage={get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(d:Record<string,unknown>)=>{Object.assign(data,structuredClone(d));}};const frames=async()=>[{frameId:0,documentId,url:'https://test/'},{frameId:1,documentId:source,url:'https://child/'}];return {storage,frames,navigate:(id:string)=>{documentId=id;},replaceFrame:()=>{source='new-child';}};}
it('blocks active other input, recovered worker orphans, and tainted BFCache documents',async()=>{
 const f=fixture(),r=inputRecovery(f.storage,f.frames),d=await r.capture(1,'child');await r.begin(d,'one');
 await expect(r.assertWritable(1)).rejects.toMatchObject({code:'BROWSER_BUSY'});
 const restarted=inputRecovery(f.storage,f.frames);await expect(restarted.assertWritable(1)).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
 await r.finish(d,'one',true);await expect(r.assertWritable(1)).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
 f.navigate('fresh');await r.assertWritable(1);f.navigate('original');await expect(r.assertWritable(1)).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
 await r.removeTab(1);await r.assertWritable(1);
});
it('only acknowledges its own lease and source frame replacement does not clear a block',async()=>{
 const f=fixture(),r=inputRecovery(f.storage,f.frames),d=await r.capture(1,'child');await r.begin(d,'one');await r.finish(d,'one',false);await r.begin(d,'two');await r.finish(d,'one',false);
 await expect(r.assertWritable(1)).rejects.toMatchObject({code:'BROWSER_BUSY'});f.replaceFrame();expect(await r.current(d)).toBe(false);await r.finish(d,'two',true);await expect(r.assertWritable(1)).rejects.toThrow();
});
it('failed durable transitions remain closed after worker recreation',async()=>{
 const f=fixture(),r=inputRecovery(f.storage,f.frames),d=await r.capture(1);await r.begin(d,'one');f.storage.set=async()=>{throw Error('storage failed');};await expect(r.finish(d,'one',true)).rejects.toThrow();await expect(r.assertWritable(1)).rejects.toThrow();await expect(inputRecovery(f.storage,f.frames).assertWritable(1)).rejects.toThrow();
});

it('tab removal wins over a late finalizer for its old lease',async()=>{
 const f=fixture(),r=inputRecovery(f.storage,f.frames),d=await r.capture(1);await r.begin(d,'one');await r.removeTab(1);await r.finish(d,'one',true);
 expect((await f.storage.get('inputRecovery')).inputRecovery).toEqual([]);
});

it('goto can bootstrap a clean tab without frames but cannot bypass known uncertain state',async()=>{
 const f=fixture(),r=inputRecovery(f.storage,f.frames),d=await r.capture(1);const absent=inputRecovery(f.storage,async()=>[]);
 await absent.assertWritable(1,true);await expect(absent.assertWritable(1)).rejects.toThrow();await r.begin(d,'one');await r.finish(d,'one',true);await expect(absent.assertWritable(1,true)).rejects.toThrow();
});
