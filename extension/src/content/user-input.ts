/** Only physical input invalidates popup attribution. Agent DOM events are
 * synthetic; focus events are intentionally excluded because focus() is trusted. */
export function observeUserInput(target: EventTarget) {
  let epoch = 0;
  const document = crypto.randomUUID();
  const changed = (event: Event) => { if (event.isTrusted) epoch++; };
  for (const name of ['pointerdown','pointerup','mousedown','mouseup','keydown','keyup','click','auxclick','contextmenu']) {
    target.addEventListener(name, changed, true);
  }
  return () => ({ document, epoch });
}
