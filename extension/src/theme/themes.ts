import { useEffect, useState } from "react";
import palette from "./catppuccin-palette.json";

export const THEMES = ["latte", "frappe", "macchiato", "mocha"] as const;
export type Theme = typeof THEMES[number];
export type ThemePreference = "system" | Theme;
export const themeNames: Record<ThemePreference, string> = { system: "시스템 설정", latte: "Latte · 밝은 테마", frappe: "Frappé · 부드러운 다크", macchiato: "Macchiato · 깊은 다크", mocha: "Mocha · 짙은 다크" };
const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
function luminance(hex: string) { return rgb(hex).map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index]!, 0); }
function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
function mix(a: string, b: string, amount: number) { const end = rgb(b); return "#" + rgb(a).map((value, index) => Math.round(value + (end[index]! - value) * amount).toString(16).padStart(2, "0")).join(""); }
// Palette accents are not automatically suitable for small text on every surface.
// Derive semantic colors toward the palette's text color until every used pair passes.
function readable(color: string, text: string, backgrounds: string[], minimum: number) {
  for (let step = 0; step <= 100; step++) { const next = mix(color, text, step / 100); if (backgrounds.every(background => contrast(next, background) >= minimum)) return next; }
  return text;
}
export function themeTokens(theme: Theme) {
  const flavor = palette[theme], colors = flavor.colors;
  const base = colors.base.hex, canvas = colors.mantle.hex, raised = flavor.dark ? colors.surface0.hex : colors.base.hex, hover = flavor.dark ? colors.surface0.hex : colors.crust.hex;
  const backgrounds = [base, canvas, raised, hover], text = colors.text.hex;
  const accent = readable(colors.blue.hex, text, backgrounds, 4.5), danger = readable(colors.red.hex, text, backgrounds, 4.5);
  return {
    "--base": base, "--canvas": canvas, "--surface": base, "--raised": raised, "--hover": hover,
    "--text": text, "--muted": readable(colors.subtext1.hex, text, backgrounds, 4.5),
    "--line": colors.surface1.hex, "--control-border": readable(colors.overlay2.hex, text, backgrounds, 3),
    "--accent": accent, "--accent-on": flavor.dark ? colors.crust.hex : base,
    "--danger": danger, "--danger-on": flavor.dark ? colors.crust.hex : base,
    "--success": readable(colors.green.hex, text, backgrounds, 4.5),
    "--focus": readable(colors.mauve.hex, text, backgrounds, 3),
  };
}
export function normalizeTheme(value: unknown): ThemePreference {
  if (value === "light") return "latte";
  if (value === "dark") return "mocha";
  return value === "system" || THEMES.includes(value as Theme) ? value as ThemePreference : "system";
}
export function applyTheme(preference: ThemePreference, dark: boolean) {
  const resolved = preference === "system" ? dark ? "mocha" : "latte" : preference;
  const root = document.documentElement;
  root.dataset.theme = preference; root.dataset.resolvedTheme = resolved;
  root.style.colorScheme = palette[resolved].dark ? "dark" : "light";
  for (const [name, value] of Object.entries(themeTokens(resolved))) root.style.setProperty(name, value);
}
export function useTheme() {
  const [theme, setTheme] = useState<ThemePreference>("system");
  useEffect(() => {
    let active = true;
    void chrome.storage.local.get("theme").then(saved => { if (active) setTheme(normalizeTheme(saved.theme)); }).catch(() => {});
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === "local" && changes.theme) setTheme(normalizeTheme(changes.theme.newValue)); };
    chrome.storage.onChanged?.addListener(changed);
    return () => { active = false; chrome.storage.onChanged?.removeListener(changed); };
  }, []);
  useEffect(() => {
    const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
    const update = () => applyTheme(theme, media?.matches ?? false);
    update(); media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, [theme]);
  const chooseTheme = (value: string) => { const next = normalizeTheme(value); setTheme(next); void chrome.storage.local.set({ theme: next }); };
  return { theme, chooseTheme };
}
