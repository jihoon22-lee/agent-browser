import { accessibleName } from "../src/content/dom";
import { takeSnapshot } from '../src/content/snapshot';

it("names icon links and buttons from nested alt text and aria-label", () => {
  document.body.innerHTML = `<a id="home" href="/"><img alt="쇼핑몰 홈" src="x.png"></a>
    <button id="del"><i aria-label="삭제"></i></button><button id="plain">저장</button>`;
  expect(accessibleName(document.getElementById("home")!)).toBe("쇼핑몰 홈");
  expect(accessibleName(document.getElementById("del")!)).toBe("삭제");
  expect(accessibleName(document.getElementById("plain")!)).toBe("저장");
});

it('snapshot avoids repeated native label scans while preserving explicit and wrapping labels',()=>{
  document.body.innerHTML='<label for="a">Explicit</label><button id="a">Button</button><label>Wrapping <input></label>'+Array.from({length:500},(_,i)=>`<button>Action ${i}</button>`).join('');
  const labels=vi.spyOn(HTMLButtonElement.prototype,'labels','get');
  try {
    const snap=takeSnapshot({snapshotId:100,frameId:0,maxChars:1000,offset:0,checkLayout:false,query:'Action'});
    expect(snap.elements.length).toBeGreaterThan(0);
    expect(labels.mock.calls.length).toBeLessThan(5);
    const named=takeSnapshot({snapshotId:101,frameId:0,maxChars:1000,offset:0,checkLayout:false});
    expect(named.elements.some(e=>e.name==='Explicit')).toBe(true);
    expect(named.elements.some(e=>e.name==='Wrapping')).toBe(true);
  }finally{labels.mockRestore();}
});
