import { passwordDropped } from "../src/options/profile-form";

it("tells the user when a changed server address dropped the saved password", () => {
  const original = { kind: "external", baseUrl: "https://a.example/", hasPassword: true };
  expect(passwordDropped(original, { kind: "external", baseUrl: "https://b.example/" })).toBe(true);
  expect(passwordDropped(original, { kind: "external", baseUrl: "https://a.example/" })).toBe(false);
  expect(passwordDropped(original, { kind: "external", baseUrl: "https://b.example/", password: "new" })).toBe(false);
  expect(passwordDropped(undefined, { kind: "external", baseUrl: "https://b.example/" })).toBe(false);
});
