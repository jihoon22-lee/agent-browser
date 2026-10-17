import manifest from "../public/manifest.json";

it("asks for the debugger permission and offers tab groups only as optional", () => {
  expect(manifest.permissions).toContain("debugger");
  expect(manifest.optional_permissions).toContain("tabGroups");
  expect(manifest.permissions).not.toContain("tabGroups");
});
