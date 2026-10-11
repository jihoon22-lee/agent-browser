import { Fragment, type ReactNode } from "react";
export function safeLink(url: string): string | undefined {
  try { const parsed = new URL(url); return ["https:", "http:", "mailto:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; }
}
function inline(text: string): ReactNode[] {
  const result: ReactNode[] = [], pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    result.push(text.slice(from, match.index)); const raw = match[0];
    if (raw.startsWith("`")) result.push(<code key={match.index}>{raw.slice(1, -1)}</code>);
    else if (raw.startsWith("**")) result.push(<strong key={match.index}>{raw.slice(2, -2)}</strong>);
    else if (raw.startsWith("*")) result.push(<em key={match.index}>{raw.slice(1, -1)}</em>);
    else { const link = /^\[([^\]]+)\]\((.+)\)$/.exec(raw)!; const href = safeLink(link[2]!); result.push(href ? <a key={match.index} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a> : link[1]); }
    from = match.index! + raw.length;
  }
  result.push(text.slice(from)); return result;
}
export function SafeMarkdown({ text }: { text: string }) {
  const lines = text.replaceAll("\r\n", "\n").split("\n"), blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const code: string[] = [], language = line.slice(3); while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
      blocks.push(<div className="code-block" key={i}><div><span>{language}</span><button onClick={() => void navigator.clipboard.writeText(code.join("\n"))}>코드 복사</button></div><pre><code>{code.join("\n")}</code></pre></div>); continue;
    }
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const level = heading[1]!.length; blocks.push(level === 1 ? <h1 key={i}>{inline(heading[2]!)}</h1> : level === 2 ? <h2 key={i}>{inline(heading[2]!)}</h2> : <h3 key={i}>{inline(heading[2]!)}</h3>); continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), items: ReactNode[] = [];
      do { items.push(<li key={i}>{inline(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>); i++; } while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)); i--;
      blocks.push(ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>); continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      do { const row = lines[i]!.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll("\\|", "|")); if (!row.every(cell => /^:?-+:?$/.test(cell))) rows.push(row); i++; } while (i < lines.length && lines[i]!.startsWith("|")); i--;
      blocks.push(<div className="table-scroll" key={i}><table><tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => r === 0 ? <th key={c}>{inline(cell)}</th> : <td key={c}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (line.startsWith("> ")) blocks.push(<blockquote key={i}>{inline(line.slice(2))}</blockquote>);
    else blocks.push(<p key={i}>{inline(line)}</p>);
  }
  return <div className="markdown">{blocks.map((block, i) => <Fragment key={i}>{block}</Fragment>)}</div>;
}
