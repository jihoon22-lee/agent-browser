/** The tab that "현재 탭" and "선택 영역" read: the running operation's tab first, as before; otherwise the
 * tab the person chose as the next request's target; otherwise the active tab of the last focused window. */
export async function contextTab(
  status: { operation?: { clientId: string; currentTab: number } } | undefined,
  clientId: unknown,
  chosenTabId: number | undefined,
  api: { get(id: number): Promise<chrome.tabs.Tab>; active(): Promise<chrome.tabs.Tab | undefined> },
): Promise<chrome.tabs.Tab | undefined> {
  if (status?.operation && status.operation.clientId !== clientId) throw new Error("현재 작업은 다른 브라우저에 연결되어 있습니다.");
  if (status?.operation) return api.get(status.operation.currentTab);
  if (Number.isInteger(chosenTabId)) return api.get(chosenTabId!);
  return api.active();
}
