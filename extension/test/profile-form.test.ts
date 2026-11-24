import { passwordDropped } from "../src/options/profile-form";

it("tells the user when a changed server address dropped the saved password", () => {
  const original = { kind: "external", baseUrl: "https://a.example/", hasPassword: true };
  expect(passwordDropped(original, { kind: "external", baseUrl: "https://b.example/" })).toBe(true);
  expect(passwordDropped(original, { kind: "external", baseUrl: "https://a.example/" })).toBe(false);
  expect(passwordDropped(original, { kind: "external", baseUrl: "https://b.example/", password: "new" })).toBe(false);
  expect(passwordDropped(undefined, { kind: "external", baseUrl: "https://b.example/" })).toBe(false);
});

it("warns when only the username changes, as the Bridge drops the password then", () => {
  expect(passwordDropped({ kind: "external", baseUrl: "http://a", username: "u1", hasPassword: true },
    { kind: "external", baseUrl: "http://a", username: "u2" })).toBe(true);
  expect(passwordDropped({ kind: "external", baseUrl: "http://a", username: "u1", hasPassword: true },
    { kind: "external", baseUrl: "http://a", username: "u1" })).toBe(false);
});

it("editing a profile without a username keeps it empty instead of the new-profile default", async () => {
  const { formFromProfile } = await import("../src/options/profile-form");
  const blank = { username: "opencode", password: "", envText: "", port: "" };
  expect(formFromProfile(blank, { id: "x", kind: "external", baseUrl: "http://a" }).username).toBe("");
  expect(formFromProfile(blank, { id: "x", kind: "external", username: "u1", port: 4100 })).toMatchObject({ username: "u1", port: "4100", password: "" });
});
it("notices the saved password is dropped when an external profile becomes another kind", () => {
  const original = { kind: "external", baseUrl: "https://a.example/", hasPassword: true };
  expect(passwordDropped(original, { kind: "windows", executable: "C:\\o\\opencode.exe" })).toBe(true);
  expect(passwordDropped({ kind: "windows" }, { kind: "external", baseUrl: "https://a.example/" })).toBe(false);
});
it("drops hidden fields from other kinds and requires WSL distribution", async () => {
  const { profilePayload } = await import("../src/options/profile-form");
  const win = profilePayload({ id: "p1", name: "Win", kind: "windows", directory: "C:\\work", executable: "C:\\opencode.exe", distribution: "Ubuntu", user: "dev", baseUrl: "http://127.0.0.1:4096" });
  expect(win.distribution).toBeUndefined();
  expect(win.user).toBeUndefined();
  expect(win.baseUrl).toBeUndefined();
  const ext = profilePayload({ id: "p2", name: "Ext", kind: "external", directory: "/work", executable: "/bin/opencode", baseUrl: "http://127.0.0.1:4096" });
  expect(ext.executable).toBeUndefined();
  expect(() => profilePayload({ id: "p3", name: "WSL", kind: "wsl", directory: "/work", executable: "/bin/opencode", distribution: "" })).toThrow(/배포판/);
});
