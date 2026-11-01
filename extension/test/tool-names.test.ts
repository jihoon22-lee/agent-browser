import { readFileSync } from "node:fs";
import { join } from "node:path";
import { outcomeLabel, toolLabel } from "../src/sidepanel/tool-names";

it("names every browser tool in Korean whatever MCP server prefix OpenCode adds", () => {
  const contract = JSON.parse(readFileSync(join(__dirname, "..", "..", "protocol", "fixtures", "tools-list.json"), "utf8"));
  const tools: Array<{ name: string }> = contract.tools ?? contract.result?.tools ?? contract;
  expect(tools.length).toBeGreaterThan(10);
  for (const { name } of tools) {
    expect(toolLabel(name), name).toMatch(/[가-힣]/);
    expect(toolLabel(`browser_${name}`)).toBe(toolLabel(name));
    expect(toolLabel(`agent-browser_${name}`)).toBe(toolLabel(name));
  }
});

it("keeps unknown tools unnamed so the raw name stays visible", () => {
  expect(toolLabel("custom_lookup")).toBeUndefined();
  expect(toolLabel(undefined)).toBeUndefined();
  expect(toolLabel("bash")).toBe("셸 명령");
});

it("reports timeline outcomes in Korean and keeps error codes", () => {
  expect(outcomeLabel("ok")).toBe("성공");
  expect(outcomeLabel("ELEMENT_NOT_FOUND")).toBe("실패 · ELEMENT_NOT_FOUND");
});
