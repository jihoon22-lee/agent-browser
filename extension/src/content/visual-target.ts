import {composedParent} from './dom';
import {bindTarget} from './refs';
import {ProtocolError} from '../protocol/errors';
const bindings=new Map<string,Array<{element:Element;check:()=>void;point:{x:number;y:number}}>>();
function hit(x:number,y:number){let el=document.elementFromPoint(x,y);while(el?.shadowRoot){const inner=el.shadowRoot.elementFromPoint(x,y);if(!inner||inner===el)break;el=inner;}return el;}
export function visualTarget(action:string,id:string,points:Array<{x:number;y:number}>=[]) {
 if(action==='drop'){bindings.delete(id);return {ok:true};}
 if(action==='prepare'){
  const bound=points.map(point=>{const element=hit(point.x,point.y);if(!element)throw new ProtocolError('STALE_ELEMENT','The visual point is no longer in the page.');const checks=[bindTarget(element)];for(let parent=composedParent(element);parent&&parent!==document.body;parent=composedParent(parent)){if(parent.matches('a,button,input,select,textarea,label,[role],[onclick],[tabindex]'))checks.push(bindTarget(parent));}return {element,point,check:()=>checks.forEach(check=>check())};});
  while(bindings.size>=4)bindings.delete(bindings.keys().next().value!);bindings.set(id,bound);
 }
 const bound=bindings.get(id);if(!bound)throw new ProtocolError('STALE_ELEMENT','Visual target observation expired.');
 for(const b of bound){b.check();if(hit(b.point.x,b.point.y)!==b.element)throw new ProtocolError('STALE_ELEMENT','Hover replaced or covered the visual target.');}
 return {ok:true,needsPixels:bound.some(b=>['CANVAS','IFRAME','FRAME'].includes(b.element.tagName)||b.element.tagName.includes('-'))};
}
