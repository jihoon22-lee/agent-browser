import { runAction } from "../src/content/actions";
import { takeSnapshot } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";

const ref = (name: string) => takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 1000, offset: 0, checkLayout: false }).elements.find(e => e.name === name)!.ref;
const press = (name: string, key: string) => runAction("press", { operationId: "keyboard", generation: 1, ref: ref(name), key });
beforeEach(() => { resetRegistry(); document.body.innerHTML = ""; });

it.each(["Enter", "Space"])("focuses a button and invokes its native %s action once", async key => {
  document.body.innerHTML = "<button>저장</button>";
  const button = document.querySelector("button")!, clicked = vi.fn(); button.addEventListener("click", clicked);
  expect(await press("저장", key)).toMatchObject({ executed: true, verified: { defaultApplied: true } });
  expect(document.activeElement).toBe(button); expect(clicked).toHaveBeenCalledTimes(1);
});
it("respects prevented keyboard defaults", async () => {
  document.body.innerHTML = "<button>저장</button>";
  const clicked = vi.fn(), button = document.querySelector("button")!;
  button.addEventListener("click", clicked); button.addEventListener("keydown", e => e.preventDefault());
  expect(await press("저장", "Enter")).toMatchObject({ verified: { defaultApplied: false, defaultPrevented: true } });
  expect(clicked).not.toHaveBeenCalled();
});
it("Backspace removes the selection and fires input for controlled fields", async () => {
  document.body.innerHTML = "<input aria-label='입력' value='abcdef'>";
  const input = document.querySelector("input")!, events: string[] = [];
  input.setSelectionRange(2, 4); input.addEventListener("input", e => events.push((e as InputEvent).inputType));
  expect(await press("입력", "Backspace")).toMatchObject({ verified: { defaultApplied: true, value: "abef" } });
  expect(input.value).toBe("abef"); expect(input.selectionStart).toBe(2); expect(events).toEqual(["deleteContentBackward"]);
});
it("Backspace respects beforeinput preventDefault", async () => {
  document.body.innerHTML = "<input aria-label='입력' value='abc'>";
  const input = document.querySelector("input")!; input.setSelectionRange(3, 3); input.addEventListener("beforeinput", e => e.preventDefault());
  expect(await press("입력", "Backspace")).toMatchObject({ verified: { defaultApplied: false } });
  expect(input.value).toBe("abc");
});
it("Space toggles a checkbox and Enter inserts a textarea newline", async () => {
  document.body.innerHTML = "<input aria-label='동의' type='checkbox'><textarea aria-label='메모'>ab</textarea>";
  await press("동의", "Space"); expect(document.querySelector("input")!.checked).toBe(true);
  const textarea = document.querySelector("textarea")!; textarea.setSelectionRange(1, 1);
  await press("메모", "Enter"); expect(textarea.value).toBe("a\nb");
});
it("rejects disabled and readonly editing targets without keyboard events", async () => {
  document.body.innerHTML = "<button disabled>저장</button><input aria-label='읽기' readonly value='abc'>";
  const keys = vi.fn(); document.body.addEventListener("keydown", keys);
  await expect(press("저장", "Enter")).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE" });
  await expect(press("읽기", "Backspace")).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE" });
  expect(keys).not.toHaveBeenCalled();
});
it("Tab skips hidden and disabled elements and reaches a shadow control", async () => {
  document.body.innerHTML = "<button>첫째</button><button hidden>숨김</button><button disabled>비활성</button><div id='host'></div>";
  const shadow = document.getElementById("host")!.attachShadow({ mode: "open" }); shadow.innerHTML = "<button>둘째</button>";
  await press("첫째", "Tab"); expect(shadow.activeElement).toBe(shadow.querySelector("button"));
});
it("ArrowDown changes a select and skips disabled options", async () => {
  document.body.innerHTML = "<select aria-label='목록'><option value='a'>가</option><option disabled>나</option><option value='c'>다</option></select>";
  await press("목록", "ArrowDown"); expect(document.querySelector("select")!.value).toBe("c");
});
it("does not expose password contents in key verification", async () => {
  document.body.innerHTML = "<input aria-label='암호' type='password' value='secret'>";
  document.querySelector("input")!.setSelectionRange(6, 6);
  const result = await press("암호", "Backspace"); expect(JSON.stringify(result)).not.toContain("secre");
});
it("rejects clearing a checked radio without any click", async () => {
  document.body.innerHTML = "<input aria-label='선택' type='radio' checked>";
  const clicked = vi.fn(); document.querySelector("input")!.addEventListener("click", clicked);
  await expect(runAction("select", { ref: ref("선택"), checked: false, generation: 1 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  expect(clicked).not.toHaveBeenCalled(); expect(document.querySelector("input")!.checked).toBe(true);
});
it("does not claim checkbox success when the page cancels its click", async () => {
  document.body.innerHTML = "<input aria-label='선택' type='checkbox'>";
  document.querySelector("input")!.addEventListener("click", e => e.preventDefault());
  await expect(runAction("select", { ref: ref("선택"), checked: true, generation: 1 })).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE", details: { executed: true } });
});

it("does not dispatch keypress after keydown was cancelled", async () => {
  document.body.innerHTML = "<button>취소된 키</button>";
  const button = document.querySelector("button")!, keypress = vi.fn();
  button.addEventListener("keydown", e => e.preventDefault()); button.addEventListener("keypress", keypress);
  await press("취소된 키", "Enter"); expect(keypress).not.toHaveBeenCalled();
});
it("does not edit a field made readonly by its keydown handler", async () => {
  document.body.innerHTML = "<input aria-label='동적 읽기' value='abc'>";
  const input = document.querySelector("input")!; input.setSelectionRange(3, 3);
  input.addEventListener("keydown", () => { input.readOnly = true; });
  expect(await press("동적 읽기", "Backspace")).toMatchObject({ verified: { defaultApplied: false } });
  expect(input.value).toBe("abc");
});
it("does not report submission when form validation blocks it", async () => {
  document.body.innerHTML = "<form><input aria-label='필수' required></form>";
  expect(await press("필수", "Enter")).toMatchObject({ verified: { submitted: false } });
});
it("keeps a rich editor readonly unless an editing strategy is supported", async () => {
  document.body.innerHTML = "<div contenteditable='true' aria-label='편집기'>abc</div>";
  await expect(press("편집기", "Backspace")).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE" });
  expect(document.querySelector("div")!.textContent).toBe("abc");
});

it("honors maxlength and beforeinput readonly changes for text editing", async () => {
  document.body.innerHTML = "<input aria-label='제한' maxlength='3' value='abc'>";
  const input = document.querySelector("input")!; input.setSelectionRange(3, 3);
  expect(await press("제한", "Space")).toMatchObject({ verified: { defaultApplied: false } });
  expect(input.value).toBe("abc");
  input.removeAttribute("maxlength"); input.addEventListener("beforeinput", () => { input.readOnly = true; });
  expect(await press("제한", "Backspace")).toMatchObject({ verified: { defaultApplied: false } });
  expect(input.value).toBe("abc");
});

it.each([false, true])('R07 invokes the default submitter click and honors click cancellation %s', async cancel => {
  document.body.innerHTML = '<form><input aria-label="query"><button name="action" value="search">Search</button></form>';
  const form = document.querySelector('form')!, submitter = document.querySelector('button')!, order: string[] = [];
  submitter.addEventListener('click', e => { order.push('click'); if (cancel) e.preventDefault(); });
  form.addEventListener('submit', e => { e.preventDefault(); order.push('submit'); expect(e.submitter).toBe(submitter); });
  const result = await press('query', 'Enter');
  expect(order).toEqual(cancel ? ['click'] : ['click', 'submit']);
  expect(result).toMatchObject({verified: {submitted: !cancel}});
});
it('R07 does not implicitly submit multiple blocking fields without a submitter', async () => {
  document.body.innerHTML = '<form><input aria-label="query"><input></form>';
  const submit = vi.fn((e: Event) => e.preventDefault()); document.querySelector('form')!.addEventListener('submit', submit);
  expect(await press('query', 'Enter')).toMatchObject({verified: {submitted: false}});
  expect(submit).not.toHaveBeenCalled();
});
it('R07 finds a form-associated image submitter in document order', async () => {
  document.body.innerHTML = '<input form="f" type="image"><form id="f"><input aria-label="query"><button>Later</button></form>';
  const image = document.querySelector('input')!, clicks = vi.fn((e: Event) => e.preventDefault()); image.addEventListener('click', clicks);
  await press('query', 'Enter'); expect(clicks).toHaveBeenCalledTimes(1);
});

describe("key combinations and editing keys", () => {
  const combo = (name: string, key: string, modifiers?: string[]) => runAction("press", { operationId: "keyboard", generation: 1, ref: ref(name), key, ...(modifiers ? { modifiers } : {}) });
  it("Control+A selects only the text field, and a bare letter is refused before any event", async () => {
    document.body.innerHTML = '<input aria-label="메모" value="안녕하세요"><p>본문</p>';
    const input = document.querySelector('input')!;
    const flags: boolean[] = []; input.addEventListener('keydown', e => flags.push((e as KeyboardEvent).ctrlKey));
    expect(await combo('메모', 'a', ['Control'])).toMatchObject({ verified: { defaultAction: 'select-all', defaultApplied: true, modifiers: ['Control'] } });
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
    expect(document.getSelection()?.toString() ?? '').not.toContain('본문');
    expect(flags).toEqual([true]);
    const seen = vi.fn(); input.addEventListener('keydown', seen);
    await expect(combo('메모', 'a')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(combo('메모', 'a', ['Hyper'])).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(combo('메모', 'ab', ['Control'])).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(seen).not.toHaveBeenCalled();
  });
  it("Delete, Home, End and arrows edit and move inside a text field", async () => {
    document.body.innerHTML = '<input aria-label="칸" value="abc">';
    const input = document.querySelector('input')!; input.focus(); input.setSelectionRange(0, 0);
    const types: string[] = []; input.addEventListener('input', e => types.push((e as InputEvent).inputType));
    await combo('칸', 'Delete');
    expect(input.value).toBe('bc'); expect(types).toEqual(['deleteContentForward']);
    await combo('칸', 'End');
    expect(input.selectionStart).toBe(2);
    await combo('칸', 'ArrowLeft', ['Shift']);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 2]);
    await combo('칸', 'Home');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 0]);
    await combo('칸', 'ArrowRight');
    expect(input.selectionStart).toBe(1);
  });
  it("Delete is refused on a read-only field and other combinations only send flagged events", async () => {
    document.body.innerHTML = '<input aria-label="잠김" value="x" readonly><textarea aria-label="글">ab</textarea>';
    await expect(combo('잠김', 'Delete')).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
    const textarea = document.querySelector('textarea')!; textarea.setSelectionRange(1, 1);
    const seen: string[] = []; textarea.addEventListener('keydown', e => { const k = e as KeyboardEvent; seen.push(`${k.ctrlKey ? 'C+' : ''}${k.key}`); });
    expect(await combo('글', 'Enter', ['Control'])).toMatchObject({ verified: { defaultAction: 'event-only', defaultApplied: false } });
    expect(textarea.value).toBe('ab');
    expect(await combo('글', '7', ['Alt'])).toMatchObject({ verified: { defaultAction: 'event-only' } });
    expect(seen).toEqual(['C+Enter', '7']);
  });
});
