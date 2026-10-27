/** Use the configured v1 catalogue, never model-name guesses or an external catalogue. */
export type ImageSupport = 'supported' | 'unsupported' | 'unknown';
type Model = {id?:string;providerID?:string;capabilities?:{input?:{image?:boolean;audio?:boolean};output?:{image?:boolean};toolcall?:boolean}};
export const advancedAvailable = (ua = navigator.userAgent) => Number(/(?:Chrome|Chromium)\/(\d+)/.exec(ua)?.[1] ?? 0) >= 125;
export function imageSupport(model?:Model):ImageSupport {
  const image=model?.capabilities?.input?.image;
  return image===true?'supported':image===false?'unsupported':'unknown';
}
export function requestModelCapability(models:Model[], selected:string, command?:{model?:string;agent?:string;subtask?:boolean}) {
  const key=command?.model ?? selected, model=models.find(m=>`${m.providerID}/${m.id}`===key);
  // A delegated command can choose another model in the server. Its identity is not supplied by MCP.
  return {model:key,image:command?.subtask || (command?.agent&&!command.model)?'unknown' as ImageSupport:imageSupport(model),toolcall:model?.capabilities?.toolcall===true};
}
