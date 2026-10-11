// Mimics React's controlled-input value tracker: assigning el.value directly
// updates the DOM but the app only learns about it through an 'input' event
// whose value differs from the tracked value.
export function controlledInput(el, onChange) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  let tracked = el.value;
  Object.defineProperty(el, "value", {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { tracked = String(v); desc.set.call(this, v); },
  });
  el.addEventListener("input", () => {
    const now = desc.get.call(el);
    if (now !== tracked) { tracked = now; onChange(now); }
  });
}
export async function postJson(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
