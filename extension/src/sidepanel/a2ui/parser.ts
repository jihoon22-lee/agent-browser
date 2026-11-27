import type { ProcessableMessage } from "@a2ui/web_core";

export const AGENT_BROWSER_CATALOG_ID = "https://agent-browser.local/catalogs/v1";
const STANDARD_V1_CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
const V09_BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";

const MAX_PAYLOAD_BYTES = 120_000;
const MAX_COMPONENTS_PER_SURFACE = 120;
const MAX_TABLE_COLUMNS = 30;
const MAX_TABLE_ROWS = 200;
const MAX_KV_ITEMS = 50;
const MAX_CHILDREN = 100;
const MAX_INLINE_DEPTH = 20;

const UAX31_ID_RE = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u;
const UAX31_START_RE = /^[\p{XID_Start}_]/u;

const VALID_TONES = new Set(["neutral", "accent", "ai", "success", "warning", "danger"]);
const TONE_ALIASES: Record<string, string> = {
  default: "neutral",
  gray: "neutral",
  grey: "neutral",
  muted: "neutral",
  secondary: "neutral",
  primary: "accent",
  info: "accent",
  blue: "accent",
  brand: "accent",
  purple: "ai",
  violet: "ai",
  mauve: "ai",
  green: "success",
  ok: "success",
  positive: "success",
  yellow: "warning",
  orange: "warning",
  amber: "warning",
  caution: "warning",
  red: "danger",
  error: "danger",
  destructive: "danger",
  negative: "danger",
};

const VALID_JUSTIFY = new Set(["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"]);
const JUSTIFY_ALIASES: Record<string, string> = {
  "flex-start": "start",
  "flex-end": "end",
  left: "start",
  right: "end",
  "space-between": "spaceBetween",
  "space-around": "spaceAround",
  "space-evenly": "spaceEvenly",
  between: "spaceBetween",
  around: "spaceAround",
  evenly: "spaceEvenly",
};

const VALID_ALIGN = new Set(["start", "center", "end", "stretch"]);
const ALIGN_ALIASES: Record<string, string> = {
  "flex-start": "start",
  "flex-end": "end",
  top: "start",
  bottom: "end",
  left: "start",
  right: "end",
  middle: "center",
};

const VALID_ICON_NAMES = new Set([
  "accountCircle", "add", "arrowBack", "arrowForward", "attachFile", "calendarToday", "call",
  "camera", "check", "close", "delete", "download", "edit", "event", "error", "fastForward",
  "favorite", "favoriteOff", "folder", "help", "home", "info", "locationOn", "lock", "lockOpen",
  "mail", "menu", "moreVert", "moreHoriz", "notificationsOff", "notifications", "pause", "payment",
  "person", "phone", "photo", "play", "print", "refresh", "rewind", "search", "send", "settings",
  "share", "shoppingCart", "skipNext", "skipPrevious", "star", "starHalf", "starOff", "stop",
  "upload", "visibility", "visibilityOff", "volumeDown", "volumeMute", "volumeOff", "volumeUp",
  "warning",
]);

const ICON_ALIASES: Record<string, string> = {
  "check-circle": "check",
  checkcircle: "check",
  checkmark: "check",
  alert: "warning",
  "alert-triangle": "warning",
  "alert-circle": "error",
  link: "share",
  "external-link": "share",
  globe: "info",
  sparkles: "star",
  sparkle: "star",
  trash: "delete",
  plus: "add",
  x: "close",
  user: "person",
  chart: "info",
  table: "menu",
  clock: "event",
  calendar: "calendarToday",
  file: "folder",
};

const COMPONENT_TYPE_ALIASES: Record<string, { target: string; preset?: Record<string, unknown> }> = {
  heading: { target: "Text", preset: { _headingPrefix: "### " } },
  header: { target: "Text", preset: { _headingPrefix: "### " } },
  title: { target: "Text", preset: { _headingPrefix: "### " } },
  subtitle: { target: "Text", preset: { variant: "caption" } },
  paragraph: { target: "Text" },
  markdown: { target: "Text" },
  label: { target: "Text" },
  vstack: { target: "Column" },
  stack: { target: "Column" },
  container: { target: "Column" },
  box: { target: "Column" },
  section: { target: "Column" },
  group: { target: "Column" },
  div: { target: "Column" },
  form: { target: "Column" },
  hstack: { target: "Row" },
  flex: { target: "Row" },
  grid: { target: "Row" },
  separator: { target: "Divider" },
  spacer: { target: "Divider" },
  hr: { target: "Divider" },
  metric: { target: "StatCard" },
  kpi: { target: "StatCard" },
  kpicard: { target: "StatCard" },
  stat: { target: "StatCard" },
  tag: { target: "Badge" },
  chip: { target: "Badge" },
  pill: { target: "Badge" },
  statusbadge: { target: "Badge" },
  table: { target: "DataTable" },
  keyvaluelist: { target: "KeyValue" },
  metadata: { target: "KeyValue" },
  link: { target: "TabLink" },
  progress: { target: "ProgressBar" },
  input: { target: "TextField" },
  textinput: { target: "TextField" },
  textarea: { target: "TextField", preset: { variant: "longText" } },
  checkbox: { target: "CheckBox" },
  select: { target: "ChoicePicker" },
  radiogroup: { target: "ChoicePicker", preset: { variant: "mutuallyExclusive" } },
  dropdown: { target: "ChoicePicker", preset: { variant: "mutuallyExclusive" } },
};

const CUSTOM_COMPONENT_NAMES = new Set(["StatCard", "Badge", "KeyValue", "DataTable", "TabLink", "ProgressBar"]);
const CHECKABLE_COMPONENTS = new Set(["Button", "TextField", "CheckBox", "ChoicePicker", "Slider", "DateTimeInput"]);
const STRICT_ALLOWED_KEYS: Record<string, Set<string>> = {
  Text: new Set(["text", "variant", "weight"]),
  Image: new Set(["url", "description", "fit", "variant", "weight"]),
  Icon: new Set(["name", "weight"]),
  Row: new Set(["children", "justify", "align", "weight"]),
  Column: new Set(["children", "justify", "align", "weight"]),
  List: new Set(["children", "direction", "align", "weight"]),
  Card: new Set(["child", "weight"]),
  Tabs: new Set(["tabs", "weight"]),
  Modal: new Set(["trigger", "content", "weight"]),
  Divider: new Set(["axis", "weight"]),
  Button: new Set(["child", "variant", "action", "weight", "@checks"]),
  TextField: new Set(["label", "value", "placeholder", "variant", "weight", "@checks"]),
  CheckBox: new Set(["label", "value", "weight", "@checks"]),
  ChoicePicker: new Set(["label", "variant", "options", "value", "displayStyle", "filterable", "weight", "@checks"]),
  Slider: new Set(["label", "min", "max", "value", "steps", "weight", "@checks"]),
  DateTimeInput: new Set(["value", "enableDate", "enableTime", "min", "max", "label", "weight", "@checks"]),
};
const ENVELOPE_KEYS = new Set(["id", "component", "@catalogId", "@accessibility", "@metadata"]);

export type ParsedA2uiPayload =
  | { ok: true; messages: ProcessableMessage[]; warnings: string[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDynamicExpr(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value["@path"] === "string" ||
    typeof value.path === "string" ||
    typeof value["@call"] === "string" ||
    typeof value.call === "string"
  );
}

/** Unwraps A2UI v0.8 literal wrappers (`{ literalString: "x" }` -> `"x"`). */
function unwrapLiteral(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (typeof value.literalString === "string") return value.literalString;
  if (typeof value.literalNumber === "number") return value.literalNumber;
  if (typeof value.literalBoolean === "boolean") return value.literalBoolean;
  if (Array.isArray(value.literalArray)) return value.literalArray;
  return value;
}

function coerceDynamicString(value: unknown, fallback = ""): unknown {
  const unwrapped = unwrapLiteral(value);
  if (typeof unwrapped === "string") return unwrapped;
  if (isDynamicExpr(unwrapped)) return unwrapped;
  if (typeof unwrapped === "number" || typeof unwrapped === "boolean") return String(unwrapped);
  return fallback;
}

function coerceDynamicNumber(value: unknown, fallback: number): unknown {
  const unwrapped = unwrapLiteral(value);
  if (typeof unwrapped === "number" && Number.isFinite(unwrapped)) return unwrapped;
  if (isDynamicExpr(unwrapped)) return unwrapped;
  if (typeof unwrapped === "string" && unwrapped.trim()) {
    const parsed = Number(unwrapped.replace(/[,\s%]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function coerceDynamicBoolean(value: unknown, fallback = false): unknown {
  const unwrapped = unwrapLiteral(value);
  if (typeof unwrapped === "boolean") return unwrapped;
  if (isDynamicExpr(unwrapped)) return unwrapped;
  if (unwrapped === "true" || unwrapped === 1) return true;
  if (unwrapped === "false" || unwrapped === 0) return false;
  return fallback;
}

function normalizeTone(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const lower = raw.trim().toLowerCase();
  if (VALID_TONES.has(lower)) return lower;
  return TONE_ALIASES[lower] ?? "neutral";
}

function normalizeJustify(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (VALID_JUSTIFY.has(trimmed)) return trimmed;
  return JUSTIFY_ALIASES[trimmed.toLowerCase()];
}

function normalizeAlign(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (VALID_ALIGN.has(trimmed)) return trimmed;
  return ALIGN_ALIASES[trimmed.toLowerCase()];
}

function isSafeHttpOrRasterImageUrl(raw: unknown, allowRasterDataUrl = false): boolean {
  if (typeof raw !== "string") return true;
  const trimmed = raw.trim();
  if (allowRasterDataUrl && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(trimmed)) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isObscuredFieldValue(value: unknown): boolean {
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    return lower === "obscured" || lower === "password";
  }
  // Dynamic binding on variant/type could hide an obscured password input in dataModel.
  return isRecord(value);
}

function sanitizeActionContext(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const unwrapped = unwrapLiteral(v);
    // DynamicValueSchema in v1.0 does not allow null or undefined.
    if (unwrapped === null || unwrapped === undefined) continue;
    out[k] = unwrapped;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeAction(raw: unknown, fallbackName = "action"): Record<string, unknown> {
  if (typeof raw === "string" && raw.trim()) {
    return { event: { name: raw.trim() } };
  }
  if (!isRecord(raw)) {
    return { event: { name: fallbackName } };
  }
  if (isRecord(raw.functionCall)) {
    return { functionCall: raw.functionCall };
  }
  const source = isRecord(raw.event) ? raw.event : raw;
  const name = typeof source.name === "string" && source.name.trim()
    ? source.name.trim()
    : typeof source.action === "string" && source.action.trim()
      ? source.action.trim()
      : fallbackName;
  const event: Record<string, unknown> = { name };
  const userMessage = unwrapLiteral(source.userMessage);
  if (typeof userMessage === "string" || isDynamicExpr(userMessage)) {
    event.userMessage = userMessage;
  }
  const ctx = sanitizeActionContext(source.context ?? source.payload ?? source.data);
  if (ctx) event.context = ctx;
  return { event };
}

function isInlineComponent(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.component === "string";
}

type IdRegistry = {
  map: Map<string, string>;
  used: Set<string>;
  autoCounter: number;
};

function createIdRegistry(): IdRegistry {
  return { map: new Map(), used: new Set(), autoCounter: 0 };
}

function allocAutoId(reg: IdRegistry, prefix = "node"): string {
  let candidate = `${prefix}_${++reg.autoCounter}`;
  while (reg.used.has(candidate)) {
    candidate = `${prefix}_${++reg.autoCounter}`;
  }
  reg.used.add(candidate);
  return candidate;
}

/** Maps any raw LLM component ID (including kebab-case like `stat-1`) to a unique UAX #31 identifier. */
function mapId(reg: IdRegistry, raw: string): string {
  const existing = reg.map.get(raw);
  if (existing) return existing;
  if (raw === "root") {
    reg.map.set("root", "root");
    reg.used.add("root");
    return "root";
  }
  let valid = raw;
  if (!UAX31_ID_RE.test(valid)) {
    valid = valid.replace(/[^\p{XID_Continue}]+/gu, "_");
    if (!valid || !UAX31_START_RE.test(valid)) valid = `c_${valid || "node"}`;
    // Final safety fallback if Unicode cleaning still fails.
    if (!UAX31_ID_RE.test(valid)) valid = `c_${++reg.autoCounter}`;
  }
  let unique = valid;
  let suffix = 2;
  while (reg.used.has(unique)) {
    unique = `${valid}_${suffix++}`;
  }
  reg.map.set(raw, unique);
  reg.used.add(unique);
  return unique;
}

function normalizeComponentType(rawType: string): { type: string; preset?: Record<string, unknown> } {
  if (STRICT_ALLOWED_KEYS[rawType] || CUSTOM_COMPONENT_NAMES.has(rawType)) {
    return { type: rawType };
  }
  const alias = COMPONENT_TYPE_ALIASES[rawType.trim().toLowerCase()];
  if (alias) return { type: alias.target, preset: alias.preset };
  return { type: rawType };
}

/**
 * Normalizes, flattens, and sanitizes untrusted LLM-generated A2UI components:
 * - Flattens inline nested component trees into flat v1.0 adjacency lists.
 * - Normalizes kebab-case / non-UAX#31 IDs consistently across all parent/child links.
 * - Repairs common LLM schema mismatches (`Card.children`, `Button.label`, `Text.variant:"h2"`,
 *   `Row/Column` `gap`/`alignment`/`distribution`, `DataTable` object rows, `TextField` missing `value`, etc.).
 * - Enforces all security guardrails (anti-phishing password block, safe URLs, pre-Zod collection caps).
 */
function sanitizeComponents(
  rawComponents: unknown[],
  warnings: string[],
  ensureRoot: boolean,
  idReg: IdRegistry,
  preferredRootId?: string,
): unknown[] {
  const collected: Record<string, unknown>[] = [];
  let surfaceChildRef: string | undefined;
  let truncatedByCount = false;

  const pushComponent = (comp: Record<string, unknown>) => {
    if (collected.length >= MAX_COMPONENTS_PER_SURFACE) {
      truncatedByCount = true;
      return;
    }
    collected.push(comp);
  };

  /** Flattens a child slot that may be a string ID or an inline component object; returns its raw ID. */
  const resolveChildSlot = (slot: unknown, depth: number): string | null => {
    if (typeof slot === "string" && slot.trim()) return slot.trim();
    if (isInlineComponent(slot) && depth < MAX_INLINE_DEPTH) {
      return ingestComponent(slot, depth + 1);
    }
    return null;
  };

  /** Normalizes v1.0 array, v0.8 `{ explicitList }`, `{ template }`, single ID, or inline array. */
  const resolveChildList = (rawList: unknown, depth: number): unknown => {
    if (typeof rawList === "string" && rawList.trim()) {
      return [rawList.trim()];
    }
    if (isInlineComponent(rawList) && depth < MAX_INLINE_DEPTH) {
      const id = ingestComponent(rawList, depth + 1);
      return id ? [id] : [];
    }
    if (isRecord(rawList)) {
      if (Array.isArray(rawList.explicitList)) {
        return resolveChildList(rawList.explicitList, depth);
      }
      if (isRecord(rawList.template) && typeof rawList.template.componentId === "string") {
        const path = typeof rawList.template.path === "string"
          ? rawList.template.path
          : typeof rawList.template.dataBinding === "string"
            ? rawList.template.dataBinding
            : "/";
        return { componentId: rawList.template.componentId, path };
      }
      if (typeof rawList.componentId === "string") {
        const path = typeof rawList.path === "string"
          ? rawList.path
          : typeof rawList.dataBinding === "string"
            ? rawList.dataBinding
            : "/";
        return { componentId: rawList.componentId, path };
      }
      return [];
    }
    if (Array.isArray(rawList)) {
      if (rawList.length > MAX_CHILDREN) {
        warnings.push(`하위 컴포넌트 수가 상한(${MAX_CHILDREN}개)을 넘어 일부를 생략했습니다.`);
      }
      const ids: string[] = [];
      for (const item of rawList.slice(0, MAX_CHILDREN)) {
        const id = resolveChildSlot(item, depth);
        if (id) ids.push(id);
      }
      return ids;
    }
    return [];
  };

  const ingestComponent = (item: Record<string, unknown>, depth: number): string | null => {
    if (collected.length >= MAX_COMPONENTS_PER_SURFACE) {
      truncatedByCount = true;
      return null;
    }
    const copy: Record<string, unknown> = { ...item };
    const rawType = typeof copy.component === "string" ? copy.component.trim() : "";

    // Drop reserved Surface wrapper component (implicit in createSurface) and remember its child as root hint.
    if (rawType === "Surface") {
      if (typeof copy.child === "string" && copy.child.trim()) {
        surfaceChildRef = copy.child.trim();
      }
      return null;
    }

    const rawId = typeof copy.id === "string" && copy.id.trim() ? copy.id.trim() : allocAutoId(idReg, "c");
    copy.id = rawId;

    const { type: normType, preset } = normalizeComponentType(rawType);
    copy.component = normType;
    if (preset) {
      for (const [k, v] of Object.entries(preset)) {
        if (!(k in copy)) copy[k] = v;
      }
    }

    // 1. Security guardrails (before stripping/normalizing keys)
    if (copy.component === "TextField") {
      let stripped = false;
      if (isObscuredFieldValue(copy.variant)) {
        copy.variant = "shortText";
        stripped = true;
      }
      for (const legacyKey of ["type", "usageHint", "textFieldType"] as const) {
        if (legacyKey in copy) {
          if (isObscuredFieldValue(copy[legacyKey])) stripped = true;
          delete copy[legacyKey];
        }
      }
      if (stripped) {
        warnings.push("보안 정책에 따라 비밀번호 입력 형식은 일반 텍스트 입력으로 전환되었습니다.");
      }
    }

    // Map Image aliases before URL safety check so src is also checked.
    if (copy.component === "Image" && !("url" in copy) && "src" in copy) {
      copy.url = copy.src;
      delete copy.src;
    }

    const allowDataImage = copy.component === "Image";
    const unwrappedUrl = unwrapLiteral(copy.url);
    if (typeof unwrappedUrl === "string") {
      if (!isSafeHttpOrRasterImageUrl(unwrappedUrl, allowDataImage)) {
        delete copy.url;
        warnings.push("안전하지 않은 URL 속성을 제거했습니다.");
      } else {
        copy.url = unwrappedUrl;
      }
    } else if (isRecord(copy.url) && typeof copy.url.literalString === "string" && !isSafeHttpOrRasterImageUrl(copy.url.literalString, allowDataImage)) {
      delete copy.url;
      warnings.push("안전하지 않은 URL 속성을 제거했습니다.");
    }

    // 2. Per-component schema repair & flattening
    switch (copy.component) {
      case "Text": {
        const rawText = copy.text ?? copy.content ?? copy.value ?? copy.title ?? "";
        let text = coerceDynamicString(rawText, "");
        const rawVar = String(copy.variant ?? copy.usageHint ?? "").trim().toLowerCase();
        const headingMap: Record<string, string> = {
          h1: "# ", h2: "## ", h3: "### ", h4: "#### ", h5: "##### ",
          title: "### ", heading: "### ",
        };
        const prefix = (typeof copy._headingPrefix === "string" ? copy._headingPrefix : headingMap[rawVar]) ?? "";
        if (prefix && typeof text === "string" && text && !text.startsWith("#")) {
          text = `${prefix}${text}`;
        }
        copy.text = text;
        if (rawVar === "caption" || rawVar === "small" || rawVar === "muted" || rawVar === "subtitle" || rawVar === "subheading") {
          copy.variant = "caption";
        } else if (rawVar === "body") {
          copy.variant = "body";
        } else {
          delete copy.variant;
        }
        break;
      }

      case "Row":
      case "Column": {
        const rawChildren = copy.children ?? (copy.child !== undefined ? [copy.child] : copy.items ?? []);
        copy.children = resolveChildList(rawChildren, depth);
        const justify = normalizeJustify(copy.justify ?? copy.distribution);
        if (justify) copy.justify = justify;
        else delete copy.justify;
        const align = normalizeAlign(copy.align ?? copy.alignment);
        if (align) copy.align = align;
        else delete copy.align;
        break;
      }

      case "List": {
        const rawChildren = copy.children ?? copy.items ?? (copy.child !== undefined ? [copy.child] : []);
        copy.children = resolveChildList(rawChildren, depth);
        const dir = typeof copy.direction === "string" ? copy.direction.trim().toLowerCase() : "";
        if (dir === "horizontal" || dir === "vertical") copy.direction = dir;
        else delete copy.direction;
        const align = normalizeAlign(copy.align ?? copy.alignment);
        if (align) copy.align = align;
        else delete copy.align;
        break;
      }

      case "Card": {
        const cardTitle = typeof copy.title === "string" && copy.title.trim() ? copy.title.trim() : undefined;
        const cardSubtitle = typeof copy.subtitle === "string" && copy.subtitle.trim() ? copy.subtitle.trim() : undefined;
        const childIds: string[] = [];

        if (cardTitle) {
          const titleId = allocAutoId(idReg, "card_title");
          pushComponent({ id: titleId, component: "Text", text: cardTitle.startsWith("#") ? cardTitle : `### ${cardTitle}` });
          childIds.push(titleId);
        }
        if (cardSubtitle) {
          const subId = allocAutoId(idReg, "card_sub");
          pushComponent({ id: subId, component: "Text", text: cardSubtitle, variant: "caption" });
          childIds.push(subId);
        }

        const singleSlot = copy.child ?? copy.content ?? copy.body;
        if (singleSlot !== undefined) {
          if (Array.isArray(singleSlot)) {
            const list = resolveChildList(singleSlot, depth);
            if (Array.isArray(list)) {
              for (const id of list) {
                if (typeof id === "string") childIds.push(id);
              }
            }
          } else {
            const id = resolveChildSlot(singleSlot, depth);
            if (id) childIds.push(id);
          }
        }
        if (copy.children !== undefined) {
          const list = resolveChildList(copy.children, depth);
          if (Array.isArray(list)) {
            for (const id of list) {
              if (typeof id === "string") childIds.push(id);
            }
          } else if (isRecord(list)) {
            // Template child list inside Card -> wrap in Column.
            const listId = allocAutoId(idReg, "card_list");
            pushComponent({ id: listId, component: "Column", children: list });
            childIds.push(listId);
          }
        }
        if (childIds.length === 0) {
          const fallbackText = typeof copy.text === "string" ? copy.text : typeof copy.description === "string" ? copy.description : "";
          const bodyId = allocAutoId(idReg, "card_body");
          pushComponent({ id: bodyId, component: "Text", text: fallbackText });
          childIds.push(bodyId);
        }

        if (childIds.length === 1) {
          copy.child = childIds[0]!;
        } else {
          const colId = allocAutoId(idReg, "card_col");
          pushComponent({ id: colId, component: "Column", children: childIds });
          copy.child = colId;
        }
        break;
      }

      case "Button": {
        let childId = copy.child !== undefined ? resolveChildSlot(copy.child, depth) : null;
        if (!childId) {
          const btnText = coerceDynamicString(copy.label ?? copy.text ?? copy.title ?? "실행", "실행");
          childId = allocAutoId(idReg, "btn_label");
          pushComponent({ id: childId, component: "Text", text: btnText });
        }
        copy.child = childId;
        const rawVar = typeof copy.variant === "string" ? copy.variant.trim().toLowerCase() : "";
        if (rawVar === "primary") copy.variant = "primary";
        else if (rawVar === "borderless" || rawVar === "ghost" || rawVar === "link" || rawVar === "text") copy.variant = "borderless";
        else if (rawVar) copy.variant = "default";
        else delete copy.variant;
        copy.action = normalizeAction(copy.action ?? copy.onClick ?? copy.onPress, rawId);
        break;
      }

      case "TextField": {
        copy.label = coerceDynamicString(copy.label ?? copy.title ?? copy.placeholder ?? "", "");
        copy.value = coerceDynamicString(copy.value ?? copy.defaultValue ?? copy.text ?? "", "");
        if (copy.placeholder !== undefined) {
          copy.placeholder = coerceDynamicString(copy.placeholder, "");
        }
        const rawVar = typeof copy.variant === "string" ? copy.variant.trim().toLowerCase() : "";
        if (copy.multiline === true || rawVar === "longtext" || rawVar === "textarea" || rawVar === "multiline") {
          copy.variant = "longText";
        } else if (rawVar === "number" || rawVar === "numeric") {
          copy.variant = "number";
        } else {
          copy.variant = "shortText";
        }
        break;
      }

      case "CheckBox": {
        copy.label = coerceDynamicString(copy.label ?? copy.title ?? copy.text ?? "", "");
        copy.value = coerceDynamicBoolean(copy.value ?? copy.checked ?? copy.defaultChecked, false);
        break;
      }

      case "ChoicePicker": {
        if (copy.label !== undefined) copy.label = coerceDynamicString(copy.label, "");
        const rawOpts = Array.isArray(copy.options) ? copy.options : Array.isArray(copy.choices) ? copy.choices : [];
        copy.options = rawOpts.slice(0, MAX_CHILDREN).map((opt, idx) => {
          if (typeof opt === "string" || typeof opt === "number") {
            const s = String(opt);
            return { label: s, value: s };
          }
          if (isRecord(opt)) {
            const label = coerceDynamicString(opt.label ?? opt.text ?? opt.title ?? opt.value ?? `옵션 ${idx + 1}`, `옵션 ${idx + 1}`);
            const value = typeof opt.value === "string"
              ? opt.value
              : opt.value !== undefined && opt.value !== null
                ? String(opt.value)
                : typeof opt.id === "string"
                  ? opt.id
                  : typeof label === "string"
                    ? label
                    : `opt_${idx + 1}`;
            return { label, value };
          }
          return { label: `옵션 ${idx + 1}`, value: `opt_${idx + 1}` };
        });
        const rawVal = unwrapLiteral(copy.value ?? copy.selected);
        if (isDynamicExpr(rawVal)) {
          copy.value = rawVal;
        } else if (Array.isArray(rawVal)) {
          copy.value = rawVal.map(v => String(v));
        } else if (typeof rawVal === "string" && rawVal) {
          copy.value = [rawVal];
        } else {
          copy.value = [];
        }
        const rawVar = typeof copy.variant === "string" ? copy.variant.trim().toLowerCase() : "";
        if (copy.multiple === true || rawVar === "multipleselection" || rawVar === "multiple" || rawVar === "multi" || rawVar === "checkbox") {
          copy.variant = "multipleSelection";
        } else if (rawVar) {
          copy.variant = "mutuallyExclusive";
        } else {
          delete copy.variant;
        }
        if (copy.displayStyle !== "checkbox" && copy.displayStyle !== "chips") delete copy.displayStyle;
        if (typeof copy.filterable !== "boolean") delete copy.filterable;
        break;
      }

      case "Slider": {
        if (copy.label !== undefined) copy.label = coerceDynamicString(copy.label, "");
        const min = typeof copy.min === "number" && Number.isFinite(copy.min) ? copy.min : Number.isFinite(Number(copy.min)) && copy.min !== undefined ? Number(copy.min) : 0;
        const max = typeof copy.max === "number" && Number.isFinite(copy.max) ? copy.max : Number.isFinite(Number(copy.max)) && copy.max !== undefined ? Number(copy.max) : 100;
        const effectiveMax = max > min ? max : min + 100;
        copy.min = min;
        copy.max = effectiveMax;
        copy.value = coerceDynamicNumber(copy.value, min);
        if (typeof copy.steps === "number" && Number.isInteger(copy.steps) && copy.steps >= 1) {
          // valid
        } else if (typeof copy.step === "number" && copy.step > 0 && effectiveMax > min) {
          const computed = Math.round((effectiveMax - min) / copy.step);
          if (computed >= 1) copy.steps = computed;
        } else {
          delete copy.steps;
        }
        break;
      }

      case "DateTimeInput": {
        if (copy.label !== undefined) copy.label = coerceDynamicString(copy.label, "");
        copy.value = coerceDynamicString(copy.value ?? "", "");
        if (typeof copy.enableDate !== "boolean") delete copy.enableDate;
        if (typeof copy.enableTime !== "boolean") delete copy.enableTime;
        break;
      }

      case "Divider": {
        const axis = String(copy.axis ?? copy.orientation ?? copy.direction ?? "").trim().toLowerCase();
        if (axis === "vertical" || axis === "horizontal") copy.axis = axis;
        else delete copy.axis;
        break;
      }

      case "Icon": {
        const rawName = unwrapLiteral(copy.name);
        if (typeof rawName === "string") {
          const trimmed = rawName.trim();
          if (VALID_ICON_NAMES.has(trimmed)) {
            copy.name = trimmed;
          } else {
            copy.name = ICON_ALIASES[trimmed.toLowerCase()] ?? "info";
          }
        } else if (isRecord(rawName) && ("svgPath" in rawName || isDynamicExpr(rawName))) {
          copy.name = rawName;
        } else {
          copy.name = "info";
        }
        break;
      }

      case "Image": {
        if (copy.description === undefined && copy.alt !== undefined) {
          copy.description = coerceDynamicString(copy.alt, "");
        } else if (copy.description !== undefined) {
          copy.description = coerceDynamicString(copy.description, "");
        }
        if (copy.url === undefined) copy.url = "";
        const validFits = new Set(["contain", "cover", "fill", "none", "scaleDown"]);
        if (typeof copy.fit !== "string" || !validFits.has(copy.fit)) delete copy.fit;
        const validVariants = new Set(["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"]);
        if (typeof copy.variant !== "string" || !validVariants.has(copy.variant)) delete copy.variant;
        break;
      }

      case "Tabs": {
        const rawTabs = Array.isArray(copy.tabs) ? copy.tabs : Array.isArray(copy.tabItems) ? copy.tabItems : Array.isArray(copy.items) ? copy.items : [];
        const normTabs: Array<{ title: unknown; child: string }> = [];
        for (let idx = 0; idx < rawTabs.slice(0, MAX_CHILDREN).length; idx++) {
          const tab = rawTabs[idx];
          if (!isRecord(tab)) continue;
          const title = coerceDynamicString(tab.title ?? tab.label ?? `탭 ${idx + 1}`, `탭 ${idx + 1}`);
          let childId = resolveChildSlot(tab.child ?? tab.content, depth);
          if (!childId && tab.children !== undefined) {
            const list = resolveChildList(tab.children, depth);
            childId = allocAutoId(idReg, "tab_col");
            pushComponent({ id: childId, component: "Column", children: list });
          }
          if (!childId) {
            childId = allocAutoId(idReg, "tab_body");
            pushComponent({ id: childId, component: "Text", text: "" });
          }
          normTabs.push({ title, child: childId });
        }
        if (normTabs.length === 0) {
          copy.component = "Column";
          copy.children = [];
        } else {
          copy.tabs = normTabs;
        }
        break;
      }

      case "Modal": {
        let triggerId = resolveChildSlot(copy.trigger, depth);
        if (!triggerId) {
          triggerId = allocAutoId(idReg, "modal_trigger");
          pushComponent({ id: triggerId, component: "Text", text: "열기" });
        }
        let contentId = resolveChildSlot(copy.content ?? copy.child, depth);
        if (!contentId) {
          contentId = allocAutoId(idReg, "modal_content");
          pushComponent({ id: contentId, component: "Text", text: "" });
        }
        copy.trigger = triggerId;
        copy.content = contentId;
        break;
      }

      case "StatCard": {
        copy.label = coerceDynamicString(copy.label ?? copy.title ?? "", "");
        copy.value = coerceDynamicString(copy.value ?? "", "");
        if (copy.delta !== undefined || copy.change !== undefined || copy.trend !== undefined) {
          copy.delta = coerceDynamicString(copy.delta ?? copy.change ?? copy.trend, "");
        }
        if (copy.caption !== undefined || copy.subtitle !== undefined || copy.description !== undefined) {
          copy.caption = coerceDynamicString(copy.caption ?? copy.subtitle ?? copy.description, "");
        }
        const tone = normalizeTone(copy.tone ?? copy.variant ?? copy.color);
        if (tone) copy.tone = tone;
        else delete copy.tone;
        break;
      }

      case "Badge": {
        copy.text = coerceDynamicString(copy.text ?? copy.label ?? copy.value ?? "", "");
        const tone = normalizeTone(copy.tone ?? copy.variant ?? copy.color);
        if (tone) copy.tone = tone;
        else delete copy.tone;
        break;
      }

      case "KeyValue": {
        let rawItems: unknown = copy.items ?? copy.entries ?? copy.pairs ?? copy.rows ?? [];
        if (isRecord(rawItems)) {
          rawItems = Object.entries(rawItems).map(([k, v]) => ({ label: k, value: v }));
        }
        if (!Array.isArray(rawItems)) rawItems = [];
        if ((rawItems as unknown[]).length > MAX_KV_ITEMS) {
          warnings.push(`항목 수가 상한(${MAX_KV_ITEMS}개)을 넘어 일부를 생략했습니다.`);
        }
        copy.items = (rawItems as unknown[]).slice(0, MAX_KV_ITEMS).map(entry => {
          if (isRecord(entry)) {
            return {
              label: coerceDynamicString(entry.label ?? entry.key ?? entry.name ?? "", ""),
              value: coerceDynamicString(entry.value ?? "", ""),
              ...(typeof entry.mono === "boolean" ? { mono: entry.mono } : {}),
            };
          }
          return { label: "", value: coerceDynamicString(entry, "") };
        });
        break;
      }

      case "DataTable": {
        let columns: string[] = [];
        const rawCols = copy.columns ?? copy.headers;
        if (Array.isArray(rawCols)) {
          if (rawCols.length > MAX_TABLE_COLUMNS) {
            warnings.push(`표 열 수가 상한(${MAX_TABLE_COLUMNS}개)을 넘어 일부를 생략했습니다.`);
          }
          columns = rawCols.slice(0, MAX_TABLE_COLUMNS).map(col => {
            if (isRecord(col)) return String(col.label ?? col.header ?? col.title ?? col.key ?? "");
            return String(col ?? "");
          });
        }
        const rawRows = Array.isArray(copy.rows) ? copy.rows : Array.isArray(copy.data) ? copy.data : [];
        if (rawRows.length > MAX_TABLE_ROWS) {
          warnings.push(`표 행 수가 상한(${MAX_TABLE_ROWS}행)을 넘어 일부를 생략했습니다.`);
        }
        const boundedRows = rawRows.slice(0, MAX_TABLE_ROWS);
        // Derive columns from object rows when columns were omitted.
        if (columns.length === 0 && boundedRows.length > 0 && isRecord(boundedRows[0])) {
          columns = Object.keys(boundedRows[0]).slice(0, MAX_TABLE_COLUMNS);
        }
        const toCell = (cell: unknown): string | number | boolean | null => {
          const u = unwrapLiteral(cell);
          if (u === null || u === undefined) return null;
          if (typeof u === "string" || typeof u === "number" || typeof u === "boolean") return u;
          return JSON.stringify(u);
        };
        const normRows = boundedRows.map(row => {
          if (Array.isArray(row)) {
            return row.slice(0, MAX_TABLE_COLUMNS).map(toCell);
          }
          if (isRecord(row)) {
            const keys = columns.length ? columns : Object.keys(row).slice(0, MAX_TABLE_COLUMNS);
            return keys.map(k => toCell(row[k]));
          }
          return [toCell(row)];
        });
        copy.columns = columns;
        copy.rows = normRows;
        if (copy.title !== undefined) copy.title = coerceDynamicString(copy.title, "");
        if (copy.actionLabel !== undefined) copy.actionLabel = coerceDynamicString(copy.actionLabel, "");
        if (copy.onSelectAction !== undefined) {
          copy.onSelectAction = normalizeAction(copy.onSelectAction, "table_selection");
        }
        break;
      }

      case "TabLink": {
        copy.title = coerceDynamicString(copy.title ?? copy.label ?? copy.name ?? copy.url ?? "탭 열기", "탭 열기");
        if (copy.subtitle !== undefined || copy.description !== undefined) {
          copy.subtitle = coerceDynamicString(copy.subtitle ?? copy.description, "");
        }
        if (copy.tabId !== undefined) {
          const n = coerceDynamicNumber(copy.tabId, NaN);
          if (isDynamicExpr(n) || (typeof n === "number" && Number.isInteger(n) && n > 0)) {
            copy.tabId = n;
          } else {
            delete copy.tabId;
          }
        }
        break;
      }

      case "ProgressBar": {
        copy.label = coerceDynamicString(copy.label ?? copy.title ?? "진행률", "진행률");
        copy.value = coerceDynamicNumber(copy.value ?? copy.percent ?? copy.progress, 0);
        if (copy.max !== undefined) {
          copy.max = coerceDynamicNumber(copy.max, 100);
        }
        if (copy.caption !== undefined || copy.subtitle !== undefined) {
          copy.caption = coerceDynamicString(copy.caption ?? copy.subtitle, "");
        }
        const tone = normalizeTone(copy.tone ?? copy.variant ?? copy.color);
        if (tone) copy.tone = tone;
        else delete copy.tone;
        break;
      }

      default:
        break;
    }

    // 3. Strict key whitelisting for standard v1.0 components so harmless extra LLM props never fail `.strict()`.
    const compName = String(copy.component ?? "");
    const allowed = STRICT_ALLOWED_KEYS[compName];
    if (allowed) {
      if (copy.weight !== undefined && (typeof copy.weight !== "number" || !Number.isFinite(copy.weight))) {
        delete copy.weight;
      }
      if ("@checks" in copy && !CHECKABLE_COMPONENTS.has(compName)) {
        delete copy["@checks"];
      }
      for (const key of Object.keys(copy)) {
        if (!ENVELOPE_KEYS.has(key) && !allowed.has(key)) {
          delete copy[key];
        }
      }
    } else {
      delete copy._headingPrefix;
    }

    pushComponent(copy);
    return rawId;
  };

  for (const item of rawComponents) {
    if (!isRecord(item)) continue;
    ingestComponent(item, 0);
  }

  if (truncatedByCount) {
    warnings.push(`컴포넌트 수가 상한(${MAX_COMPONENTS_PER_SURFACE}개)을 넘어 일부를 생략했습니다.`);
  }

  // Deduplicate duplicate raw IDs (keep last definition) so validateComponentsBatch never throws Duplicate component ID.
  const dedupedByRawId = new Map<string, Record<string, unknown>>();
  for (const comp of collected) {
    if (typeof comp.id === "string") {
      dedupedByRawId.set(comp.id, comp);
    }
  }
  const deduped = Array.from(dedupedByRawId.values());

  // Determine if a single unambiguous top-level component should become "root".
  if (ensureRoot && deduped.length > 0 && !deduped.some(c => c.id === "root")) {
    const targetHint = preferredRootId || surfaceChildRef;
    const hinted = targetHint ? deduped.find(c => c.id === targetHint) : undefined;
    if (hinted) {
      hinted.id = "root";
    } else {
      const referenced = new Set<string>();
      for (const item of deduped) {
        if (typeof item.child === "string") referenced.add(item.child);
        if (typeof item.trigger === "string") referenced.add(item.trigger);
        if (typeof item.content === "string") referenced.add(item.content);
        if (Array.isArray(item.children)) {
          for (const child of item.children) {
            if (typeof child === "string") referenced.add(child);
          }
        } else if (isRecord(item.children) && typeof item.children.componentId === "string") {
          referenced.add(item.children.componentId);
        }
        if (Array.isArray(item.tabs)) {
          for (const tab of item.tabs) {
            if (isRecord(tab) && typeof tab.child === "string") referenced.add(tab.child);
          }
        }
      }
      const topLevel = deduped.filter(c => typeof c.id === "string" && !referenced.has(c.id));
      if (topLevel.length === 1 && topLevel[0]) {
        topLevel[0].id = "root";
      }
    }
  }

  // Pass 2: Normalize all component IDs & references to valid UAX #31 identifiers.
  for (const comp of deduped) {
    if (typeof comp.id === "string") {
      comp.id = mapId(idReg, comp.id);
    }
  }
  for (const comp of deduped) {
    if (typeof comp.child === "string") comp.child = mapId(idReg, comp.child);
    if (typeof comp.trigger === "string") comp.trigger = mapId(idReg, comp.trigger);
    if (typeof comp.content === "string") comp.content = mapId(idReg, comp.content);
    if (Array.isArray(comp.children)) {
      comp.children = comp.children.map(c => (typeof c === "string" ? mapId(idReg, c) : c));
    } else if (isRecord(comp.children) && typeof comp.children.componentId === "string") {
      comp.children = { ...comp.children, componentId: mapId(idReg, comp.children.componentId) };
    }
    if (Array.isArray(comp.tabs)) {
      comp.tabs = comp.tabs.map(tab =>
        isRecord(tab) && typeof tab.child === "string" ? { ...tab, child: mapId(idReg, tab.child) } : tab,
      );
    }
  }

  return deduped;
}

function normalizeVersion(raw: unknown): string {
  if (typeof raw === "number") return raw >= 1 ? "1.0" : `v${raw}`;
  if (typeof raw !== "string" || !raw.trim()) return "1.0";
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "1" || cleaned === "1.0" || cleaned === "v1" || cleaned === "v1.0" || cleaned === "1.0.0") {
    return "1.0";
  }
  if (cleaned === "0.9" || cleaned === "v0.9" || cleaned === "0.9.1" || cleaned === "v0.9.1") {
    return "v0.9";
  }
  return "1.0";
}

function normalizeMessage(
  raw: unknown,
  index: number,
  warnings: string[],
  idReg: IdRegistry,
): ProcessableMessage | null {
  if (!isRecord(raw)) return null;

  // Support shorthand payloads that omit the `createSurface` envelope (`{ components: [...], dataModel?: {...} }`).
  let msg: Record<string, unknown>;
  const hasEnvelope =
    "createSurface" in raw ||
    "updateComponents" in raw ||
    "updateDataModel" in raw ||
    "deleteSurface" in raw;
  if (!hasEnvelope) {
    if (Array.isArray(raw.components)) {
      msg = {
        version: "1.0",
        createSurface: {
          surfaceId: typeof raw.surfaceId === "string" && raw.surfaceId.trim() ? raw.surfaceId.trim() : `surface_${index}`,
          catalogId: AGENT_BROWSER_CATALOG_ID,
          components: raw.components,
          ...(isRecord(raw.dataModel) ? { dataModel: raw.dataModel } : {}),
          ...(typeof raw.root === "string" ? { root: raw.root } : {}),
        },
      };
    } else if (isInlineComponent(raw)) {
      msg = {
        version: "1.0",
        createSurface: {
          surfaceId: `surface_${index}`,
          catalogId: AGENT_BROWSER_CATALOG_ID,
          components: [raw],
        },
      };
    } else {
      return null;
    }
  } else {
    msg = { ...raw };
  }

  let version = normalizeVersion(msg.version);

  if (isRecord(msg.createSurface)) {
    const rawCs = msg.createSurface;
    const preferredRoot = typeof rawCs.root === "string" && rawCs.root.trim() ? rawCs.root.trim() : undefined;
    const rawCatalogId = typeof rawCs.catalogId === "string" ? rawCs.catalogId.trim() : "";
    const usesCustom = Array.isArray(rawCs.components) && rawCs.components.some(c => {
      if (!isRecord(c) || typeof c.component !== "string") return false;
      const { type } = normalizeComponentType(c.component);
      return CUSTOM_COMPONENT_NAMES.has(type);
    });

    let catalogId = AGENT_BROWSER_CATALOG_ID;
    if (rawCatalogId === V09_BASIC_CATALOG_ID && version === "v0.9" && !usesCustom) {
      catalogId = V09_BASIC_CATALOG_ID;
    } else if (rawCatalogId === STANDARD_V1_CATALOG_ID) {
      catalogId = STANDARD_V1_CATALOG_ID;
      version = "1.0";
    } else {
      catalogId = AGENT_BROWSER_CATALOG_ID;
      version = "1.0";
    }

    const cs: Record<string, unknown> = {
      surfaceId: typeof rawCs.surfaceId === "string" && rawCs.surfaceId.trim() ? rawCs.surfaceId.trim() : `surface_${index}`,
      catalogId,
    };
    if (typeof rawCs.sendDataModel === "boolean") cs.sendDataModel = rawCs.sendDataModel;
    if (isRecord(rawCs.dataModel)) cs.dataModel = rawCs.dataModel;
    if (isRecord(rawCs.metadata)) cs.metadata = rawCs.metadata;
    const rawCompList = Array.isArray(rawCs.components)
      ? rawCs.components
      : isInlineComponent(rawCs.root)
        ? [rawCs.root]
        : undefined;
    if (rawCompList && rawCompList.length > 0) {
      const sanitized = sanitizeComponents(rawCompList, warnings, true, idReg, preferredRoot);
      if (sanitized.length > 0) cs.components = sanitized;
    }
    return { version, createSurface: cs } as unknown as ProcessableMessage;
  }

  if (isRecord(msg.updateComponents)) {
    const rawUc = msg.updateComponents;
    const uc: Record<string, unknown> = {
      surfaceId: typeof rawUc.surfaceId === "string" && rawUc.surfaceId.trim() ? rawUc.surfaceId.trim() : `surface_0`,
      components: Array.isArray(rawUc.components) ? sanitizeComponents(rawUc.components, warnings, false, idReg) : [],
    };
    return { version, updateComponents: uc } as unknown as ProcessableMessage;
  }

  if (isRecord(msg.updateDataModel)) {
    const rawUd = msg.updateDataModel;
    const ud: Record<string, unknown> = {
      surfaceId: typeof rawUd.surfaceId === "string" && rawUd.surfaceId.trim() ? rawUd.surfaceId.trim() : `surface_0`,
      value: "value" in rawUd ? rawUd.value : rawUd.data,
    };
    if (typeof rawUd.path === "string" && rawUd.path.trim()) {
      ud.path = rawUd.path.startsWith("/") ? rawUd.path : `/${rawUd.path}`;
    }
    return { version, updateDataModel: ud } as unknown as ProcessableMessage;
  }

  if (isRecord(msg.deleteSurface)) {
    const rawDs = msg.deleteSurface;
    return {
      version,
      deleteSurface: {
        surfaceId: typeof rawDs.surfaceId === "string" && rawDs.surfaceId.trim() ? rawDs.surfaceId.trim() : `surface_0`,
      },
    } as unknown as ProcessableMessage;
  }

  return null;
}

/**
 * Parses an A2UI code block payload. Accepts:
 * 1. A single JSON message object (`{"version":"1.0","createSurface":{...}}`)
 * 2. A JSON array of messages (`[{...}, {...}]`)
 * 3. JSONL (one JSON message per non-empty line)
 * 4. Shorthand `{ "components": [...], "dataModel": {...} }`
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

  const idReg = createIdRegistry();
  const messages: ProcessableMessage[] = [];
  for (let i = 0; i < items.length; i++) {
    const normalized = normalizeMessage(items[i], i, warnings, idReg);
    if (normalized) messages.push(normalized);
  }

  if (!messages.length) {
    return { ok: false, error: "유효한 A2UI 메시지(createSurface / updateComponents / updateDataModel)가 없습니다." };
  }

  return { ok: true, messages, warnings: [...new Set(warnings)] };
}
