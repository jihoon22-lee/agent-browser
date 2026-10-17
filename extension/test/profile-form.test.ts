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
