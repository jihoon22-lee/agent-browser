import { friendlyError } from "./error-text";

/** An error in Korean with its next step; the original Bridge/runtime text stays one click away for support. */
export function ErrorNotice({ message, code, className = "error" }: { message: string; code?: string; className?: string }) {
  const { text, original } = friendlyError(message, code);
  return <div role="alert" className={className}>{text}{original && <details className="error-original"><summary>원문</summary><code>{original}</code></details>}</div>;
}
