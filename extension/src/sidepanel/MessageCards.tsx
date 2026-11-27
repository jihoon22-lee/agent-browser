import { memo, useEffect, useState, type ReactNode } from "react";
import { SafeMarkdown, safeLink } from "./SafeMarkdown";
import { download, toolOutcome, type Data, type UiMessage } from "./workbench-state";
import { toolLabel } from "./tool-names";
import { CopyButton } from "./CopyButton";
import { AlertIcon, CheckIcon, SparkleIcon, StepsIcon } from "./Icons";
import { ImagePreview, InteractiveTable } from "./RichResultViewers";
import type { A2uiActionEvent, A2uiActionResult } from "./a2ui/A2uiCard";

export function QuestionCard({ request, onReply }: { request: Data; onReply: (request: Data, answers?: string[][]) => Promise<void> }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => "")), [busy, setBusy] = useState(false);
  const submit = async (reject = false) => { if (busy) return; setBusy(true); try { await onReply(request, reject ? undefined : answers.map((answer, i) => custom[i]?.trim() ? [...answer, custom[i]!.trim()] : answer)); } finally { setBusy(false); } };
  return <article className="request-card" aria-label="질문"><h3><SparkleIcon size={14} /> 답변이 필요합니다</h3>{request.questions.map((question: Data, index: number) => <fieldset key={index} disabled={busy}><legend>{question.header}</legend><p>{question.question}</p>
    {(question.options ?? []).map((option: Data) => <label className="choice" key={option.label}><input type={question.multiple ? "checkbox" : "radio"} name={`${request.id}-${index}`} checked={answers[index]?.includes(option.label) ?? false} onChange={event => { setAnswers(previous => previous.map((value, i) => i !== index ? value : question.multiple ? event.target.checked ? [...value, option.label] : value.filter(item => item !== option.label) : [option.label])); if (!question.multiple) setCustom(previous => previous.map((value, i) => i === index ? "" : value)); }} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
    {question.custom !== false && <label>직접 답변<input value={custom[index] ?? ""} onChange={event => { setCustom(previous => previous.map((value, i) => i === index ? event.target.value : value)); if (!question.multiple) setAnswers(previous => previous.map((value, i) => i === index ? [] : value)); }} /></label>}
  </fieldset>)}<div className="toolbar"><button className="primary" disabled={busy || answers.some((answer, i) => !answer.length && !custom[i]?.trim())} onClick={() => void submit()}>답변 제출</button><button disabled={busy} onClick={() => void submit(true)}>질문 취소</button></div></article>;
}
export function PermissionCard({ request, onReply }: { request: Data; onReply: (request: Data, reply: "once" | "always" | "reject") => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const answer = async (reply: "once" | "always" | "reject") => { if (busy) return; setBusy(true); try { await onReply(request, reply); } finally { setBusy(false); } };
  return <article className="request-card permission-card" aria-label="권한 요청"><h3><AlertIcon size={14} /> 권한 확인 · {request.permission}</h3><p>요청 대상</p><ul>{(request.patterns ?? []).map((pattern: string) => <li key={pattern}><code>{pattern}</code></li>)}</ul><details><summary>도구·명령과 세부 범위</summary><pre>{JSON.stringify({ tool: request.tool, metadata: request.metadata }, null, 2)}</pre></details>
    <div className="toolbar"><button className="primary" disabled={busy} onClick={() => void answer("once")}>한 번 허용</button><button disabled={busy} onClick={() => void answer("always")}>이 규칙 기억</button><button disabled={busy} onClick={() => void answer("reject")}>거부</button></div><small>기억할 범위: {(request.always ?? []).join(", ") || "서버가 정의한 요청 범위"}. OpenCode 정책의 always 응답이며 모든 작업의 영구 허용이 아닙니다.</small></article>;
}
function safeDownloadName(name: unknown): string {
  const cleaned = String(name ?? "attachment").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim();
  return cleaned || "attachment";
}
function FileResult({ part, onOpenFile }: { part: Data; onOpenFile?: (part: Data) => void }) {
  const url = String(part.url ?? ""), data = url.startsWith("data:"), href = data ? url : safeLink(url);
  const isImage = data && /^data:image\/(png|jpeg|webp|gif);/i.test(url);
  const downloadName = safeDownloadName(part.filename);
  return <div className="file-result">
    {isImage && <ImagePreview src={url} alt={part.filename ?? "첨부 이미지"} downloadName={downloadName} />}
    {href ? <a href={href} download={data ? downloadName : undefined} target={data ? undefined : "_blank"} rel="noopener noreferrer">{part.filename ?? "첨부 결과 열기"}</a> : <span>{part.filename ?? "파일 결과"} · 서버 경로: {url}{onOpenFile && (url.startsWith("file:") || part.source?.path) && <button onClick={() => onOpenFile(part)}>서버 파일 열기</button>}</span>}
  </div>;
}
function formatDuration(start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const ms = Math.round(end - start);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`;
  const min = Math.floor(ms / 60_000), sec = Math.round((ms % 60_000) / 1000);
  return `${min}분 ${sec}초`;
}
function BatchStepsPreview({ steps, completed }: { steps: Data[]; completed?: number }) {
  return (
    <ol className="batch-steps" aria-label="묶음 실행 단계">
      {steps.map((step, index) => {
        const name = toolLabel(`browser_${step.tool}`) ?? String(step.tool ?? "단계");
        const hint = toolHint(step);
        const ran = typeof completed === "number" ? index < completed : undefined;
        return (
          <li key={index} className={ran === true ? "done" : ran === false ? "skipped" : undefined}>
            <span className="batch-step-index">{index + 1}</span>
            <strong>{name}</strong>
            {hint && <span className="batch-step-hint">{hint}</span>}
          </li>
        );
      })}
    </ol>
  );
}
function ToolCard({ part, onOpenFile }: { part: Data; onOpenFile?: (part: Data) => void }) {
  const state = part.state ?? {}, raw = state.status === "error" ? state.error ?? state.output : state.output ?? state.error, outcome = toolOutcome(raw);
  const status = outcome?.ok === false ? "error" : state.status;
  const [open, setOpen] = useState(status === "error");
  // A call that fails after its card was drawn opens just like one that arrived failed.
  useEffect(() => { if (status === "error") setOpen(true); }, [status]);
  const hint = toolHint(state.input);
  const duration = formatDuration(state.time?.start, state.time?.end);
  const statusIcon = status === "completed"
    ? <CheckIcon size={12} className="tool-state-icon status-completed" />
    : status === "error"
      ? <AlertIcon size={12} className="tool-state-icon status-error" />
      : <span className={`tool-state-dot status-${status ?? "pending"}`} aria-hidden="true" />;
  return <details className={`tool-card ${status ?? "pending"}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><span className="tool-summary-main">{statusIcon}<span className="tool-summary-text"><span className="tool-summary-title">{state.title || toolLabel(part.tool) || part.tool || "도구"}</span>{hint && <small className="tool-hint">{hint}</small>}</span></span><span className="tool-meta">{duration && <small className="tool-duration">{duration}</small>}<span className={`tool-status-badge status-${status ?? "pending"}`}>{({ pending: "대기", running: "실행 중", completed: "완료", error: "오류" } as Data)[status] ?? status}</span></span></summary>
    {open && <ToolDetails part={part} raw={raw} outcome={outcome} onOpenFile={onOpenFile} />}
  </details>;
}
/** Snapshot text and screenshots become DOM only while the card is open; long conversations hold dozens of them. */
function ToolDetails({ part, raw, outcome, onOpenFile }: { part: Data; raw: unknown; outcome: Data | null; onOpenFile?: (part: Data) => void }) {
  const state = part.state ?? {}, output = raw === undefined ? "" : typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  const table = outcome?.data && Array.isArray(outcome.data.rows) ? outcome.data : undefined;
  const batchSteps = Array.isArray(state.input?.steps) ? (state.input.steps as Data[]) : undefined;
  const batchCompleted = typeof outcome?.data?.completedSteps === "number" ? outcome.data.completedSteps : undefined;
  const error = outcome?.error ?? (state.status === "error" ? { message: typeof state.error === "string" ? state.error : "도구 실행에 실패했습니다." } : undefined);
  let details = output;
  if (error) { try { details = JSON.stringify(JSON.parse(output), null, 2); } catch { /* Plain OpenCode errors need no JSON decoding. */ } }
  return <>
    <p className="muted">{part.tool}</p>
    {batchSteps && batchSteps.length > 0 && <BatchStepsPreview steps={batchSteps} completed={batchCompleted} />}
    <details><summary>입력</summary><pre>{JSON.stringify(state.input ?? {}, null, 2)}</pre></details>
    {error && <><p role="alert">{error.code ? `${error.code}: ` : ""}{error.message}</p>{error.code === "UNSUPPORTED_PAGE" && <p>일반 HTTP/HTTPS 페이지를 열고 해당 탭의 URL이나 제목을 지정해 다시 요청하세요. Chrome 설정·새 탭·확장 프로그램 페이지는 브라우저 도구로 읽거나 조작할 수 없습니다.</p>}</>}
    {table && <InteractiveTable columns={Array.isArray(table.header) ? table.header : undefined} rows={table.rows} markdown={typeof table.markdown === "string" ? table.markdown : undefined} />}
    {output && (error ? <details className="tool-error-details"><summary>오류 세부 정보</summary><pre>{details.slice(0, 20000)}</pre></details> : table ? <details className="tool-raw-details"><summary>원본 JSON 보기</summary><pre>{output.slice(0, 20000)}{output.length > 20000 ? "\n… 화면 표시가 잘렸습니다. 결과 내보내기로 전체를 확인하세요." : ""}</pre></details> : <pre>{output.slice(0, 20000)}{output.length > 20000 ? "\n… 화면 표시가 잘렸습니다. 결과 내보내기로 전체를 확인하세요." : ""}</pre>)}
    <div className="toolbar"><CopyButton text={output} label="결과 복사" /><button onClick={() => download("tool-result.txt", output)}>결과 내보내기</button></div>
    {(state.attachments ?? []).map((attachment: Data, index: number) => <FileResult key={attachment.id ?? index} part={attachment} onOpenFile={onOpenFile} />)}
  </>;
}
const HINT_KEYS = ["url", "ref", "text", "query", "action", "selector", "command", "filePath", "path", "pattern", "description"];
// One short argument tells which page, element or file a call touched without opening the card.
function toolHint(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  for (const key of HINT_KEYS) { const value = (input as Data)[key]; if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ").slice(0, 80); }
  return "";
}
const hasText = (part: Data) => typeof part.text === "string" && part.text.trim() !== "" && !part.synthetic && !part.ignored;
function renderPart(
  part: Data,
  options: { user: boolean; enableA2ui?: boolean; onOpenFile?: (part: Data) => void; onA2uiAction?: (action: A2uiActionEvent) => A2uiActionResult | void },
): ReactNode {
  switch (part.type) {
    case "text": return hasText(part) ? <SafeMarkdown text={part.text} enableA2ui={!options.user && options.enableA2ui !== false} onA2uiAction={options.onA2uiAction} /> : null;
    case "reasoning": {
      if (!hasText(part)) return null;
      const duration = formatDuration(part.time?.start, part.time?.end);
      const snippet = String(part.text).trim().split("\n").map(l => l.trim()).filter(Boolean).at(-1)?.slice(0, 72) ?? "";
      return (
        <details className="reasoning">
          <summary>
            <span className="reasoning-head"><SparkleIcon size={12} /> <span>추론 과정</span>{duration && <small className="reasoning-duration">{duration}</small>}</span>
            {snippet && <small className="reasoning-preview">{snippet}</small>}
          </summary>
          <SafeMarkdown text={part.text} />
        </details>
      );
    }
    case "tool": return <ToolCard part={part} onOpenFile={options.onOpenFile} />;
    case "file": return <FileResult part={part} onOpenFile={options.onOpenFile} />;
    case "subtask": return <details className="subtask-card" open><summary><StepsIcon size={12} /> 하위 작업 · <span className="chip">{part.agent}</span></summary><p>{part.description}</p><SafeMarkdown text={part.prompt ?? ""} /></details>;
    case "agent": return <span className="chip">@{part.name}</span>;
    case "compaction": return <p className="notice">컨텍스트 압축{part.auto ? " · 자동" : ""}</p>;
    case "patch": return <details className="patch-card"><summary>파일 변경</summary><pre>{JSON.stringify(part.files ?? part, null, 2)}</pre></details>;
    case "retry": return <p className="notice">재시도 {part.attempt}: {part.error?.data?.message ?? part.error?.message}</p>;
    default: return null;
  }
}
/** Step markers, snapshots and empty text/reasoning parts carry nothing to read. */
export function hasVisibleContent(message: UiMessage): boolean {
  return !!message.info.error || message.info.role === "user" || message.parts.some(part => ["text", "reasoning"].includes(part.type) ? hasText(part) : ["tool", "file", "subtask", "agent", "compaction", "patch", "retry"].includes(part.type));
}
export const messageText = (message: UiMessage) => message.parts.filter(part => part.type === "text" && !part.synthetic && !part.ignored).map(part => String(part.text ?? "")).join("\n");
const time = (message: UiMessage) => message.info.time?.created ? new Date(message.info.time.created).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "";
type CardProps = { message: UiMessage; continued?: boolean; enableA2ui?: boolean; onFork: (messageID: string) => void; onRevert: (messageID: string) => void; onOpenFile?: (part: Data) => void; onA2uiAction?: (action: A2uiActionEvent) => A2uiActionResult | void; retryText?: string; onRetry?: (text: string) => void };
/** Assistant steps of one reply share a header (`continued`); fork and revert belong to the user's prompt. */
export const MessageCard = memo(function MessageCard({ message, continued, enableA2ui = true, onFork, onRevert, onOpenFile, onA2uiAction, retryText, onRetry }: CardProps) {
  const user = message.info.role === "user";
  const [confirmRevert, setConfirmRevert] = useState(false);
  const rendered: Array<{ key: string | number; type: string; node: ReactNode }> = [];
  for (let index = 0; index < message.parts.length; index++) {
    const part = message.parts[index]!;
    const node = renderPart(part, { user, enableA2ui, onOpenFile, onA2uiAction });
    if (node !== null) rendered.push({ key: part.id ?? index, type: part.type, node });
  }
  // Group consecutive tool parts visually into a connected step rail.
  const grouped: ReactNode[] = [];
  for (let i = 0; i < rendered.length; i++) {
    if (rendered[i]!.type === "tool") {
      const run = [rendered[i]!];
      while (i + 1 < rendered.length && rendered[i + 1]!.type === "tool") run.push(rendered[++i]!);
      grouped.push(
        <div key={`rail-${run[0]!.key}`} className={run.length > 1 ? "tool-step-rail multi" : "tool-step-rail"}>
          {run.map(item => <div key={item.key} className="tool-step-node">{item.node}</div>)}
        </div>,
      );
    } else {
      grouped.push(<div key={rendered[i]!.key}>{rendered[i]!.node}</div>);
    }
  }
  return <article className={`message ${user ? "user" : "assistant"}${continued ? " continued" : ""}`} data-message-id={message.info.id}>
    {!continued && <header><strong className={user ? undefined : "assistant-name"}>{!user && <SparkleIcon size={12} />}{user ? "나" : message.info.agent ?? "OpenCode"}</strong><time>{time(message)}</time>
      {user && <span className="message-actions"><button onClick={() => onFork(message.info.id)}>여기서 분기</button><button onClick={() => setConfirmRevert(true)}>이전으로 되돌리기</button></span>}</header>}
    {confirmRevert && <div className="inline-confirm" role="group" aria-label="되돌리기 확인" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setConfirmRevert(false); } }}><p>이 메시지 이전으로 대화·서버 파일 변경을 되돌릴까요? 이미 완료된 웹사이트 작업은 되돌리지 않습니다.</p><div className="toolbar"><button className="stop" onClick={() => { setConfirmRevert(false); onRevert(message.info.id); }}>되돌리기 확인</button><button autoFocus onClick={() => setConfirmRevert(false)}>취소</button></div></div>}
    {grouped}
    {message.info.error && <div className="error" role="alert"><span>{message.info.error.data?.message ?? message.info.error.message ?? message.info.error.name}</span>{!user && retryText && onRetry && <div className="toolbar"><button type="button" onClick={() => onRetry(retryText)}>수정 후 재전송</button></div>}</div>}
  </article>;
});
