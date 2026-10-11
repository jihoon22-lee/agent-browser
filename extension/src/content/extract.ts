import { ProtocolError } from "../protocol/errors";
import { pageText, sliceText } from "./snapshot";
import { resolveRef } from "./refs";

const cellText = (c: Element) => (c.textContent ?? "").replace(/\s+/g, " ").trim();

export function tableToRows(table: HTMLTableElement) {
  const grid: string[][] = [];
  let header: string[] | null = null;
  [...table.rows].forEach((tr, r) => {
    const row: string[] = [];
    for (const cell of [...tr.cells]) for (let i = 0; i < Math.max(1, cell.colSpan); i++) row.push(cellText(cell));
    if (r === 0 && [...tr.cells].every((c) => c.tagName === "TH")) header = row; else grid.push(row);
  });
  const colCount = Math.max(header ? (header as string[]).length : 0, ...grid.map((r) => r.length));
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const head = header ?? Array.from({ length: colCount }, (_, i) => `열${i + 1}`);
  const markdown = [`| ${head.map(esc).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...grid.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
  return { header, rows: grid, rowCount: grid.length, colCount, markdown };
}

export async function extract(p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const maxChars = Number(p.maxChars ?? 8000), offset = Number(p.offset ?? 0);
  switch (p.kind) {
    case "text": return { executed: false, verified: {}, text: sliceText(pageText(document), offset, maxChars) };
    case "selection": {
      const s = getSelection()?.toString() ?? "";
      if (!s) throw new ProtocolError("ELEMENT_NOT_FOUND", "No text is selected in the page.");
      return { executed: false, verified: {}, text: sliceText(s, offset, maxChars) };
    }
    case "table": {
      const el = p.ref ? resolveRef(String(p.ref)) : document.querySelector("table");
      const table = el instanceof HTMLTableElement ? el : el?.closest("table");
      if (!table) throw new ProtocolError("ELEMENT_NOT_FOUND", "No table found. Use browser_snapshot to find one, or extract text.");
      return { executed: false, verified: {}, ...tableToRows(table) };
    }
    default: throw new ProtocolError("INVALID_PARAMS", "kind must be text, selection or table");
  }
}
