import {visionEvidence} from '../src/background/vision-evidence';
const lease={sessionId:'s',messageId:'u'};
const args={captureId:'capture',x:40,y:20};
const statuses={s:{type:'busy'}};
const catalogue={connected:['p'],all:[{id:'p',models:{vision:{capabilities:{input:{image:true},toolcall:true}},text:{capabilities:{input:{image:false},toolcall:true}}}}]};
const message={info:{id:'a',sessionID:'s',parentID:'u',role:'assistant',providerID:'p',modelID:'vision'},parts:[{type:'tool',tool:'browser_browser_pointer',state:{status:'running',input:{...args,operationId:null}}}]};
it('requires one exact running root tool call from an actual image-capable model',()=>{
 expect(visionEvidence(lease,args,[message],catalogue,statuses)).toBe(true);
 for(const info of [{...message.info,parentID:'other'},{...message.info,sessionID:'child'},{...message.info,modelID:'text'},{...message.info,time:{completed:1}}])expect(visionEvidence(lease,args,[{...message,info}],catalogue,statuses)).toBe(false);
 expect(visionEvidence(lease,args,[message,message],catalogue,statuses)).toBe(false);
 expect(visionEvidence(lease,{...args,x:41},[message],catalogue,statuses)).toBe(false);
 expect(visionEvidence(lease,args,[message],catalogue,{})).toBe(false);
 expect(visionEvidence(lease,args,[message],catalogue,{...statuses,child:{type:'busy'}})).toBe(false);
 for(const status of ['pending','completed','error'])expect(visionEvidence(lease,args,[{...message,parts:[{...message.parts[0],state:{status,input:args}}]}],catalogue,statuses)).toBe(false);
});
