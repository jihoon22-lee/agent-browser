import { advancedAvailable, imageSupport, requestModelCapability } from '../src/agents/opencode-v1/capabilities';
it.each([['Chrome/116.0',false],['Chrome/124.9',false],['Chrome/125.0',true],['Chrome/155.0',true],['unknown',false]])('gates advanced features on %s', (ua, expected)=>expect(advancedAvailable(ua)).toBe(expected));
it('does not confuse image generation or audio with image input',()=>{
  expect(imageSupport({capabilities:{input:{audio:true},output:{image:true}}})).toBe('unknown');
  expect(imageSupport({capabilities:{input:{image:false}}})).toBe('unsupported');
  expect(imageSupport({capabilities:{input:{image:true}}})).toBe('supported');
});
it('resolves command model overrides and does not infer a subtask model',()=>{
  const models=[{id:'text',providerID:'p',capabilities:{input:{image:false},toolcall:true}},{id:'vision',providerID:'p',capabilities:{input:{image:true},toolcall:true}}];
  expect(requestModelCapability(models,'p/text')).toMatchObject({image:'unsupported',model:'p/text'});
  expect(requestModelCapability(models,'p/text',{model:'p/vision'})).toMatchObject({image:'supported',model:'p/vision'});
  expect(requestModelCapability(models,'p/vision',{subtask:true})).toMatchObject({image:'unknown'});
});
