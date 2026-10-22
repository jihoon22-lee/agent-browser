/** MutationObserver does not cross shadow boundaries. Watch each open root too. */
export function observePage(onChange: () => void) {
  const roots = new WeakSet<ShadowRoot>();
  const options = { subtree: true, childList: true, attributes: true, characterData: true };
  let closed = false;
  function scan(root: Document | ShadowRoot | Element): boolean {
    let added = false;
    const visit = (host: Element) => {
      const shadow = host.shadowRoot;
      if (!shadow) return;
      if (!roots.has(shadow)) { roots.add(shadow); observer.observe(shadow, options); added = true; }
      added = scan(shadow) || added;
    };
    if (root instanceof Element) visit(root);
    for (const host of root.querySelectorAll('*')) visit(host);
    return added;
  }
  const observer = new MutationObserver(records => {
    if (closed) return;
    for (const record of records) for (const node of record.addedNodes)
      if (node instanceof Element) scan(node);
    onChange();
  });
  function refresh(): boolean {
    if (closed) return false;
    // Polling still discovers attachShadow on an existing host (no DOM mutation).
    return scan(document);
  }
  observer.observe(document, options);
  refresh();
  return { refresh, disconnect: () => { closed = true; observer.disconnect(); } };
}
