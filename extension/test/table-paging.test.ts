import { extract, tableToRows } from "../src/content/extract";
import { takeSnapshot } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";
beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });
it("expands rowspan and colspan without shifting following row cells", () => {
  document.body.innerHTML = `<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td rowspan='2'>shared</td><td colspan='2'>wide</td></tr><tr><td>b</td><td>c</td></tr></tbody></table>`;
  expect(tableToRows(document.querySelector("table")!)).toMatchObject({ header: ["A", "B", "C"], rows: [["shared", "wide", "wide"], ["shared", "b", "c"]], colCount: 3, rowCount: 2 });
});
it("rowspan0 extends only through its row group", () => {
  document.body.innerHTML = "<table><tbody><tr><td rowspan='0'>group</td><td>a</td></tr><tr><td>b</td></tr></tbody><tbody><tr><td>x</td><td>y</td></tr></tbody></table>";
  expect(tableToRows(document.querySelector("table")!).rows).toEqual([["group", "a"], ["group", "b"], ["x", "y"]]);
});
it("extracts the second plain table by its snapshot ref", async () => {
  document.body.innerHTML = "<table><tr><td>first</td></tr></table><table><tr><td>second</td></tr></table>";
  const snap = takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 500, offset: 0, checkLayout: false });
  expect(snap.elements).toHaveLength(2);
  expect(await extract({ kind: "table", ref: snap.elements[1]!.ref })).toMatchObject({ rows: [["second"]] });
});
it("uses offset as a row cursor and bounds each returned page", async () => {
  document.body.innerHTML = `<table><tr><th>id</th><th>value</th></tr>${Array.from({ length: 50 }, (_, i) => `<tr><td>${i}</td><td>${"value ".repeat(10)}</td></tr>`).join("")}</table>`;
  const seen: string[] = []; let offset = 0;
  do {
    const page = await extract({ kind: "table", maxChars: 200, offset });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(850);
    const rows = page.rows as string[][]; expect(rows.length).toBeGreaterThan(0); seen.push(...rows.map(row => row[0]!));
    expect(page.rowCount).toBe(50); expect(page.rowsTotal).toBe(50);
    if (page.nextOffset === null) break;
    expect(Number(page.nextOffset)).toBeGreaterThan(offset); offset = Number(page.nextOffset);
  } while (offset < 50);
  expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
});
it("bounds a giant header and cell while advancing to the next row", async () => {
  document.body.innerHTML = `<table><tr><th>${"h".repeat(200000)}</th></tr><tr><td>${"x".repeat(500000)}</td></tr><tr><td>next</td></tr></table>`;
  const page = await extract({ kind: "table", maxChars: 200, offset: 0 });
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(850);
  expect(page.nextOffset).toBe(1); expect(page.limits).toContain("table-cells-truncated");
  expect(await extract({ kind: "table", maxChars: 200, offset: 1 })).toMatchObject({ rows: [["next"]], nextOffset: null });
});

it("bounds the actual table payload even when many columns cannot fit", async () => {
  document.body.innerHTML = `<table><tr>${Array.from({ length: 100 }, (_, i) => `<th>column${i}</th>`).join("")}</tr><tr>${Array.from({ length: 100 }, (_, i) => `<td>value${i}</td>`).join("")}</tr></table>`;
  const page = await extract({ kind: "table", maxChars: 200 });
  expect(JSON.stringify({ header: page.header, rows: page.rows, markdown: page.markdown }).length).toBeLessThanOrEqual(200);
  expect(page.rowsReturned).toBe(1); expect(page.limits).toContain("table-columns-truncated");
});
