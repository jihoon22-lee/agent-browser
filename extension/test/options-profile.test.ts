import { validatePairing, profilePayload } from "../src/options/profile-form";
it("rejects pairing endpoints that could receive the local control secret remotely", () => {
  expect(() => validatePairing("ws://evil.test/extension", "a".repeat(64))).toThrow();
  expect(() => validatePairing("ws://127.0.0.1:4317/extension?token=x", "a".repeat(64))).toThrow();
  expect(validatePairing("ws://127.0.0.1:4317/extension", "")).toEqual({ bridgeUrl: "ws://127.0.0.1:4317/extension" });
});
it("omits blank secret fields on profile edits so the bridge retains existing values", () => {
  const profile = profilePayload({ id: "native", name: "Windows", kind: "windows", directory: "C:\\work", executable: "C:\\opencode.exe", password: "", envText: "" });
  expect(profile).not.toHaveProperty("password"); expect(profile).not.toHaveProperty("env");
  expect(profile).toMatchObject({ id: "native", kind: "windows", executable: "C:\\opencode.exe" });
});
it("requires explicit string environment values and never silently converts them", () => {
  expect(() => profilePayload({ id: "wsl", name: "WSL", kind: "wsl", directory: "/work", executable: "/usr/bin/opencode", envText: '{"KEY":42}' })).toThrow();
});
it("rejects an external server path prefix unsupported by the v1 client", () => {
  expect(() => profilePayload({ id: "external", name: "External", kind: "external", directory: "/work", baseUrl: "https://server.test/prefix" })).toThrow();
});
