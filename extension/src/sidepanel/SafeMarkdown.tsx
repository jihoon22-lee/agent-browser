import { Fragment, memo, useMemo, type ReactNode } from "react";
import { CopyButton } from "./CopyButton";
export function safeLink(url: string): string | undefined {
  try { const parsed = new URL(url); return ["https:", "http:", "mailto:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; }
}
function inline(text: string, depth = 0): ReactNode[] {
  if (depth > 4) return [text];
  const result: ReactNode[] = [];
  // Supports inline code, bold (allowing nested inline like `code` or *em*), italic, and links/images with balanced 1-level parentheses in URLs.
  const pattern = /(`[^`]+`|\*\*(?:[^*]|(?:\*(?!\*)))+\*\*|\*(?!\s)(?:[^*]|\\\*)+(?<!\s)\*|!?\[[^\]]+\]\((?:[^\s()]+|\([^\s()]*\))+\))/g;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const idx = match.index!;
    if (idx > from) result.push(text.slice(from, idx));
    const raw = match[0];
    if (raw.startsWith("`")) result.push(<code key={idx}>{raw.slice(1, -1)}</code>);
    else if (raw.startsWith("**")) result.push(<strong key={idx}>{inline(raw.slice(2, -2), depth + 1)}</strong>);
    else if (raw.startsWith("*")) result.push(<em key={idx}>{inline(raw.slice(1, -1), depth + 1)}</em>);
    else {
      const isImage = raw.startsWith("!");
      const link = /^!?\[([^\]]+)\]\((.+)\)$/.exec(raw);
      if (link) {
        const href = safeLink(link[2]!);
        if (isImage) result.push(href ? <a key={idx} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a> : link[1]);
        else result.push(href ? <a key={idx} href={href} target="_blank" rel="noopener noreferrer">{inline(link[1]!, depth + 1)}</a> : inline(link[1]!, depth + 1));
      } else result.push(raw);
    }
    from = idx + raw.length;
  }
  if (from < text.length) result.push(text.slice(from));
  return result;
}
function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll("\\|", "|"));
}
function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{1,}:?$/.test(cell));
}
export const SafeMarkdown = memo(function SafeMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.replaceAll("\r\n", "\n").split("\n"), out: ReactNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("```")) {
        const start = i;
        const code: string[] = [], language = line.slice(3).trim();
        while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
        out.push(<div className="code-block" key={`code-${start}`}><div><span>{language}</span><CopyButton text={code.join("\n")} label="코드 복사" /></div><pre><code>{code.join("\n")}</code></pre></div>); continue;
      }
      if (!line.trim()) continue;
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { const level = heading[1]!.length; out.push(level === 1 ? <h1 key={i}>{inline(heading[2]!)}</h1> : level === 2 ? <h2 key={i}>{inline(heading[2]!)}</h2> : <h3 key={i}>{inline(heading[2]!)}</h3>); continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const start = i, ordered = /^\s*\d+\.\s+/.test(line), items: ReactNode[] = [];
        const matcher = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
        do { items.push(<li key={i}>{inline(lines[i]!.replace(matcher, ""))}</li>); i++; } while (i < lines.length && matcher.test(lines[i]!)); i--;
        out.push(ordered ? <ol key={`ol-${start}`}>{items}</ol> : <ul key={`ul-${start}`}>{items}</ul>); continue;
      }
      if (line.trimStart().startsWith("|") && i + 1 < lines.length && lines[i + 1]!.trimStart().startsWith("|") && isTableSeparator(lines[i + 1]!)) {
        const start = i, rows: string[][] = [parseTableRow(line)];
        i += 2;
        while (i < lines.length && lines[i]!.trimStart().startsWith("|")) { rows.push(parseTableRow(lines[i]!)); i++; }
        i--;
        out.push(<div className="table-scroll" key={`tbl-${start}`}><table><thead><tr>{rows[0]!.map((cell, c) => <th key={c}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue;
      }
      if (/^>\s?/.test(line)) {
        const start = i, quoted: string[] = [];
        do { quoted.push(lines[i]!.replace(/^>\s?/, "")); i++; } while (i < lines.length && /^>\s?/.test(lines[i]!)); i--;
        out.push(<blockquote key={`bq-${start}`}>{quoted.map((q, idx) => <Fragment key={idx}>{idx > 0 && <br />}{inline(q)}</Fragment>)}</blockquote>); continue;
      }
      out.push(<p key={i}>{inline(line)}</p>);
    }
    return out;
  }, [text]);
  return <div className="markdown">{blocks}</div>;
});
