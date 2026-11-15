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

it('does not count the trusted input the agent itself is delivering, only input beyond it',async()=>{
 const {asAgentInput,agentEvents}=await import('../src/content/user-input');
 const listeners=new Map<string,EventListener>();
 const state=observeUserInput({addEventListener:(name:string,listener:EventListener)=>listeners.set(name,listener)} as unknown as EventTarget);
 const fire=(...names:string[])=>{for(const name of names)listeners.get(name)!({isTrusted:true,type:name} as Event);};
 const initial=state();
 // Debugger input reaches the page as isTrusted events while the content script waits for its reply.
 expect(await asAgentInput(agentEvents('click',{}),async()=>{fire('pointerdown','mousedown','pointerup','mouseup','click');return 'ok';})).toBe('ok');
 expect(state()).toEqual(initial);
 // A real click in the same moment is one click too many: it still counts.
 await asAgentInput(agentEvents('click',{}),async()=>{fire('pointerdown','mousedown','pointerup','mouseup','click','pointerdown');});
 expect(state()).toEqual({...initial,epoch:1});
 await asAgentInput(agentEvents('click',{mode:'double'}),async()=>{fire('pointerdown','mousedown','pointerup','mouseup','click','pointerdown','mousedown','pointerup','mouseup','click');});
 await asAgentInput(agentEvents('click',{mode:'right'}),async()=>{fire('pointerdown','mousedown','contextmenu','pointerup','mouseup','auxclick');});
 await asAgentInput(agentEvents('key',{modifiers:['Control','Shift']}),async()=>{fire('keydown','keydown','keydown','keyup','keyup','keyup');});
 await expect(asAgentInput(agentEvents('key',{}),async()=>{fire('keydown');throw new Error('failed');})).rejects.toThrow('failed');
 expect(state()).toEqual({...initial,epoch:1});
 // Text goes in without key events; typing during it is the user's.
 await asAgentInput(agentEvents('text',{text:'abc'}),async()=>{fire('keydown');});
 expect(state()).toEqual({...initial,epoch:2});
 // What the agent did not use is not kept for later.
 await asAgentInput(agentEvents('click',{}),async()=>{});
 fire('pointerdown');
 expect(state(),'physical input after the delivery still counts').toEqual({...initial,epoch:3});
});

it('allows the click a key press or a label produces, but not a click with its own pointer events',async()=>{
 const {asAgentInput,agentEvents}=await import('../src/content/user-input');
 const listeners=new Map<string,EventListener>();
 const state=observeUserInput({addEventListener:(name:string,listener:EventListener)=>listeners.set(name,listener)} as unknown as EventTarget);
 const fire=(...names:string[])=>{for(const name of names)listeners.get(name)!({isTrusted:true,type:name} as Event);};
 const initial=state();
 // Enter on a focused link or button makes Chrome fire a trusted click.
 await asAgentInput(agentEvents('key',{}),async()=>{fire('keydown','click','keyup');});
 // Clicking a <label> clicks its control too.
 await asAgentInput(agentEvents('click',{}),async()=>{fire('pointerdown','mousedown','pointerup','mouseup','click','click');});
 expect(state()).toEqual(initial);
 // A person's click still brings its own pointer events.
 await asAgentInput(agentEvents('key',{}),async()=>{fire('keydown','keyup','pointerdown','mousedown','pointerup','mouseup','click');});
 expect(state().epoch).toBeGreaterThan(initial.epoch);
});
