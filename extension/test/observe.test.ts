import { observePage } from '../src/content/observe';

it('attribute changes notify without rescanning the entire document for shadow roots',async()=>{
  document.body.innerHTML='<div id="target"></div>';
  const change=vi.fn(),observer=observePage(change),scan=vi.spyOn(document,'querySelectorAll');
  try {
    document.getElementById('target')!.setAttribute('aria-expanded','true');
    await Promise.resolve();
    expect(change).toHaveBeenCalled();expect(scan).not.toHaveBeenCalledWith('*');
  }finally{observer.disconnect();scan.mockRestore();}
});
