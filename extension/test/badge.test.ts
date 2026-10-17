import { badgeFor } from "../src/background/badge";

it("shows work, a hand-over and a needed answer in that priority", () => {
  const op = { clientId: "me" };
  expect(badgeFor({ operation: null, clientId: "me", waiting: false }).text).toBe("");
  expect(badgeFor({ operation: op, clientId: "me", waiting: false }).text).toBe("●");
  expect(badgeFor({ operation: { ...op, paused: true }, clientId: "me", waiting: false }).text).toBe("‖");
  expect(badgeFor({ operation: op, clientId: "me", waiting: true }).text).toBe("!");
  expect(badgeFor({ operation: op, clientId: "me", waiting: true }).title).toContain("응답이 필요");
});

it("badge_ignores_another_browsers_operation", () => {
  expect(badgeFor({ operation: { clientId: "other" }, clientId: "me", waiting: false }).text).toBe("");
});
