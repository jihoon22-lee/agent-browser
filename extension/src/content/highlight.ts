/** An outline around the element being clicked; click-through and invisible to snapshots
 * (closed shadow root outside <body>). It is added before the click's change observation starts
 * and removed by the caller after it ends, so it never reads as a page change or leaves a timer. */
export function highlight(el: Element): () => void {
  const id = "agent-browser-target";
  document.getElementById(id)?.remove();
  const rect = el.getBoundingClientRect();
  const host = document.createElement("div");
  host.id = id; host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px;pointer-events:none;z-index:2147483647`;
  const ring = document.createElement("div");
  ring.style.cssText = "position:absolute;inset:0;border:2px solid #f59e0b;border-radius:4px;box-sizing:border-box";
  host.attachShadow({ mode: "closed" }).append(ring);
  document.documentElement.append(host);
  return () => host.remove();
}
