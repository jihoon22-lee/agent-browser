import { Component, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { A2uiSurface, MarkdownComponentContext, type ReactCatalogComponent } from "@a2ui/react";
import { MessageProcessor, type ActionPayload, type ProcessableMessage, type SurfaceModel } from "@a2ui/web_core";
import { injectBasicCatalogStyles } from "@a2ui/web_core/catalogs/basic/v1";
import { A2UI_CATALOGS } from "./catalog";
import { parseA2uiBlock } from "./parser";
import { CopyButton } from "../CopyButton";
import { SparkleIcon } from "../Icons";

/**
 * If an atomic createSurface failed because a single component still failed strict schema validation,
 * isolate and omit only the invalid component(s) so the rest of the card renders cleanly.
 */
function isolateValidComponents(messages: ProcessableMessage[]): ProcessableMessage[] | null {
  let changed = false;
  const recovered: ProcessableMessage[] = [];
  for (const msg of messages) {
    const rec = msg as Record<string, unknown>;
    const cs = rec.createSurface as Record<string, unknown> | undefined;
    if (!cs || !Array.isArray(cs.components) || cs.components.length === 0) {
      recovered.push(msg);
      continue;
    }
    const validComps: Record<string, unknown>[] = [];
    for (const comp of cs.components) {
      if (!comp || typeof comp !== "object") continue;
      const probe = new MessageProcessor(A2UI_CATALOGS, undefined, { version: "v1.0", reportErrorsOnly: true });
      try {
        const probeErrs = probe.processMessagesWithErrors([
          {
            version: rec.version ?? "1.0",
            createSurface: {
              surfaceId: "_probe",
              catalogId: cs.catalogId,
              components: [comp],
            },
          } as unknown as ProcessableMessage,
        ]);
        if (probeErrs.length === 0) {
          validComps.push(comp as Record<string, unknown>);
        } else {
          changed = true;
        }
      } finally {
        probe.dispose();
      }
    }
    if (validComps.length > 0 && validComps.some(c => c.id === "root")) {
      recovered.push({
        ...rec,
        createSurface: { ...cs, components: validComps },
      } as unknown as ProcessableMessage);
    } else {
      return null;
    }
  }
  return changed ? recovered : null;
}

export type A2uiActionEvent = {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  context: Record<string, unknown>;
  userMessage?: string;
};

export type A2uiActionResult = "sent" | "drafted" | "blocked";

/** Formats an A2UI user interaction into a clean structured message sent back to OpenCode. */
export function formatA2uiActionMessage(action: A2uiActionEvent): string {
  const entries = Object.entries(action.context ?? {}).filter(([, v]) => v !== undefined);
  const lines = [`[A2UI 액션: ${action.name}]`];
  if (action.userMessage) lines.push(action.userMessage);
  if (entries.length) {
    lines.push("```json");
    lines.push(JSON.stringify(action.context, null, 2));
    lines.push("```");
  }
  return lines.join("\n");
}

class A2uiErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  try {
    injectBasicCatalogStyles();
  } catch {
    // jsdom lacks constructable stylesheets; CSS variables in style.css still apply.
  }
}

type ProcessedState = {
  ready: boolean;
  surfaces: SurfaceModel<ReactCatalogComponent>[];
  errors: string[];
};

export const A2uiCard = memo(function A2uiCard({
  source,
  streaming,
  markdownRenderer,
  onAction,
}: {
  source: string;
  streaming?: boolean;
  markdownRenderer: React.ComponentType<{ markdown: string }>;
  onAction?: (action: A2uiActionEvent) => A2uiActionResult | void;
}) {
  const [showSource, setShowSource] = useState(false);
  const [lastAction, setLastAction] = useState<{ name: string; status: "sent" | "drafted" } | null>(null);
  const [processed, setProcessed] = useState<ProcessedState>({ ready: false, surfaces: [], errors: [] });
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  useEffect(() => { ensureStyles(); }, []);

  const parsed = useMemo(() => (streaming ? null : parseA2uiBlock(source)), [source, streaming]);

  // Create and dispose MessageProcessor strictly inside useEffect so abandoned concurrent renders never leak processors.
  useEffect(() => {
    if (!parsed || !parsed.ok) {
      setProcessed({ ready: true, surfaces: [], errors: [] });
      return;
    }
    const errors: string[] = [];
    const processor = new MessageProcessor(
      A2UI_CATALOGS,
      (payload: ActionPayload) => {
        const event: A2uiActionEvent = {
          name: payload.name,
          surfaceId: payload.surfaceId,
          sourceComponentId: payload.sourceComponentId,
          context: payload.context ?? {},
          userMessage: payload.userMessage,
        };
        const result = actionRef.current?.(event);
        if (result === "blocked") setLastAction(null);
        else if (result === "drafted") setLastAction({ name: event.name, status: "drafted" });
        else setLastAction({ name: event.name, status: "sent" });
      },
      {
        version: "v1.0",
        reportErrorsOnly: true,
        errorHandler: err => {
          const msg = (err as { error?: { message?: string } })?.error?.message;
          if (msg) errors.push(msg);
        },
      },
    );
    const outErrors = processor.processMessagesWithErrors(parsed.messages);
    for (const err of outErrors) {
      const msg = (err as { error?: { message?: string } })?.error?.message;
      if (msg) errors.push(msg);
    }
    let allSurfaces = Array.from(processor.model.surfacesMap.values()) as SurfaceModel<ReactCatalogComponent>[];
    let renderable = allSurfaces.filter(surface => Boolean(surface.componentsModel.get("root")));

    // Resilient fallback: if one malformed component rolled back createSurface, retry with only valid components.
    if (renderable.length === 0 && errors.length > 0) {
      const salvaged = isolateValidComponents(parsed.messages);
      if (salvaged) {
        processor.processMessagesWithErrors(salvaged);
        allSurfaces = Array.from(processor.model.surfacesMap.values()) as SurfaceModel<ReactCatalogComponent>[];
        renderable = allSurfaces.filter(surface => Boolean(surface.componentsModel.get("root")));
      }
    }

    if (allSurfaces.length > 0 && renderable.length === 0) {
      errors.push("A2UI 서피스에 root 컴포넌트가 없어 원문으로 표시합니다.");
    }
    setProcessed({ ready: true, surfaces: renderable, errors: [...new Set(errors)] });
    return () => { processor.dispose(); };
  }, [parsed]);

  if (streaming) {
    return (
      <section className="a2ui-shell a2ui-streaming" aria-label="AI 생성 UI 준비 중">
        <header className="a2ui-shell-header">
          <span className="a2ui-shell-badge"><SparkleIcon size={12} /> AI 생성 UI</span>
          <span className="muted">구성 중…</span>
        </header>
        <div className="a2ui-skeleton" aria-hidden="true">
          <span className="a2ui-skel-line short" />
          <span className="a2ui-skel-line" />
          <span className="a2ui-skel-line medium" />
        </div>
      </section>
    );
  }

  const rawFallback = (reason: string) => (
    <section className="a2ui-shell a2ui-fallback" aria-label="AI 생성 UI 원문">
      <header className="a2ui-shell-header">
        <span className="a2ui-shell-badge"><SparkleIcon size={12} /> AI 생성 UI</span>
        <CopyButton text={source} label="코드 복사" />
      </header>
      <p className="muted a2ui-fallback-note">{reason}</p>
      <pre><code>{source}</code></pre>
    </section>
  );

  if (!parsed || !parsed.ok) {
    return rawFallback(parsed?.error ?? "A2UI 카드를 해석하지 못했습니다.");
  }
  if (!processed.ready) {
    return (
      <section className="a2ui-shell a2ui-streaming" aria-label="AI 생성 UI 준비 중">
        <header className="a2ui-shell-header">
          <span className="a2ui-shell-badge"><SparkleIcon size={12} /> AI 생성 UI</span>
          <span className="muted">렌더링 중…</span>
        </header>
      </section>
    );
  }
  if (processed.surfaces.length === 0) {
    return rawFallback(processed.errors[0] || "표시할 A2UI 서피스가 없습니다.");
  }

  return (
    <section className="a2ui-shell" aria-label="AI 생성 UI">
      <header className="a2ui-shell-header">
        <span className="a2ui-shell-badge">
          <SparkleIcon size={12} /> AI 생성 UI
        </span>
        <div className="a2ui-shell-tools">
          {lastAction && (
            <span className={lastAction.status === "sent" ? "a2ui-action-sent" : "a2ui-action-drafted"} role="status">
              {lastAction.status === "sent" ? `전송됨 · ${lastAction.name}` : `입력란에 채움 · ${lastAction.name}`}
            </span>
          )}
          <button
            type="button"
            className="quiet a2ui-source-toggle"
            aria-expanded={showSource}
            onClick={() => setShowSource(v => !v)}
          >
            {showSource ? "카드 보기" : "소스"}
          </button>
        </div>
      </header>
      {parsed.warnings.length > 0 && (
        <p className="a2ui-warning-note" role="status">{parsed.warnings.join(" ")}</p>
      )}
      {showSource ? (
        <div className="a2ui-source-view">
          <div className="toolbar"><CopyButton text={source} label="JSON 복사" /></div>
          <pre><code>{source}</code></pre>
        </div>
      ) : (
        <A2uiErrorBoundary key={source} fallback={rawFallback("A2UI 컴포넌트 렌더링 중 오류가 발생했습니다.")}>
          <MarkdownComponentContext.Provider value={markdownRenderer}>
            <div className="a2ui-surface-host">
              {processed.surfaces.map(surface => (
                <A2uiSurface key={surface.id} surface={surface} />
              ))}
            </div>
          </MarkdownComponentContext.Provider>
        </A2uiErrorBoundary>
      )}
    </section>
  );
});
