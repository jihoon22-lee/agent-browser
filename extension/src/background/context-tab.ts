/** The tab that "현재 탭" and "선택 영역" read: the running operation's tab first, as before; otherwise the
 * tab the person chose as the next request's target; otherwise the active tab of the last focused window. */
type StatusOp = { id?: string; clientId: string; currentTab: number };
export async function contextTab(
  status: { operation?: StatusOp | null; operations?: StatusOp[] } | undefined,
  clientId: unknown,
  chosenTabId: number | undefined,
  api: { get(id: number): Promise<chrome.tabs.Tab>; active(): Promise<chrome.tabs.Tab | undefined> },
  operationId?: string,
): Promise<chrome.tabs.Tab | undefined> {
  const operations = status?.operations ?? (status?.operation ? [status.operation] : []);
  // This conversation's operation; while only one runs, that one, as before. Another conversation's tab is never read.
  const operation = operations.find(op => operationId !== undefined && op.id === operationId) ?? (operations.length === 1 ? operations[0] : undefined);
  if (operation && operation.clientId !== clientId) throw new Error("현재 작업은 다른 브라우저에 연결되어 있습니다.");
  if (operation) return api.get(operation.currentTab);
  if (Number.isInteger(chosenTabId)) {
    try { return await api.get(chosenTabId!); } catch { throw new Error("선택한 대상 탭을 찾을 수 없습니다. 닫혔으면 대상을 다시 고르세요."); }
  }
  return api.active();
}
