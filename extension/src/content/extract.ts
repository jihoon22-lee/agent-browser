import { ProtocolError } from "../protocol/errors";
import { pageText, sliceText, utf8Bytes } from "./snapshot";

export const EXTRACT_BYTES = 28_000;
function boundedSlice(full: string, offset: number, maxChars: number) {
  let slice = sliceText(full, offset, maxChars);
  while (utf8Bytes(JSON.stringify(slice)) > EXTRACT_BYTES && slice.returnedChars > 1) slice = sliceText(full, offset, Math.floor(slice.returnedChars * 0.8));
  return slice;
}
import { resolveRef } from "./refs";

const cellText = (c: Element) => (c.textContent ?? "").replace(/\s+/g, " ").trim();

function tableGrid(table: HTMLTableElement) {
  const source = [...table.rows], grid: string[][] = [];
  const groupEnds: number[] = [];
  for (let start = 0; start < source.length;) {
    let end = start + 1;
    while (end < source.length && source[end]!.parentElement === source[start]!.parentElement) end++;
    for (let row = start; row < end; row++) groupEnds[row] = end;
    start = end;
  }
  let cells = 0;
  for (let r = 0; r < source.length; r++) {
    const tr = source[r]!, row = grid[r] ?? (grid[r] = []);
    let column = 0;
    const groupEnd = groupEnds[r]!;
    for (const cell of [...tr.cells]) {
      const width = Math.max(1, cell.colSpan);
      const height = cell.rowSpan === 0 ? groupEnd - r : Math.min(Math.max(1, cell.rowSpan), groupEnd - r);
      while (Array.from({ length: width }, (_, dx) => row[column + dx]).some(value => value !== undefined)) column++;
      if (cells + width * height > 100000) throw new ProtocolError("INVALID_PARAMS", "This table is too large for structured extraction. Extract page text instead.");
      const text = cellText(cell);
      for (let dy = 0; dy < height; dy++) {
        const target = grid[r + dy] ?? (grid[r + dy] = []);
        for (let dx = 0; dx < width; dx++) { target[column + dx] = text; cells++; }
      }
      column += width;
    }
  }
  const colCount = grid.reduce((max, row) => Math.max(max, row.length), 0);
  if (grid.length * colCount > 100000) throw new ProtocolError("INVALID_PARAMS", "This sparse table is too large for structured extraction. Extract page text instead.");
  const normalized = grid.map(row => Array.from({ length: colCount }, (_, col) => row[col] ?? ""));
  const first = source[0];
  const hasHeader = !!first?.cells.length && [...first.cells].every(cell => cell.tagName === "TH");
  const header = hasHeader ? normalized.shift()! : null;
  return { header, rows: normalized, rowCount: normalized.length, colCount };
}

function markdownTable(header: string[] | null, rows: string[][], columns: number) {
  if (!columns) return "";
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const head = header ?? Array.from({ length: columns }, (_, i) => `열${i + 1}`);
  return [`| ${head.map(esc).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map(row => `| ${row.map(esc).join(" | ")} |`)].join("\n");
}

export function tableToRows(table: HTMLTableElement) {
  const result = tableGrid(table);
  return { ...result, markdown: markdownTable(result.header, result.rows, result.colCount) };
}

function tablePage(table: HTMLTableElement, maxChars: number, offset: number) {
  const full = tableGrid(table), limits = new Set<string>();
  const columns = Math.min(full.colCount, Math.max(1, Math.floor((maxChars - 80) / 24)));
  if (columns < full.colCount) limits.add("table-columns-truncated");
  const header = full.header?.slice(0, columns) ?? null;
  const rows: string[][] = [];
  const payload = (candidate: string[][]) => ({ header, rows: candidate, markdown: markdownTable(header, candidate, columns) });
  const fits = (candidate: string[][]) => { const text = JSON.stringify(payload(candidate)); return text.length <= maxChars && utf8Bytes(text) <= EXTRACT_BYTES; };
  const shorten = (candidate: string[][]) => {
    const groups = [...(header ? [header] : []), ...candidate];
    let longest: { row: string[]; index: number; length: number } | undefined;
    for (const row of groups) row.forEach((value, index) => { if (value.length > (longest?.length ?? 0)) longest = { row, index, length: value.length }; });
    if (!longest) return false;
    longest.row[longest.index] = longest.row[longest.index]!.slice(0, Math.floor(longest.length / 2));
    limits.add("table-cells-truncated");
    return true;
  };
  // Reserve room for at least one data row even when the heading is enormous.
  while (JSON.stringify(payload([])).length > maxChars / 2 && shorten([])) { /* bounded header */ }
  for (let index = offset; index < full.rows.length; index++) {
    const row = full.rows[index]!.slice(0, columns), candidate = [...rows, row];
    if (fits(candidate)) { rows.push(row); continue; }
    if (rows.length) break;
    while (!fits(candidate) && shorten(candidate)) { /* a giant first row still advances the cursor */ }
    rows.push(row);
    break;
  }
  const next = offset + rows.length, nextOffset = next < full.rowCount ? next : null;
  return { ...payload(rows), rowCount: full.rowCount, colCount: full.colCount, offset, nextOffset,
    rowsTotal: full.rowCount, rowsReturned: rows.length, columnsReturned: columns,
    truncated: nextOffset !== null || limits.size > 0, limits: [...limits] };
}

export async function extract(p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const maxChars = Math.max(200, Math.min(50000, Number(p.maxChars ?? 8000))), offset = Math.max(0, Math.floor(Number(p.offset ?? 0)));
  switch (p.kind) {
    case "text": return { executed: false, verified: {}, text: boundedSlice(pageText(document), offset, maxChars) };
    case "selection": {
      const s = getSelection()?.toString() ?? "";
      if (!s) throw new ProtocolError("ELEMENT_NOT_FOUND", "No text is selected in the page.");
      return { executed: false, verified: {}, text: boundedSlice(s, offset, maxChars) };
    }
    case "table": {
      const el = p.ref ? resolveRef(String(p.ref)) : document.querySelector("table");
      const table = el instanceof HTMLTableElement ? el : el?.closest("table");
      if (!table) throw new ProtocolError("ELEMENT_NOT_FOUND", "No table found. Use browser_snapshot to find one, or extract text.");
      return { executed: false, verified: {}, ...tablePage(table, maxChars, offset) };
    }
    default: throw new ProtocolError("INVALID_PARAMS", "kind must be text, selection or table");
  }
}
