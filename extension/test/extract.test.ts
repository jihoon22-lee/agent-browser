import { runAction } from "../src/content/actions";
import { resetRegistry } from "../src/content/refs";

beforeEach(() => { resetRegistry(); });

it("extracts table rows exactly, keeping commas and pipes", async () => {
  document.body.innerHTML = `<table><thead><tr><th>항목</th><th>값</th></tr></thead>
    <tbody><tr><td>가격</td><td>12,000원</td></tr><tr><td>비고</td><td>a | b, c</td></tr></tbody></table>`;
  const r = await runAction("extract", { kind: "table", maxChars: 8000, offset: 0, generation: 1 });
  expect(r).toMatchObject({ header: ["항목", "값"], rows: [["가격", "12,000원"], ["비고", "a | b, c"]], rowCount: 2, colCount: 2 });
  expect((r as { markdown: string }).markdown).toContain("a \\| b, c");
});

it("expands colspan", async () => {
  document.body.innerHTML = `<table><tr><td colspan="2">합계</td></tr><tr><td>1</td><td>2</td></tr></table>`;
  const r = await runAction("extract", { kind: "table", maxChars: 8000, offset: 0, generation: 1 });
  expect((r as { rows: string[][] }).rows[0]).toEqual(["합계", "합계"]);
});

it("selection extract fails clearly when nothing is selected", async () => {
  document.body.innerHTML = `<p>본문</p>`;
  await expect(runAction("extract", { kind: "selection", maxChars: 8000, offset: 0, generation: 1 })).rejects.toMatchObject({ code: "ELEMENT_NOT_FOUND" });
});

it("text extract is sliced by characters", async () => {
  document.body.innerHTML = `<p>${"나".repeat(300)}</p>`;
  const r = await runAction("extract", { kind: "text", maxChars: 200, offset: 0, generation: 1 });
  expect(r).toMatchObject({ text: { returnedChars: 200, truncated: true, nextOffset: 200, totalChars: 300 } });
});
