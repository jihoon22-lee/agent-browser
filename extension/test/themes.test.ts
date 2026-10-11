import { applyTheme, normalizeTheme, themeTokens, THEMES } from "../src/theme/themes";
function ratio(a: string, b: string) {
  const luminance = (hex: string) => { const c = hex.match(/[0-9a-f]{2}/gi)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : Math.pow((value + .055) / 1.055, 2.4)); return c[0]! * .2126 + c[1]! * .7152 + c[2]! * .0722; };
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y); return (values[1]! + .05) / (values[0]! + .05);
}
it.each(THEMES)("keeps final %s text, focus and control tokens readable on every surface", theme => {
  const tokens = themeTokens(theme);
  for (const background of ["--base", "--canvas", "--raised", "--hover", "--bubble"] as const) {
    for (const foreground of ["--text", "--muted", "--accent", "--danger", "--success"] as const) expect(ratio(tokens[foreground], tokens[background]), `${theme} ${foreground}/${background}`).toBeGreaterThanOrEqual(4.5);
    for (const foreground of ["--control-border", "--focus"] as const) expect(ratio(tokens[foreground], tokens[background]), `${theme} ${foreground}/${background}`).toBeGreaterThanOrEqual(3);
  }
  expect(ratio(tokens["--accent-on"], tokens["--accent"])).toBeGreaterThanOrEqual(4.5);
  expect(ratio(tokens["--danger-on"], tokens["--danger"])).toBeGreaterThanOrEqual(4.5);
});
it("migrates saved light/dark preferences and follows system appearance only in system mode", () => {
  expect(normalizeTheme("light")).toBe("latte"); expect(normalizeTheme("dark")).toBe("mocha"); expect(normalizeTheme("unknown")).toBe("system");
  applyTheme("system", true); expect(document.documentElement.dataset.resolvedTheme).toBe("mocha");
  applyTheme("system", false); expect(document.documentElement.dataset.resolvedTheme).toBe("latte");
  applyTheme("frappe", false); expect(document.documentElement.dataset.resolvedTheme).toBe("frappe");
});
