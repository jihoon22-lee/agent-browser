import {visualTarget} from '../src/content/visual-target';
afterEach(()=>vi.restoreAllMocks());
it('binds the actionable ancestor of an inner visual hit',()=>{
 document.body.innerHTML='<a href="/safe"><span>Open</span></a>';const span=document.querySelector('span')!;
 Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>span});
 visualTarget('prepare','link',[{x:10,y:10}]);document.querySelector('a')!.href='/changed';
 expect(()=>visualTarget('check','link')).toThrow();
});
