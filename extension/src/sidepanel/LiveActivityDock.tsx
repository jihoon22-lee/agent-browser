import { useEffect, useMemo, useState } from "react";
import { toolLabel } from "./tool-names";
import { ChecklistIcon, CheckIcon, ChevronIcon, SparkleIcon, TabIcon } from "./Icons";
import type { Operation } from "./status-store";
import type { Data, UiMessage } from "./workbench-state";

export type LivePhase = {
  kind: "idle" | "waiting" | "thinking" | "tool" | "responding" | "retry" | "paused";
  label: string;
  detail?: string;
  toolCount: number;
  completedTools: number;
  startedAt?: number;
};

function toolHintOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  for (const key of ["url", "ref", "text", "query", "action", "selector", "command", "filePath", "path", "description"]) {
    const value = (input as Data)[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ").slice(0, 64);
  }
  return "";
}

/** Derives a compact, live execution phase from the current turn's messages and session/operation status. */
export function deriveLivePhase(
  messages: UiMessage[],
  sessionStatus: Data | undefined,
  operation: Operation | null,
): LivePhase {
  const running = sessionStatus?.type === "busy" || sessionStatus?.type === "retry";
  if (!running && !operation?.paused) {
    return { kind: "idle", label: "", toolCount: 0, completedTools: 0 };
  }

  // Collect assistant messages since the last user prompt.
  const assistantTurn: UiMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.info.role === "user") break;
    assistantTurn.unshift(messages[i]!);
  }

  const tools: Data[] = [];
  let latestReasoning = "";
  let hasStreamingText = false;
  let startedAt: number | undefined;

  for (const msg of assistantTurn) {
    if (typeof msg.info.time?.created === "number" && (startedAt === undefined || msg.info.time.created < startedAt)) {
      startedAt = msg.info.time.created;
    }
    for (const part of msg.parts) {
      if (part.type === "tool") tools.push(part);
      else if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
        latestReasoning = part.text.trim();
      } else if (part.type === "text" && typeof part.text === "string" && part.text.trim() && !part.synthetic && !part.ignored) {
        hasStreamingText = true;
      }
    }
  }

  const toolCount = tools.length;
  const completedTools = tools.filter(t => t.state?.status === "completed" || t.state?.status === "error").length;

  if (operation?.paused) {
    return { kind: "paused", label: "직접 조작 대기 중", detail: "완료 후 [이어서 진행]을 누르세요", toolCount, completedTools, startedAt };
  }
  if (sessionStatus?.type === "retry") {
    const attempt = sessionStatus.attempt ? ` (${sessionStatus.attempt}회)` : "";
    return {
      kind: "retry",
      label: `재시도 대기${attempt}`,
      detail: typeof sessionStatus.message === "string" ? sessionStatus.message.slice(0, 72) : undefined,
      toolCount,
      completedTools,
      startedAt,
    };
  }

  const activeTool = [...tools].reverse().find(t => t.state?.status === "running" || t.state?.status === "pending");
  if (activeTool) {
    const name = activeTool.state?.title || toolLabel(activeTool.tool) || activeTool.tool || "도구 실행";
    const hint = toolHintOf(activeTool.state?.input);
    return { kind: "tool", label: `${name} 실행 중`, detail: hint || undefined, toolCount, completedTools, startedAt };
  }

  // If the last part in the latest assistant message is reasoning, show live thinking preview.
  const lastPart = assistantTurn.at(-1)?.parts.at(-1);
  if (lastPart?.type === "reasoning" && latestReasoning) {
    const lastLine = latestReasoning.split("\n").map(l => l.trim()).filter(Boolean).at(-1) ?? "";
    return { kind: "thinking", label: "추론 중", detail: lastLine.slice(0, 72) || undefined, toolCount, completedTools, startedAt };
  }

  if (hasStreamingText) {
    return { kind: "responding", label: "응답 작성 중", detail: toolCount ? `도구 ${completedTools}/${toolCount} 완료` : undefined, toolCount, completedTools, startedAt };
  }

  return { kind: "waiting", label: "응답을 준비하는 중", detail: toolCount ? `도구 ${completedTools}/${toolCount} 완료` : undefined, toolCount, completedTools, startedAt };
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}초`;
  return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}

export function LiveActivityDock({
  messages,
  sessionStatus,
  operation,
  todos,
  onFocusTab,
}: {
  messages: UiMessage[];
  sessionStatus: Data | undefined;
  operation: Operation | null;
  todos: Data[];
  onFocusTab?: (tabId: number) => void;
}) {
  const phase = useMemo(() => deriveLivePhase(messages, sessionStatus, operation), [messages, sessionStatus, operation]);
  const [todosOpen, setTodosOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const active = phase.kind !== "idle";
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const todoStats = useMemo(() => {
    const total = todos.length;
    const done = todos.filter(t => t.status === "completed").length;
    const current = todos.find(t => t.status === "in_progress") ?? todos.find(t => t.status !== "completed");
    return { total, done, current };
  }, [todos]);

  if (!active && !todoStats.total) return null;

  const elapsed = active && phase.startedAt ? formatElapsed(Math.max(0, now - phase.startedAt)) : "";

  return (
    <div className="live-dock" aria-label="실시간 작업 상태">
      {active && (
        <div className={`live-phase phase-${phase.kind}`} role="status">
          <span className="live-pulse" aria-hidden="true" />
          <div className="live-phase-body">
            <div className="live-phase-head">
              <SparkleIcon size={13} className="live-phase-icon" />
              <strong>{phase.label}</strong>
              {phase.toolCount > 0 && (
                <span className="live-chip">{phase.completedTools}/{phase.toolCount}단계</span>
              )}
              {elapsed && <span className="live-elapsed">{elapsed}</span>}
            </div>
            {phase.detail && <span className="live-phase-detail" title={phase.detail}>{phase.detail}</span>}
          </div>
          {operation?.currentTab && onFocusTab && (
            <button
              type="button"
              className="quiet live-tab-jump"
              title="작업 중인 탭으로 이동"
              onClick={() => onFocusTab(operation.currentTab)}
            >
              <TabIcon size={12} />
              <span>탭 #{operation.currentTab}</span>
            </button>
          )}
        </div>
      )}

      {todoStats.total > 0 && (
        <div className="live-todos">
          <button
            type="button"
            className="live-todos-toggle"
            aria-expanded={todosOpen}
            onClick={() => setTodosOpen(v => !v)}
          >
            <ChecklistIcon size={13} />
            <span className="live-todos-summary">
              <strong>할 일 {todoStats.done}/{todoStats.total}</strong>
              {todoStats.current?.content && <span className="live-todos-next">{String(todoStats.current.content)}</span>}
            </span>
            <span className="live-todos-bar" aria-hidden="true">
              <span style={{ width: `${Math.round((todoStats.done / todoStats.total) * 100)}%` }} />
            </span>
            <ChevronIcon size={12} className={todosOpen ? "rotated" : undefined} />
          </button>
          {todosOpen && (
            <ul className="live-todos-list">
              {todos.map((todo, idx) => {
                const status = String(todo.status ?? "pending");
                return (
                  <li key={idx} className={`todo-item todo-${status}`}>
                    <span className="todo-marker" aria-hidden="true">
                      {status === "completed" ? <CheckIcon size={11} /> : status === "in_progress" ? "●" : "○"}
                    </span>
                    <span className="todo-text">{String(todo.content ?? "")}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
