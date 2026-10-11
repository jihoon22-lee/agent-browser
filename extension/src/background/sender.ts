/** True only for messages sent by this extension's own pages (options, side panel), never by content scripts. */
export function isExtensionPage(sender: { id?: string; url?: string; tab?: unknown }, runtimeId: string): boolean {
  // The options page opens in a tab, so `sender.tab` cannot tell it apart from a content script.
  // A content script's `sender.url` is the web page it runs in; an extension page's is chrome-extension://<id>/….
  return sender.id === runtimeId && typeof sender.url === "string" && sender.url.startsWith(`chrome-extension://${runtimeId}/`);
}
