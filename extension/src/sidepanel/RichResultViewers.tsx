import { useEffect, useMemo, useState } from "react";
import { csv, download } from "./workbench-state";
import { TableIcon, ZoomIcon } from "./Icons";

function parseNumericCell(value: string): number {
  const cleaned = value
    .trim()
    .replace(/[,\s]/g, "")
    .replace(/^[₩$€£¥]/, "")
    .replace(/(?:원|건|명|개|회|점|%|초|분)$/, "");
  return cleaned !== "" && /^[+-]?\d+(?:\.\d+)?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

function compareCell(a: string, b: string): number {
  const numA = parseNumericCell(a);
  const numB = parseNumericCell(b);
  if (Number.isFinite(numA) && Number.isFinite(numB)) {
    return numA - numB;
  }
  return a.localeCompare(b, "ko", { numeric: true, sensitivity: "base" });
}

function toMarkdownTable(columns: string[], rows: string[][]): string {
  const escape = (cell: string) => cell.replaceAll("|", "\\|").replaceAll("\n", " ");
  const header = columns.length ? columns : rows[0]?.map((_, idx) => `열 ${idx + 1}`) ?? [];
  if (!header.length) return "";
  const lines = [
    `| ${header.map(escape).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${header.map((_, idx) => escape(row[idx] ?? "")).join(" | ")} |`),
  ];
  return lines.join("\n");
}

export function InteractiveTable({
  title,
  columns,
  rows,
  markdown,
  searchable = true,
  selectable = false,
  actionLabel,
  onRowAction,
}: {
  title?: string;
  columns?: string[];
  rows: string[][];
  markdown?: string;
  searchable?: boolean;
  selectable?: boolean;
  actionLabel?: string;
  onRowAction?: (selectedRows: string[][], columns: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  const normalizedColumns = useMemo(() => {
    if (columns && columns.length) return columns.map(String);
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    return Array.from({ length: width }, (_, i) => `열 ${i + 1}`);
  }, [columns, rows]);

  const indexedRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows
      .map((row, idx) => ({ idx, cells: row.map(cell => String(cell ?? "")) }))
      .filter(({ cells }) => !q || cells.some(cell => cell.toLowerCase().includes(q)));
    if (sortCol === null) return filtered;
    return [...filtered].sort((a, b) => {
      const diff = compareCell(a.cells[sortCol] ?? "", b.cells[sortCol] ?? "");
      return sortDir === "asc" ? diff : -diff;
    });
  }, [rows, query, sortCol, sortDir]);

  const toggleSort = (colIdx: number) => {
    if (sortCol === colIdx) {
      if (sortDir === "asc") setSortDir("desc");
      else { setSortCol(null); setSortDir("asc"); }
    } else {
      setSortCol(colIdx);
      setSortDir("asc");
    }
  };

  const toggleRow = (rowIdx: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(rowIdx)) next.delete(rowIdx);
      else next.add(rowIdx);
      return next;
    });
  };

  const exportRows = selected.size > 0
    ? rows.filter((_, i) => selected.has(i))
    : indexedRows.map(r => r.cells);

  const exportCsv = () => {
    const data = normalizedColumns.length ? [normalizedColumns, ...exportRows] : exportRows;
    download("table.csv", "\uFEFF" + csv(data), "text/csv;charset=utf-8");
  };

  const exportMd = () => {
    const content = selected.size === 0 && !query.trim() && sortCol === null && markdown
      ? markdown
      : toMarkdownTable(normalizedColumns, exportRows);
    download("table.md", content, "text/markdown");
  };

  return (
    <div className="rich-table-card" aria-label={title ? `표 · ${title}` : "인터랙티브 표"}>
      <div className="rich-table-header">
        <span className="rich-table-title">
          <TableIcon size={13} />
          <strong>{title || "추출된 표"}</strong>
          <small>{indexedRows.length}/{rows.length}행</small>
        </span>
        {searchable && rows.length > 2 && (
          <input
            type="search"
            className="rich-table-search"
            aria-label="표 검색"
            placeholder="표 검색…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        )}
      </div>
      <div className="rich-table-scroll">
        <table className="rich-table">
          <thead>
            <tr>
              {selectable && <th className="rich-table-check" scope="col"><span className="sr-only">선택</span></th>}
              {normalizedColumns.map((col, idx) => (
                <th key={idx} scope="col" aria-sort={sortCol === idx ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="rich-table-sort" onClick={() => toggleSort(idx)}>
                    <span>{col}</span>
                    <span className="sort-indicator" aria-hidden="true">
                      {sortCol === idx ? (sortDir === "asc" ? "↑" : "↓") : "⇅"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {indexedRows.length === 0 ? (
              <tr>
                <td colSpan={normalizedColumns.length + (selectable ? 1 : 0)} className="muted">
                  일치하는 행이 없습니다.
                </td>
              </tr>
            ) : (
              indexedRows.map(({ idx, cells }) => (
                <tr key={idx} className={selected.has(idx) ? "selected" : undefined}>
                  {selectable && (
                    <td className="rich-table-check">
                      <input
                        type="checkbox"
                        aria-label={`${idx + 1}행 선택`}
                        checked={selected.has(idx)}
                        onChange={() => toggleRow(idx)}
                      />
                    </td>
                  )}
                  {normalizedColumns.map((_, colIdx) => (
                    <td key={colIdx}>{cells[colIdx] ?? ""}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="toolbar rich-table-actions">
        <button type="button" onClick={exportCsv}>{selected.size ? `선택 ${selected.size}행 CSV` : "표 CSV"}</button>
        <button type="button" onClick={exportMd}>{selected.size ? `선택 ${selected.size}행 Markdown` : "표 Markdown"}</button>
        {selectable && onRowAction && (
          <button
            type="button"
            className="primary"
            disabled={selected.size === 0}
            onClick={() => onRowAction(rows.filter((_, i) => selected.has(i)), normalizedColumns)}
          >
            {actionLabel || `선택한 ${selected.size}행 전달`}
          </button>
        )}
      </div>
    </div>
  );
}

export function ImagePreview({
  src,
  alt,
  downloadName,
}: {
  src: string;
  alt: string;
  downloadName: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="image-thumb-trigger"
        aria-label={`${alt} 크게 보기`}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} />
        <span className="image-zoom-badge" aria-hidden="true">
          <ZoomIcon size={12} /> 확대
        </span>
      </button>
      {open && (
        <div
          className="lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`${alt} 확대 미리보기`}
          onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}
        >
          <div className="lightbox-frame">
            <div className="lightbox-header">
              <strong title={alt}>{alt}</strong>
              <div className="toolbar">
                <a href={src} download={downloadName}>내려받기</a>
                <button type="button" autoFocus onClick={() => setOpen(false)}>닫기</button>
              </div>
            </div>
            <div className="lightbox-body">
              <img src={src} alt={alt} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
