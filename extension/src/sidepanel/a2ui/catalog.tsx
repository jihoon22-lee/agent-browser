import { z } from "zod";
import { createComponentImplementation, useA2uiSurface, type ReactCatalogComponent } from "@a2ui/react";
import { Catalog, type ComponentApi } from "@a2ui/web_core";
import { CommonSchemas } from "@a2ui/web_core/v1_0";
import {
  A2uiButton,
  A2uiCard,
  A2uiCheckBox,
  A2uiChoicePicker,
  A2uiColumn,
  A2uiDateTimeInput,
  A2uiDivider,
  A2uiIcon,
  A2uiList,
  A2uiModal,
  A2uiRow,
  A2uiSlider,
  A2uiTabs,
  A2uiText,
  BASIC_FUNCTIONS,
  BasicCatalogThemeSchema,
  ImageApi,
  TextFieldApi,
} from "@a2ui/web_core/catalogs/basic/v1";
import { basicCatalog as v09BasicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { ImagePreview, InteractiveTable } from "../RichResultViewers";
import { ExternalIcon, TabIcon } from "../Icons";
import { safeLink } from "../SafeMarkdown";
import { AGENT_BROWSER_CATALOG_ID } from "./parser";

const ToneSchema = z.enum(["neutral", "accent", "ai", "success", "warning", "danger"]).optional();

function isSafeRasterDataUrl(url: string): boolean {
  return /^data:image\/(png|jpeg|webp|gif);base64,/i.test(url.trim());
}

/**
 * Hardened Image replacement:
 * - Never auto-fetches remote http(s) URLs in <img> (prevents prompt-injection data exfiltration).
 * - Inline raster data:image/(png|jpeg|webp|gif);base64 URLs render with clickable lightbox.
 * - Remote http(s) image URLs render as safe clickable links (matching SafeMarkdown).
 * - Blocks data:image/svg+xml, javascript:, file:, chrome:.
 */
function buildSafeImageComponent<Api extends ComponentApi>(api: Api): ReactCatalogComponent {
  return createComponentImplementation(api, ({ props }) => {
    const rawUrl = typeof (props as { url?: unknown }).url === "string" ? (props as { url: string }).url.trim() : "";
    const alt = typeof (props as { description?: unknown }).description === "string" && (props as { description: string }).description.trim()
      ? (props as { description: string }).description.trim()
      : "이미지";
    if (!rawUrl) return null;
    if (isSafeRasterDataUrl(rawUrl)) {
      return <ImagePreview src={rawUrl} alt={alt} downloadName="a2ui-image.png" />;
    }
    const href = safeLink(rawUrl);
    if (href) {
      return (
        <a className="a2ui-tab-link" href={href} target="_blank" rel="noopener noreferrer">
          <ExternalIcon size={14} />
          <span className="a2ui-tab-link-text">
            <strong>{alt}</strong>
            <small>{href}</small>
          </span>
        </a>
      );
    }
    return null;
  });
}

/**
 * Hardened TextField replacement:
 * - Never renders <input type="password"> even if "obscured" arrives via dynamic binding or v0.9 catalog.
 * - Full two-way binding + validation errors + light-DOM Catppuccin styling.
 */
function buildSafeTextFieldComponent<Api extends ComponentApi>(api: Api): ReactCatalogComponent {
  return createComponentImplementation(api, ({ props, accessibilityRef, validationErrorsRef }) => {
    const p = props as {
      label?: string;
      value?: string;
      setValue?: (next: string) => void;
      placeholder?: string;
      variant?: string;
      validationErrors?: string[];
    };
    const variant = p.variant === "longText" ? "longText" : p.variant === "number" ? "number" : "shortText";
    const value = p.value ?? "";
    const handleChange = (next: string) => { p.setValue?.(next); };
    return (
      <label className="a2ui-field">
        {p.label && <span className="a2ui-field-label">{p.label}</span>}
        {variant === "longText" ? (
          <textarea
            ref={accessibilityRef as ((el: HTMLTextAreaElement | null) => void) | undefined}
            className="a2ui-field-input"
            value={value}
            placeholder={p.placeholder}
            rows={3}
            onChange={e => handleChange(e.target.value)}
          />
        ) : (
          <input
            ref={accessibilityRef as ((el: HTMLInputElement | null) => void) | undefined}
            className="a2ui-field-input"
            type={variant === "number" ? "number" : "text"}
            value={value}
            placeholder={p.placeholder}
            onChange={e => handleChange(e.target.value)}
          />
        )}
        {p.validationErrors && p.validationErrors.length > 0 && (
          <small ref={validationErrorsRef as ((el: HTMLElement | null) => void) | undefined} className="a2ui-field-error" role="alert">
            {p.validationErrors.join(" ")}
          </small>
        )}
      </label>
    );
  });
}

export const SafeImageComponent = buildSafeImageComponent(ImageApi);
export const SafeTextFieldComponent = buildSafeTextFieldComponent(TextFieldApi);

// 1. StatCard: KPI metric tile for AI summaries & dashboards
export const StatCardApi = {
  name: "StatCard",
  schema: z.object({
    label: CommonSchemas.DynamicString,
    value: CommonSchemas.DynamicString,
    delta: CommonSchemas.DynamicString.optional(),
    caption: CommonSchemas.DynamicString.optional(),
    tone: ToneSchema,
  }),
};

export const StatCardComponent = createComponentImplementation(StatCardApi, ({ props }) => {
  const tone = props.tone ?? "neutral";
  return (
    <div className={`a2ui-stat-card tone-${tone}`}>
      <span className="a2ui-stat-label">{props.label}</span>
      <div className="a2ui-stat-row">
        <strong className="a2ui-stat-value">{props.value}</strong>
        {props.delta && <span className={`a2ui-badge tone-${tone}`}>{props.delta}</span>}
      </div>
      {props.caption && <small className="a2ui-stat-caption">{props.caption}</small>}
    </div>
  );
});

// 2. Badge: compact semantic status pill
export const BadgeApi = {
  name: "Badge",
  schema: z.object({
    text: CommonSchemas.DynamicString,
    tone: ToneSchema,
  }),
};

export const BadgeComponent = createComponentImplementation(BadgeApi, ({ props }) => (
  <span className={`a2ui-badge tone-${props.tone ?? "neutral"}`}>{props.text}</span>
));

// 3. KeyValue: structured metadata key/value list
export const KeyValueApi = {
  name: "KeyValue",
  schema: z.object({
    items: z.array(
      z.object({
        label: CommonSchemas.DynamicString,
        value: CommonSchemas.DynamicString,
        mono: z.boolean().optional(),
      }),
    ),
  }),
};

export const KeyValueComponent = createComponentImplementation(KeyValueApi, ({ props }) => (
  <dl className="a2ui-kv">
    {(props.items ?? []).map((item, idx) => (
      <div className="a2ui-kv-row" key={idx}>
        <dt>{item.label}</dt>
        <dd className={item.mono ? "mono" : undefined}>{item.value}</dd>
      </div>
    ))}
  </dl>
));

function resolveContextBindings(
  raw: Record<string, unknown> | undefined,
  resolvePath: (path: string) => unknown,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const rec = value as Record<string, unknown>;
      if (typeof rec["@path"] === "string") {
        out[key] = resolvePath(rec["@path"]);
        continue;
      }
      if (typeof rec.path === "string") {
        out[key] = resolvePath(rec.path);
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

// 4. DataTable: interactive sortable/searchable/exportable table with optional row selection action
export const DataTableApi = {
  name: "DataTable",
  schema: z.object({
    title: CommonSchemas.DynamicString.optional(),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
    searchable: z.boolean().optional(),
    selectable: z.boolean().optional(),
    actionLabel: CommonSchemas.DynamicString.optional(),
    onSelectAction: CommonSchemas.Action.optional(),
  }),
};

export const DataTableComponent = createComponentImplementation(DataTableApi, ({ props, context }) => {
  const surface = useA2uiSurface();
  const stringRows = (props.rows ?? []).map(row => row.map(cell => (cell === null || cell === undefined ? "" : String(cell))));
  const handleRowAction = props.onSelectAction
    ? (selectedRows: string[][], cols: string[]) => {
        if (!surface) return;
        const rawAction = context.componentModel.properties.onSelectAction as
          | { event?: { name?: string; context?: Record<string, unknown> } }
          | undefined;
        const name = rawAction?.event?.name || "table_selection";
        const extraContext = resolveContextBindings(
          rawAction?.event?.context,
          path => surface.dataModel.get(path),
        );
        void surface.dispatchAction(
          {
            name,
            context: {
              ...extraContext,
              columns: cols,
              selectedRows,
              count: selectedRows.length,
            },
          },
          context.componentModel.id,
        );
      }
    : undefined;

  return (
    <InteractiveTable
      title={props.title}
      columns={props.columns}
      rows={stringRows}
      searchable={props.searchable ?? true}
      selectable={props.selectable ?? Boolean(props.onSelectAction)}
      actionLabel={props.actionLabel}
      onRowAction={handleRowAction}
    />
  );
});

// 5. TabLink: Chrome tab jumper or safe external HTTP(S) link
export const TabLinkApi = {
  name: "TabLink",
  schema: z.object({
    title: CommonSchemas.DynamicString,
    subtitle: CommonSchemas.DynamicString.optional(),
    tabId: CommonSchemas.DynamicNumber.optional(),
    url: CommonSchemas.DynamicString.optional(),
  }),
};

export const TabLinkComponent = createComponentImplementation(TabLinkApi, ({ props }) => {
  const safeHref = props.url ? safeLink(props.url) : undefined;
  const canJumpTab = typeof props.tabId === "number" && Number.isInteger(props.tabId) && props.tabId > 0 && typeof chrome !== "undefined" && !!chrome.tabs?.update;

  const activateTab = () => {
    if (!canJumpTab || typeof props.tabId !== "number") return;
    void chrome.tabs.get(props.tabId).then(tab => {
      if (tab.windowId !== undefined) void chrome.windows?.update?.(tab.windowId, { focused: true }).catch(() => {});
      return chrome.tabs.update(props.tabId!, { active: true });
    }).catch(() => {});
  };

  if (canJumpTab) {
    return (
      <button type="button" className="a2ui-tab-link" onClick={activateTab}>
        <TabIcon size={14} />
        <span className="a2ui-tab-link-text">
          <strong>{props.title}</strong>
          {props.subtitle && <small>{props.subtitle}</small>}
        </span>
        <span className="a2ui-tab-link-id">탭 #{props.tabId}</span>
      </button>
    );
  }

  if (safeHref) {
    return (
      <a className="a2ui-tab-link" href={safeHref} target="_blank" rel="noopener noreferrer">
        <ExternalIcon size={14} />
        <span className="a2ui-tab-link-text">
          <strong>{props.title}</strong>
          {props.subtitle && <small>{props.subtitle}</small>}
        </span>
      </a>
    );
  }

  return (
    <div className="a2ui-tab-link static">
      <TabIcon size={14} />
      <span className="a2ui-tab-link-text">
        <strong>{props.title}</strong>
        {props.subtitle && <small>{props.subtitle}</small>}
      </span>
    </div>
  );
});

// 6. ProgressBar: compact labeled progress meter
export const ProgressBarApi = {
  name: "ProgressBar",
  schema: z.object({
    label: CommonSchemas.DynamicString,
    value: CommonSchemas.DynamicNumber,
    max: CommonSchemas.DynamicNumber.optional(),
    caption: CommonSchemas.DynamicString.optional(),
    tone: ToneSchema,
  }),
};

export const ProgressBarComponent = createComponentImplementation(ProgressBarApi, ({ props }) => {
  const max = typeof props.max === "number" && props.max > 0 ? props.max : 100;
  const pct = Math.max(0, Math.min(100, Math.round(((props.value ?? 0) / max) * 100)));
  const tone = props.tone ?? "accent";
  return (
    <div className={`a2ui-progress tone-${tone}`}>
      <div className="a2ui-progress-head">
        <span>{props.label}</span>
        <strong>{pct}%</strong>
      </div>
      <div className="a2ui-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={props.label}>
        <span className="a2ui-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {props.caption && <small>{props.caption}</small>}
    </div>
  );
});

const SAFE_BASIC_V1_COMPONENTS: ReactCatalogComponent[] = [
  A2uiText,
  SafeImageComponent,
  A2uiIcon,
  A2uiRow,
  A2uiColumn,
  A2uiList,
  A2uiCard,
  A2uiTabs,
  A2uiModal,
  A2uiDivider,
  A2uiButton,
  SafeTextFieldComponent,
  A2uiCheckBox,
  A2uiChoicePicker,
  A2uiSlider,
  A2uiDateTimeInput,
];

const CUSTOM_COMPONENTS: ReactCatalogComponent[] = [
  StatCardComponent,
  BadgeComponent,
  KeyValueComponent,
  DataTableComponent,
  TabLinkComponent,
  ProgressBarComponent,
];

/** Hardened v0.9 catalog: drops Video/AudioPlayer and replaces Image & TextField with safe React implementations. */
const BLOCKED_V09_COMPONENTS = new Set(["Image", "Video", "AudioPlayer", "TextField"]);
const v09ImageApi = v09BasicCatalog.components.get("Image");
const v09TextFieldApi = v09BasicCatalog.components.get("TextField");
const safeV09Components: ReactCatalogComponent[] = [
  ...Array.from(v09BasicCatalog.components.entries())
    .filter(([name]) => !BLOCKED_V09_COMPONENTS.has(name))
    .map(([, comp]) => comp as unknown as ReactCatalogComponent),
  ...(v09ImageApi ? [buildSafeImageComponent(v09ImageApi)] : []),
  ...(v09TextFieldApi ? [buildSafeTextFieldComponent(v09TextFieldApi)] : []),
];
export const safeV09Catalog = new Catalog<ReactCatalogComponent>(
  v09BasicCatalog.id,
  "0.9",
  safeV09Components,
  Array.from(v09BasicCatalog.functions.values()),
);

/** Primary AgentBrowser A2UI v1.0 catalog: safe standard components + browser-agent custom widgets. */
export const agentBrowserCatalog = new Catalog<ReactCatalogComponent>(
  AGENT_BROWSER_CATALOG_ID,
  "1.0",
  [...SAFE_BASIC_V1_COMPONENTS, ...CUSTOM_COMPONENTS],
  BASIC_FUNCTIONS,
  { themeSchema: BasicCatalogThemeSchema },
);

/** Standard v1.0 basic catalog alias so generic A2UI v1.0 payloads render cleanly too. */
export const standardV1Catalog = new Catalog<ReactCatalogComponent>(
  "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
  "1.0",
  [...SAFE_BASIC_V1_COMPONENTS, ...CUSTOM_COMPONENTS],
  BASIC_FUNCTIONS,
  { themeSchema: BasicCatalogThemeSchema },
);

/** All catalogs registered in MessageProcessor (AgentBrowser v1 + hardened standard v1.0 + hardened v0.9). */
export const A2UI_CATALOGS: Catalog<ComponentApi>[] = [
  agentBrowserCatalog as unknown as Catalog<ComponentApi>,
  standardV1Catalog as unknown as Catalog<ComponentApi>,
  safeV09Catalog as unknown as Catalog<ComponentApi>,
];
