/** v1 MCP calls share a proxy. Correlate the exact running root tool row, not merely the selected model. */
const fields=['captureId','mode','x','y','toX','toY','deltaX','deltaY'] as const;
function argumentsKey(input:Record<string,unknown>={}) {
 return JSON.stringify(fields.map(k=>[k,input[k]??(k==='mode'?'click':k==='deltaX'||k==='deltaY'?0:null)]));
}
export function visionEvidence(lease:{sessionId:string;messageId:string},args:Record<string,unknown>,messages:any[],catalogue:any,statuses:Record<string,{type?:string}>) {
 if(statuses?.[lease.sessionId]?.type!=='busy'||Object.entries(statuses??{}).some(([id,s])=>id!==lease.sessionId&&['busy','retry'].includes(s.type??'')))return false;
 const matches=messages.filter(m=>m.info?.role==='assistant'&&m.info.sessionID===lease.sessionId&&m.info.parentID===lease.messageId&&m.info.time?.completed==null)
  .flatMap(m=>(m.parts??[]).filter((p:any)=>p.type==='tool'&&p.tool==='browser_browser_pointer'&&p.state?.status==='running'&&argumentsKey(p.state.input)===argumentsKey(args)).map(()=>m.info));
 if(matches.length!==1)return false;
 const info=matches[0],provider=catalogue?.all?.find((p:any)=>p.id===info.providerID),model=provider?.models?.[info.modelID];
 return catalogue?.connected?.includes(info.providerID)===true&&model?.capabilities?.input?.image===true&&model?.capabilities?.toolcall===true;
}
