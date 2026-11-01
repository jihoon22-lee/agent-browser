import { doctorRows } from "../src/options/DoctorChecks";

const result = { ok: false, checks: [
  { id: "bridge", status: "ok", message: "Authenticated Bridge 0.3.1 · 127.0.0.1:4317" },
  { id: "extension", status: "ok", message: "Selected Chrome profile is authenticated and connected" },
  { id: "executable", profileId: "work", status: "error", message: "The configured OpenCode executable or working directory does not exist" },
  { id: "opencode", profileId: "work", status: "error", message: "OpenCode HTTP and browser MCP did not become ready within 60 seconds. Check the executable/version, port, WSL localhost forwarding, directory, and environment." },
  { id: "mcp", profileId: "work", status: "warning", message: "MCP was not checked because OpenCode is not ready; doctor does not start it" },
  { id: "model", profileId: "work", status: "warning", message: "Configured model metadata was read; inference is untested and delegated to the user after deployment", providerCount: 1, modelCount: 3, inferenceTested: false },
] };

it("turns doctor checks into Korean rows that keep the original message", () => {
  const rows = doctorRows(result, [{ id: "work", name: "업무 WSL" }]);
  expect(rows.map(row => [row.label, row.status])).toEqual([
    ["Bridge", "ok"], ["Chrome 연결", "ok"], ["OpenCode 실행 파일 · 업무 WSL", "error"],
    ["OpenCode 서버 · 업무 WSL", "error"], ["브라우저 MCP · 업무 WSL", "warning"], ["모델 정보 · 업무 WSL", "info"],
  ]);
  expect(rows[3]!.summary).toContain("60초 안에 준비되지 않았습니다");
  expect(rows[3]!.detail).toContain("did not become ready");
  expect(rows[4]!.summary).toContain("확인하지 않았습니다");
  expect(rows[5]!.summary).toContain("3개");
  for (const row of rows) expect(row.summary).toMatch(/[가-힣]/);
});

it("keeps the Bridge's view of which Chrome profile is selected", () => {
  const unselected = { ok: true, checks: [{ id: "extension", status: "warning", message: "Select an authenticated, connected Chrome profile" }] };
  expect(doctorRows(unselected, [])[0]).toMatchObject({ label: "Chrome 연결", status: "warning" });
  expect(doctorRows(unselected, [])[0]!.summary).toContain("선택되지 않았습니다");
});
