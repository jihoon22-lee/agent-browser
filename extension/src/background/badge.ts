/** Toolbar icon state: work in this browser, a user hand-over, or an answer the agent waits for. */
export type BadgeInput = { operation: { clientId: string; paused?: boolean } | null; clientId?: string; waiting: boolean };
export type Badge = { text: string; color: string; title: string };

export function badgeFor({ operation, clientId, waiting }: BadgeInput): Badge {
  const mine = operation && clientId && operation.clientId === clientId ? operation : null;
  if (waiting) return { text: "!", color: "#d97706", title: "AgentBrowser — 응답이 필요합니다" };
  if (mine?.paused) return { text: "‖", color: "#6b7280", title: "AgentBrowser — 사용자가 조작 중" };
  if (mine) return { text: "●", color: "#2563eb", title: "AgentBrowser — 작업 중" };
  return { text: "", color: "#2563eb", title: "AgentBrowser" };
}

export async function applyBadge(badge: Badge) {
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.action.setTitle({ title: badge.title });
}
