import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {BookmarksPermission} from '../src/options/BookmarksPermission';
it('requests permission only from the allow button and supports denial and revocation',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 let granted=false;
 const request=vi.fn(async()=>false),remove=vi.fn(async()=>{granted=false;return true;});
 const event={addListener:vi.fn(),removeListener:vi.fn()};
 vi.stubGlobal('chrome',{permissions:{contains:async()=>granted,request,remove,onAdded:event,onRemoved:event}});
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try {
  await act(async()=>root.render(createElement(BookmarksPermission)));
  expect(request).not.toHaveBeenCalled();
  await act(async()=>host.querySelector('button')!.click());
  expect(request).toHaveBeenCalledTimes(1);expect(host.textContent).toContain('허용되지 않은');
  request.mockImplementation(async()=>{granted=true;return true;});
  await act(async()=>host.querySelector('button')!.click());expect(host.textContent).toContain('접근 해제');
  await act(async()=>host.querySelector('button')!.click());expect(remove).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('허용되지 않은');
 } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
