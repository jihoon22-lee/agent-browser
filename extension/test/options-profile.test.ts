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
it("trims pasted profile fields but sends the password as typed", () => {
  const profile = profilePayload({ id: "wsl", name: "WSL", kind: "wsl", directory: "/work", executable: " /usr/bin/opencode\t", distribution: " Ubuntu ", user: " dev ", username: " opencode ", password: " secret " });
  expect(profile).toMatchObject({ executable: "/usr/bin/opencode", distribution: "Ubuntu", user: "dev", username: "opencode", password: " secret " });
});
it("explains a malformed address or environment JSON in Korean with an example", () => {
  expect(() => validatePairing("127.0.0.1:4317", "")).toThrow("ws://127.0.0.1:4317/extension");
  expect(() => validatePairing("", "")).toThrow(/Bridge 주소/);
  const external = { id: "external", name: "External", kind: "external", directory: "/work" };
  expect(() => profilePayload({ ...external, baseUrl: "server.test" })).toThrow(/서버 주소.*http:\/\/127\.0\.0\.1:4096/);
  expect(() => profilePayload({ ...external, baseUrl: "" })).toThrow(/서버 주소/);
  const wsl = { id: "wsl", name: "WSL", kind: "wsl", directory: "/work", executable: "/usr/bin/opencode" };
  for (const envText of ["NAME=value", "{NAME:1}", "[1]", "null"]) expect(() => profilePayload({ ...wsl, envText })).toThrow(/환경변수.*\{"NAME":"value"\}/);
  expect(profilePayload({ ...external, baseUrl: " http://127.0.0.1:4096 " }).baseUrl).toBe("http://127.0.0.1:4096/");
});
