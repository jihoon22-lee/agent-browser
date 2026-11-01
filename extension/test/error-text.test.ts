import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeUnavailable, friendlyError } from "../src/sidepanel/error-text";

// Each sample is the exact text the Bridge or the extension produces; if a source string changes, the mapping must follow.
const samples: Array<[string, string, string]> = [
  ["../bridge/src/runtime/mod.rs", "OpenCode HTTP and browser MCP did not become ready within 60 seconds. Check the executable/version, port, WSL localhost forwarding, directory, and environment.", "60초 안에 준비되지 않았습니다"],
  ["../bridge/src/runtime/mod.rs", "Cannot launch OpenCode; check the executable, working directory, and environment", "OpenCode를 실행하지 못했습니다"],
  ["../bridge/src/runtime/mod.rs", "OpenCode HTTP is available but browser MCP is not connected; inspect WSL interop and the Bridge executable", "브라우저 MCP가 연결되지 않았습니다"],
  ["../bridge/src/runtime/mod.rs", "OpenCode HTTP is available but browser MCP initialization did not finish", "브라우저 MCP 준비가 끝나지 않았습니다"],
  ["../bridge/src/runtime/mod.rs", "The managed runtime needs its browser MCP configuration refreshed (Bridge endpoint or owned WSL keeper). Stop this profile in Options, then start it again. The existing runtime was left running.", "서버를 중지한 뒤 다시 연결하세요"],
  ["../bridge/src/runtime/mod.rs", "Another operation is already managing this profile; wait for it to finish", "다른 작업이 이 실행 환경을 처리하는 중입니다"],
  ["../bridge/src/runtime/mod.rs", "The requested OpenCode port is already occupied; select another port or an external profile", "다른 프로그램이 사용하고 있습니다"],
  ["../bridge/src/runtime/mod.rs", "Stop the managed runtime before editing its profile", "서버를 중지하세요"],
  ["../bridge/src/runtime/mod.rs", "Unknown runtime profile", "실행 환경을 찾을 수 없습니다"],
  ["src/background/bridge-connection.ts", "Bridge is not connected", "Bridge에 연결되어 있지 않습니다"],
  ["src/background/bridge-connection.ts", "Bridge connection closed", "Bridge에 연결되어 있지 않습니다"],
];

it.each(samples)("explains %s text %j in Korean and keeps the original", (file, message, korean) => {
  expect(readFileSync(join(__dirname, "..", file), "utf8")).toContain(message);
  const shown = friendlyError(message);
  expect(shown.text).toContain(korean);
  expect(shown.original).toBe(message);
});

it("explains a Bridge request timeout for any method", () => {
  expect(readFileSync(join(__dirname, "..", "src/background/bridge-connection.ts"), "utf8")).toContain("`Bridge did not answer ${method}`");
  expect(friendlyError("Bridge did not answer runtime.ensure")).toEqual({ text: "Bridge가 제한 시간 안에 응답하지 않았습니다. 잠시 후 다시 시도하세요.", original: "Bridge did not answer runtime.ensure" });
});

it("explains browser network failures toward OpenCode", () => {
  expect(friendlyError("Failed to fetch").text).toContain("OpenCode 서버에 연결할 수 없습니다");
  expect(friendlyError("signal timed out").text).toContain("제한 시간");
});

it("leaves messages without a known cause unchanged", () => {
  expect(friendlyError("이미 한국어로 된 안내")).toEqual({ text: "이미 한국어로 된 안내" });
  expect(friendlyError("provider quota exceeded")).toEqual({ text: "provider quota exceeded" });
});

it("recognizes the lost-Bridge errors that a reconnect makes stale", () => {
  const source = readFileSync(join(__dirname, "..", "src/background/bridge-connection.ts"), "utf8");
  for (const message of ["Bridge connection closed", "Bridge is not connected"]) { expect(source).toContain(`"${message}"`); expect(bridgeUnavailable(message)).toBe(true); }
  expect(bridgeUnavailable("Bridge did not answer runtime.ensure")).toBe(true);
  expect(bridgeUnavailable("OpenCode HTTP 400: rejected")).toBe(false);
  expect(bridgeUnavailable("Bridge returned an error without details")).toBe(false);
});
