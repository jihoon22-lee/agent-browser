import { AGENT_BROWSER_CATALOG_ID } from "./parser";

/**
 * Compact system prompt appended ONLY to side panel requests when the user enables
 * A2UI generative UI mode. Kept short to preserve model speed and tool accuracy.
 */
export const A2UI_SYSTEM_PROMPT = [
  "Interactive A2UI cards are enabled in this side panel.",
  `When a comparison, dashboard summary, sortable/exportable table, multi-field input form, or pre-execution confirmation is clearly clearer than plain text, include a \`\`\`a2ui fenced block with A2UI v1.0 JSON (catalogId: "${AGENT_BROWSER_CATALOG_ID}").`,
  'Format: {"version":"1.0","createSurface":{"surfaceId":"s1","catalogId":"https://agent-browser.local/catalogs/v1","components":[...],"dataModel":{...}}}',
  "Available components: Column, Row, Card, List, Tabs, Divider, Text (Markdown), Button (action:{event:{name,context}}), TextField, CheckBox, ChoicePicker, Slider, DateTimeInput, StatCard(label,value,delta?,tone?), Badge(text,tone?), KeyValue(items:[{label,value}]), DataTable(title?,columns,rows,searchable?,selectable?,actionLabel?,onSelectAction?), TabLink(title,tabId?,url?,subtitle?), ProgressBar(label,value,max?,caption?,tone?).",
  "Rules: Keep layouts compact for 320-440px width (prefer Column over wide Rows), never ask for passwords/secrets, never mimic system permission dialogs, and always keep a concise text summary outside the block.",
].join("\n");

/** Full reusable OpenCode Skill (SKILL.md) users can copy or export into .opencode/skills/a2ui/SKILL.md. */
export const A2UI_SKILL_MARKDOWN = `---
name: agent-browser-a2ui
description: Render rich interactive A2UI v1.0 cards, dashboards, sortable tables, forms, and action previews inside the AgentBrowser Chrome side panel.
---

# AgentBrowser A2UI Generative UI Skill

When responding inside the AgentBrowser Chrome side panel, you can emit interactive **A2UI v1.0** surfaces inside a fenced \`\`\`a2ui code block.

## Envelope Format (Single-Message v1.0)

\`\`\`a2ui
{
  "version": "1.0",
  "createSurface": {
    "surfaceId": "summary-card",
    "catalogId": "${AGENT_BROWSER_CATALOG_ID}",
    "components": [
      { "id": "root", "component": "Column", "children": ["header", "metrics", "table", "applyBtn"] },
      { "id": "header", "component": "Text", "text": "### 검색 결과 요약" },
      { "id": "metrics", "component": "Row", "children": ["m1", "m2"] },
      { "id": "m1", "component": "StatCard", "label": "추출 항목", "value": "12건", "tone": "accent" },
      { "id": "m2", "component": "StatCard", "label": "최저가", "value": "29,900원", "tone": "success" },
      {
        "id": "table",
        "component": "DataTable",
        "title": "후보 비교",
        "columns": ["이름", "가격", "평점"],
        "rows": [["상품 A", "29,900원", "4.8"], ["상품 B", "34,000원", "4.6"]],
        "searchable": true,
        "selectable": true,
        "actionLabel": "선택 항목 상세 열기",
        "onSelectAction": { "event": { "name": "inspect_selected_rows" } }
      },
      {
        "id": "applyBtn",
        "component": "Button",
        "child": "applyLabel",
        "variant": "primary",
        "action": { "event": { "name": "proceed", "context": { "choice": "top" } } }
      },
      { "id": "applyLabel", "component": "Text", "text": "1순위 항목으로 계속" }
    ],
    "dataModel": {}
  }
}
\`\`\`

## Supported Components

- **Standard A2UI v1.0**: \`Column\`, \`Row\`, \`Card\`, \`List\`, \`Tabs\`, \`Divider\`, \`Text\`, \`Button\`, \`TextField\`, \`CheckBox\`, \`ChoicePicker\`, \`Slider\`, \`DateTimeInput\`, \`Icon\`, \`Image\`, \`Modal\`
- **AgentBrowser Custom Widgets**:
  - \`StatCard\`: \`{ label, value, delta?, caption?, tone?: "neutral"|"accent"|"ai"|"success"|"warning"|"danger" }\`
  - \`Badge\`: \`{ text, tone?: "neutral"|"accent"|"ai"|"success"|"warning"|"danger" }\`
  - \`KeyValue\`: \`{ items: [{ label, value, mono?: boolean }] }\`
  - \`DataTable\`: \`{ title?, columns: string[], rows: string[][], searchable?: boolean, selectable?: boolean, actionLabel?, onSelectAction? }\`
  - \`TabLink\`: \`{ title, tabId?: number, url?: string, subtitle? }\`
  - \`ProgressBar\`: \`{ label, value: number, max?: number, caption?, tone? }\`

## Guidelines

1. Design for a **320px–440px** side panel width: stack with \`Column\`, avoid more than 2 columns in a \`Row\`.
2. Use \`dataModel\` + \`{"@path": "/field"}\` for reactive form inputs (\`TextField\`, \`CheckBox\`, \`ChoicePicker\`, \`Slider\`, \`DateTimeInput\`) and pass bound paths in button \`action.event.context\`.
3. Never request passwords or sensitive credentials, and never imitate Chrome or OpenCode permission approval dialogs.
4. Always provide a brief plain-text summary outside the \`\`\`a2ui block for accessibility and CLI sessions.
`;
