import { Component, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { A2uiSurface, MarkdownComponentContext, type ReactCatalogComponent } from "@a2ui/react";
import { MessageProcessor, type ActionPayload, type SurfaceModel } from "@a2ui/web_core";
import { injectBasicCatalogStyles } from "@a2ui/web_core/catalogs/basic/v1";
import { A2UI_CATALOGS } from "./catalog";
import { parseA2uiBlock } from "./parser";
import { CopyButton } from "../CopyButton";
import { SparkleIcon } from "../Icons";

export type A2uiActionEvent = {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  context: Record<string, unknown>;
  userMessage?: string;
};

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

export const A2uiCard = memo(function A2uiCard({
  source,
  streaming,
  markdownRenderer,
  onAction,
}: {
  source: string;
  streaming?: boolean;
  markdownRenderer: React.ComponentType<{ markdown: string }>;
  onAction?: (action: A2uiActionEvent) => void;
}) {
  const [showSource, setShowSource] = useState(false);
  const [lastAction, setLastAction] = useState<string>("");
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  useEffect(() => { ensureStyles(); }, []);

  const parsed = useMemo(() => (streaming ? null : parseA2uiBlock(source)), [source, streaming]);

  const processed = useMemo(() => {
    if (!parsed || !parsed.ok) return null;
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
        setLastAction(event.name);
        actionRef.current?.(event);
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
    const surfaces = Array.from(processor.model.surfacesMap.values()) as SurfaceModel<ReactCatalogComponent>[];
    return { processor, surfaces, errors: [...new Set(errors)] };
  }, [parsed]);

  useEffect(() => {
    const p = processed?.processor;
    return () => { p?.dispose(); };
  }, [processed]);

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
  if (!processed || processed.surfaces.length === 0) {
    return rawFallback(processed?.errors[0] || "표시할 A2UI 서피스가 없습니다.");
  }

  return (
    <section className="a2ui-shell" aria-label="AI 생성 UI">
      <header className="a2ui-shell-header">
        <span className="a2ui-shell-badge">
          <SparkleIcon size={12} /> AI 생성 UI
        </span>
        <div className="a2ui-shell-tools">
          {lastAction && <span className="a2ui-action-sent" role="status">전송됨 · {lastAction}</span>}
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
        <A2uiErrorBoundary fallback={rawFallback("A2UI 컴포넌트 렌더링 중 오류가 발생했습니다.")}>
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
