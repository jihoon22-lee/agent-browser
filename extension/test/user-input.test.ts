import { observeUserInput } from '../src/content/user-input';

it('ignores synthetic agent input and trusted focus but counts physical pointer and keyboard input',()=>{
 const listeners=new Map<string,EventListener>();
 const state=observeUserInput({addEventListener:(name:string,listener:EventListener)=>listeners.set(name,listener)} as unknown as EventTarget);
 const initial=state();
 listeners.get('click')!(new MouseEvent('click'));
 listeners.get('keydown')!(new KeyboardEvent('keydown',{key:'Enter'}));
 expect(listeners.has('focus')).toBe(false);
 expect(state()).toEqual(initial);
 listeners.get('pointerdown')!({isTrusted:true} as Event);
 listeners.get('keydown')!({isTrusted:true} as Event);
 expect(state()).toEqual({...initial,epoch:2});
});
