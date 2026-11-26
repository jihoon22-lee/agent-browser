import type { ProcessableMessage } from "@a2ui/web_core";

export const AGENT_BROWSER_CATALOG_ID = "https://agent-browser.local/catalogs/v1";
const MAX_PAYLOAD_BYTES = 120_000;
const MAX_COMPONENTS_PER_SURFACE = 120;

export type ParsedA2uiPayload =
  | { ok: true; messages: ProcessableMessage[]; warnings: string[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return true;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Sanitizes untrusted A2UI components before they reach MessageProcessor:
 * - Blocks obscured/password TextFields to mitigate web prompt-injection phishing.
 * - Blocks non-HTTP(S) media/link URLs (javascript:, file:, data:text/html, chrome:).
 * - Enforces component count limits per surface.
 */
function sanitizeComponents(components: unknown[], warnings: string[]): unknown[] {
  if (components.length > MAX_COMPONENTS_PER_SURFACE) {
    warnings.push(`컴포넌트 수가 상한(${MAX_COMPONENTS_PER_SURFACE}개)을 넘어 일부를 생략했습니다.`);
  }
  return components.slice(0, MAX_COMPONENTS_PER_SURFACE).map(item => {
    if (!isRecord(item)) return item;
    const copy: Record<string, unknown> = { ...item };

    // Anti-phishing guardrail: never allow obscured/password fields in AI-generated UI.
    if (copy.component === "TextField") {
      if (copy.variant === "obscured" || copy.type === "password") {
        copy.variant = "shortText";
        delete copy.type;
        warnings.push("보안 정책에 따라 비밀번호 입력 형식은 일반 텍스트 입력으로 전환되었습니다.");
      }
    }

    // Block unsafe URLs on Image / TabLink / media components.
    if (typeof copy.url === "string" && !isSafeUrl(copy.url)) {
      delete copy.url;
      warnings.push("안전하지 않은 URL 속성을 제거했습니다.");
    }
    if (isRecord(copy.url) && typeof copy.url.literalString === "string" && !isSafeUrl(copy.url.literalString)) {
      delete copy.url;
      warnings.push("안전하지 않은 URL 속성을 제거했습니다.");
    }

    return copy;
  });
}

function normalizeMessage(raw: unknown, index: number, warnings: string[]): ProcessableMessage | null {
  if (!isRecord(raw)) return null;
  const msg: Record<string, unknown> = { ...raw };

  // Support shorthand or omitted version by defaulting to v1.0 for v1/v0.9 envelope keys.
  const hasEnvelope =
    "createSurface" in msg ||
    "updateComponents" in msg ||
    "updateDataModel" in msg ||
    "deleteSurface" in msg;
  if (!hasEnvelope) return null;

  if (typeof msg.version !== "string") {
    msg.version = "1.0";
  }

  if (isRecord(msg.createSurface)) {
    const cs: Record<string, unknown> = { ...msg.createSurface };
    if (typeof cs.surfaceId !== "string" || !cs.surfaceId.trim()) {
      cs.surfaceId = `surface_${index}`;
    }
    if (typeof cs.catalogId !== "string" || !cs.catalogId.trim()) {
      cs.catalogId = AGENT_BROWSER_CATALOG_ID;
    }
    if (Array.isArray(cs.components)) {
      cs.components = sanitizeComponents(cs.components, warnings);
    }
    msg.createSurface = cs;
  }

  if (isRecord(msg.updateComponents)) {
    const uc: Record<string, unknown> = { ...msg.updateComponents };
    if (Array.isArray(uc.components)) {
      uc.components = sanitizeComponents(uc.components, warnings);
    }
    msg.updateComponents = uc;
  }

  return msg as unknown as ProcessableMessage;
}

/**
 * Parses an A2UI code block payload. Accepts:
 * 1. A single JSON message object (`{"version":"1.0","createSurface":{...}}`)
 * 2. A JSON array of messages (`[{...}, {...}]`)
 * 3. JSONL (one JSON message per non-empty line)
 */
export function parseA2uiBlock(raw: string): ParsedA2uiPayload {
  const text = raw.trim();
  if (!text) return { ok: false, error: "빈 A2UI 페이로드입니다." };
  if (text.length > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: `A2UI 페이로드가 최대 크기(${MAX_PAYLOAD_BYTES.toLocaleString()}자)를 초과했습니다.` };
  }

  const warnings: string[] = [];
  let items: unknown[] = [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) items = parsed;
    else if (isRecord(parsed) && Array.isArray(parsed.messages)) items = parsed.messages;
    else items = [parsed];
  } catch {
    // Fallback to JSONL: one JSON object per line.
    const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
    const parsedLines: unknown[] = [];
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line));
      } catch (err) {
        return { ok: false, error: `A2UI JSON 파싱 오류: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    items = parsedLines;
  }

  const messages: ProcessableMessage[] = [];
  for (let i = 0; i < items.length; i++) {
    const normalized = normalizeMessage(items[i], i, warnings);
    if (normalized) messages.push(normalized);
  }

  if (!messages.length) {
    return { ok: false, error: "유효한 A2UI 메시지(createSurface / updateComponents / updateDataModel)가 없습니다." };
  }

  return { ok: true, messages, warnings: [...new Set(warnings)] };
}
