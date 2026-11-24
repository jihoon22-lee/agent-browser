import { friendlyError } from "./error-text";

/** An error in Korean with its next step; the original Bridge/runtime text stays one click away for support. */
export function ErrorNotice({ message, code, className = "error", onDismiss }: { message: string; code?: string; className?: string; onDismiss?: () => void }) {
  const { text, original } = friendlyError(message, code);
  return <div role="alert" className={className}>{onDismiss && <button type="button" className="quiet error-dismiss" aria-label="오류 닫기" onClick={onDismiss}>×</button>}{text}{original && <details className="error-original"><summary>원문</summary><code>{original}</code></details>}</div>;
}
