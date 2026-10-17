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
