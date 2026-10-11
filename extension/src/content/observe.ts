/** MutationObserver does not cross shadow boundaries. Watch each open root too. */
export function observePage(onChange: () => void) {
  const roots = new WeakSet<ShadowRoot>();
  const options = { subtree: true, childList: true, attributes: true, characterData: true };
  let closed = false;
  const observer = new MutationObserver(() => { refresh(); onChange(); });
  function refresh(): boolean {
    if (closed) return false;
    let added = false;
    function scan(root: Document | ShadowRoot) {
      for (const host of root.querySelectorAll("*")) {
        const shadow = host.shadowRoot;
        if (!shadow) continue;
        if (!roots.has(shadow)) { roots.add(shadow); observer.observe(shadow, options); added = true; }
        scan(shadow);
      }
    }
    scan(document);
    return added;
  }
  observer.observe(document, options);
  refresh();
  return { refresh, disconnect: () => { closed = true; observer.disconnect(); } };
}
