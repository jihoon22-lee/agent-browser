import { capturePoint, validateCapture, advancedMethod } from '../src/background/advanced-browser';
const capture={operationId:'op',generation:1,tabId:1,documentId:'doc',scrollX:0,scrollY:20,width:400,height:300,scale:1,dpr:2,created:100,region:{x:10,y:30,width:200,height:100},imageWidth:400,imageHeight:200};
it('converts image pixels into the captured CSS viewport and rejects off-image coordinates',()=>{
 expect(capturePoint(capture,200,100)).toEqual({x:110,y:80});
 for(const p of [[-1,0],[400,0],[0,200],[NaN,1]]) expect(()=>capturePoint(capture,...p as [number,number])).toThrow();
});
it('rejects a capture after document, operation, scale, scroll, or viewport changes',()=>{
 for(const [key,value] of [['documentId','new'],['operationId','other'],['generation',2],['tabId',2],['scrollY',21],['scale',1.25],['width',401],['dpr',1]] as const) expect(()=>validateCapture(capture,{...capture,[key]:value},200)).toThrow();
 expect(()=>validateCapture(capture,capture,200)).not.toThrow();
 expect(()=>validateCapture(capture,capture,30101)).toThrow();
});
it('does not route legacy default capture through advanced features while disabled',()=>{
 expect(advancedMethod('browser.screenshot',{},false)).toBe(false);
 expect(advancedMethod('browser.screenshot',{scope:'fullPage'},false)).toBe(true);
 expect(advancedMethod('browser.pointer',{},false)).toBe(true);
});

it('rejects 300 seeded stale observations while accepting the unchanged controls',()=>{
 const fields=['documentId','operationId','generation','tabId','scrollX','scrollY','width','height','scale','dpr'] as const;
 for(let seed=0;seed<300;seed++){
   const field=fields[(seed*7)%fields.length]!;
   const value=typeof capture[field]==='number'?Number(capture[field])+1+seed:String(capture[field])+seed;
   expect(()=>validateCapture(capture,{...capture,[field]:value},200)).toThrow();
   expect(()=>validateCapture(capture,{...capture},200)).not.toThrow();
 }
});
