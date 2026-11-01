import { useEffect, useState } from "react";

/** Copies text and says so on the button for a moment; a refused clipboard write is reported, not ignored. */
export function CopyButton({ text, label = "복사", className }: { text: string; label?: string; className?: string }) {
  const [result, setResult] = useState<"copied" | "failed">();
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), 1500);
    return () => clearTimeout(timer);
  }, [result]);
  return <button type="button" className={className} aria-live="polite" onClick={() => void navigator.clipboard.writeText(text).then(() => setResult("copied"), () => setResult("failed"))}>{result === "copied" ? "복사됨" : result === "failed" ? "복사 실패" : label}</button>;
}
