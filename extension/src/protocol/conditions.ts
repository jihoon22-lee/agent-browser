import { ProtocolError } from './errors';
export type PageConditions = {text?:string;textGone?:string;urlIncludes?:string;match:'all'|'any';timeoutMs:number};
export const CONDITION_KEYS = ['text','textGone','urlIncludes'] as const;
export function pageConditions(value: unknown): PageConditions {
  const fail=()=>new ProtocolError('INVALID_PARAMS','waitFor needs nonempty text, textGone or urlIncludes; match is all/any and timeoutMs is 100..30000.');
  if (!value || typeof value!=='object' || Array.isArray(value)) throw fail();
  const obj=value as Record<string,unknown>;
  if (Object.keys(obj).some(k=>![...CONDITION_KEYS,'match','timeoutMs'].includes(k))) throw fail();
  const result:PageConditions={match:'all',timeoutMs:5000};
  for(const key of CONDITION_KEYS)if(obj[key]!=null){
    if(typeof obj[key]!=='string'||!(obj[key] as string).trim()||(obj[key] as string).length>2000)throw fail();
    result[key]=obj[key] as string;
  }
  if(!CONDITION_KEYS.some(k=>result[k]!==undefined))throw fail();
  if(obj.match!=null){if(obj.match!=='all'&&obj.match!=='any')throw fail();result.match=obj.match;}
  if(obj.timeoutMs!=null){if(!Number.isInteger(obj.timeoutMs)||Number(obj.timeoutMs)<100||Number(obj.timeoutMs)>30000)throw fail();result.timeoutMs=Number(obj.timeoutMs);}
  return result;
}
