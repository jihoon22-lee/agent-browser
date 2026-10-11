import { memo, useState, type ReactNode } from "react";
import { SafeMarkdown, safeLink } from "./SafeMarkdown";
import { csv, download, toolOutcome, type Data, type UiMessage } from "./workbench-state";

export function QuestionCard({ request, onReply }: { request: Data; onReply: (request: Data, answers?: string[][]) => Promise<void> }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => "")), [busy, setBusy] = useState(false);
  const submit = async (reject = false) => { if (busy) return; setBusy(true); try { await onReply(request, reject ? undefined : answers.map((answer, i) => custom[i]?.trim() ? [...answer, custom[i]!.trim()] : answer)); } finally { setBusy(false); } };
  return <article className="request-card" aria-label="질문"><h3>답변이 필요합니다</h3>{request.questions.map((question: Data, index: number) => <fieldset key={index} disabled={busy}><legend>{question.header}</legend><p>{question.question}</p>
    {(question.options ?? []).map((option: Data) => <label className="choice" key={option.label}><input type={question.multiple ? "checkbox" : "radio"} name={`${request.id}-${index}`} checked={answers[index]?.includes(option.label) ?? false} onChange={event => { setAnswers(previous => previous.map((value, i) => i !== index ? value : question.multiple ? event.target.checked ? [...value, option.label] : value.filter(item => item !== option.label) : [option.label])); if (!question.multiple) setCustom(previous => previous.map((value, i) => i === index ? "" : value)); }} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
    {question.custom !== false && <label>직접 답변<input value={custom[index] ?? ""} onChange={event => { setCustom(previous => previous.map((value, i) => i === index ? event.target.value : value)); if (!question.multiple) setAnswers(previous => previous.map((value, i) => i === index ? [] : value)); }} /></label>}
  </fieldset>)}<div className="toolbar"><button disabled={busy || answers.some((answer, i) => !answer.length && !custom[i]?.trim())} onClick={() => void submit()}>답변 제출</button><button disabled={busy} onClick={() => void submit(true)}>질문 취소</button></div></article>;
}
export function PermissionCard({ request, onReply }: { request: Data; onReply: (request: Data, reply: "once" | "always" | "reject") => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const answer = async (reply: "once" | "always" | "reject") => { if (busy) return; setBusy(true); try { await onReply(request, reply); } finally { setBusy(false); } };
  return <article className="request-card permission-card" aria-label="권한 요청"><h3>권한 확인 · {request.permission}</h3><p>요청 대상</p><ul>{(request.patterns ?? []).map((pattern: string) => <li key={pattern}><code>{pattern}</code></li>)}</ul><details><summary>도구·명령과 세부 범위</summary><pre>{JSON.stringify({ tool: request.tool, metadata: request.metadata }, null, 2)}</pre></details>
    <div className="toolbar"><button disabled={busy} onClick={() => void answer("once")}>한 번 허용</button><button disabled={busy} onClick={() => void answer("always")}>이 규칙 기억</button><button disabled={busy} onClick={() => void answer("reject")}>거부</button></div><small>기억할 범위: {(request.always ?? []).join(", ") || "서버가 정의한 요청 범위"}. OpenCode 정책의 always 응답이며 모든 작업의 영구 허용이 아닙니다.</small></article>;
}
function FileResult({ part, onOpenFile }: { part: Data; onOpenFile?: (part: Data) => void }) {
  const url = String(part.url ?? ""), data = url.startsWith("data:"), href = data ? url : safeLink(url);
  return <div className="file-result">{data && /^data:image\/(png|jpeg|webp|gif);/i.test(url) && <img src={url} alt={part.filename ?? "첨부 이미지"} />}{href ? <a href={href} download={data ? part.filename ?? "attachment" : undefined} target={data ? undefined : "_blank"} rel="noopener noreferrer">{part.filename ?? "첨부 결과 열기"}</a> : <span>{part.filename ?? "파일 결과"} · 서버 경로: {url}{onOpenFile && (url.startsWith("file:") || part.source?.path) && <button onClick={() => onOpenFile(part)}>서버 파일 열기</button>}</span>}</div>;
}
function ToolCard({ part, onOpenFile }: { part: Data; onOpenFile?: (part: Data) => void }) {
  const state = part.state ?? {}, raw = state.status === "error" ? state.error ?? state.output : state.output ?? state.error, outcome = toolOutcome(raw), output = typeof raw === "string" ? raw : JSON.stringify(raw ?? "", null, 2);
  const status = outcome?.ok === false ? "error" : state.status;
  const table = outcome?.data && Array.isArray(outcome.data.rows) ? outcome.data : undefined;
  const error = outcome?.error ?? (state.status === "error" ? { message: typeof state.error === "string" ? state.error : "도구 실행에 실패했습니다." } : undefined);
  let details = output;
  if (error) { try { details = JSON.stringify(JSON.parse(output), null, 2); } catch { /* Plain OpenCode errors need no JSON decoding. */ } }
  const hint = toolHint(state.input);
  return <details className={`tool-card ${status ?? "pending"}`} open={status === "error"}><summary><span>{state.title || part.tool || "도구"}{hint && <small className="tool-hint">{hint}</small>}</span><span>{({ pending: "대기", running: "실행 중", completed: "완료", error: "오류" } as Data)[status] ?? status}</span></summary>
    <p className="muted">{part.tool}</p><details><summary>입력</summary><pre>{JSON.stringify(state.input ?? {}, null, 2)}</pre></details>
    {error && <><p role="alert">{error.code ? `${error.code}: ` : ""}{error.message}</p>{error.code === "UNSUPPORTED_PAGE" && <p>일반 HTTP/HTTPS 페이지를 열고 해당 탭의 URL이나 제목을 지정해 다시 요청하세요. Chrome 설정·새 탭·확장 프로그램 페이지는 브라우저 도구로 읽거나 조작할 수 없습니다.</p>}</>}
    {output && (error ? <details className="tool-error-details"><summary>오류 세부 정보</summary><pre>{details.slice(0, 20000)}</pre></details> : <pre>{output.slice(0, 20000)}{output.length > 20000 ? "\n… 화면 표시가 잘렸습니다. 결과 내보내기로 전체를 확인하세요." : ""}</pre>)}
    <div className="toolbar"><button onClick={() => void navigator.clipboard.writeText(output)}>결과 복사</button><button onClick={() => download("tool-result.txt", output)}>결과 내보내기</button>{table && <><button onClick={() => download("table.csv", "\uFEFF" + csv([...(table.header ? [table.header] : []), ...table.rows]), "text/csv;charset=utf-8")}>표 CSV</button><button onClick={() => download("table.md", table.markdown ?? "", "text/markdown")}>표 Markdown</button></>}</div>
    {(state.attachments ?? []).map((attachment: Data, index: number) => <FileResult key={attachment.id ?? index} part={attachment} onOpenFile={onOpenFile} />)}
  </details>;
}
const HINT_KEYS = ["url", "ref", "text", "query", "action", "selector", "command", "filePath", "path", "pattern", "description"];
// One short argument tells which page, element or file a call touched without opening the card.
function toolHint(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  for (const key of HINT_KEYS) { const value = (input as Data)[key]; if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ").slice(0, 80); }
  return "";
}
const hasText = (part: Data) => typeof part.text === "string" && part.text.trim() !== "";
function renderPart(part: Data, onOpenFile?: (part: Data) => void): ReactNode {
  switch (part.type) {
    case "text": return hasText(part) ? <SafeMarkdown text={part.text} /> : null;
    case "reasoning": return hasText(part) ? <details className="reasoning"><summary>추론 과정</summary><SafeMarkdown text={part.text} /></details> : null;
    case "tool": return <ToolCard part={part} onOpenFile={onOpenFile} />;
    case "file": return <FileResult part={part} onOpenFile={onOpenFile} />;
    case "subtask": return <details open><summary>하위 작업 · {part.agent}</summary><p>{part.description}</p><SafeMarkdown text={part.prompt ?? ""} /></details>;
    case "agent": return <span className="chip">@{part.name}</span>;
    case "compaction": return <p className="notice">컨텍스트 압축{part.auto ? " · 자동" : ""}</p>;
    case "patch": return <details><summary>파일 변경</summary><pre>{JSON.stringify(part.files ?? part, null, 2)}</pre></details>;
    case "retry": return <p className="notice">재시도 {part.attempt}: {part.error?.data?.message ?? part.error?.message}</p>;
    default: return null;
  }
}
/** Step markers, snapshots and empty text/reasoning parts carry nothing to read. */
export function hasVisibleContent(message: UiMessage): boolean {
  return !!message.info.error || message.info.role === "user" || message.parts.some(part => ["text", "reasoning"].includes(part.type) ? hasText(part) : ["tool", "file", "subtask", "agent", "compaction", "patch", "retry"].includes(part.type));
}
export const messageText = (message: UiMessage) => message.parts.filter(part => part.type === "text").map(part => String(part.text ?? "")).join("\n");
const time = (message: UiMessage) => message.info.time?.created ? new Date(message.info.time.created).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "";
type CardProps = { message: UiMessage; continued?: boolean; onFork: (messageID: string) => void; onRevert: (messageID: string) => void; onOpenFile?: (part: Data) => void };
/** Assistant steps of one reply share a header (`continued`); fork and revert belong to the user's prompt. */
export const MessageCard = memo(function MessageCard({ message, continued, onFork, onRevert, onOpenFile }: CardProps) {
  const user = message.info.role === "user";
  const parts = message.parts.map((part, index) => { const node = renderPart(part, onOpenFile); return node === null ? null : <div key={part.id ?? index}>{node}</div>; }).filter(Boolean);
  return <article className={`message ${user ? "user" : "assistant"}${continued ? " continued" : ""}`} data-message-id={message.info.id}>
    {!continued && <header><strong>{user ? "나" : message.info.agent ?? "OpenCode"}</strong><time>{time(message)}</time>
      {user && <span className="message-actions"><button onClick={() => onFork(message.info.id)}>여기서 분기</button><button onClick={() => onRevert(message.info.id)}>이전으로 되돌리기</button></span>}</header>}
    {parts}
    {message.info.error && <p className="error" role="alert">{message.info.error.data?.message ?? message.info.error.message ?? message.info.error.name}</p>}
  </article>;
});
