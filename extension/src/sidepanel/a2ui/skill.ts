import { AGENT_BROWSER_CATALOG_ID } from "./parser";

/**
 * Compact system prompt appended ONLY to side panel requests when the user enables
 * A2UI generative UI mode. Kept short to preserve model speed and tool accuracy,
 * while explicitly preventing common A2UI v1.0 validation pitfalls (Card.child, flat children IDs,
 * UAX #31 alphanumeric/underscore IDs, Button.child).
 */
export const A2UI_SYSTEM_PROMPT = [
  "Interactive A2UI cards are enabled in this side panel.",
  `When a dashboard summary, comparison table, structured metadata, or interactive form is clearer than plain text, include a \`\`\`a2ui fenced block with flat A2UI v1.0 JSON using catalogId "${AGENT_BROWSER_CATALOG_ID}" (URI identifier only — do NOT fetch this URL; the complete component schema is defined below).`,
  'Example: {"version":"1.0","createSurface":{"surfaceId":"s1","catalogId":"https://agent-browser.local/catalogs/v1","components":[{"id":"root","component":"Column","children":["title","stats","tbl","btn"]},{"id":"title","component":"Text","text":"### 요약"},{"id":"stats","component":"Row","children":["s1","s2"]},{"id":"s1","component":"StatCard","label":"항목","value":"12건","tone":"ai"},{"id":"s2","component":"StatCard","label":"상태","value":"정상","tone":"success"},{"id":"tbl","component":"DataTable","columns":["이름","값"],"rows":[["A","100"]]},{"id":"btn","component":"Button","child":"btn_txt","variant":"primary","action":{"event":{"name":"apply"}}},{"id":"btn_txt","component":"Text","text":"적용"}],"dataModel":{}}}',
  "Complete self-contained v1.0 schema:",
  "- Put all components in a flat components[] array with an entry id:\"root\". Component IDs MUST use letters, digits, and underscores only (NO hyphens like stat-1).",
  "- Containers: Column(children:string[],justify?,align?), Row(children:string[],justify?,align?), List(children:string[],direction?), Card(child:string — single ID only, NOT children/title; wrap multiple items in Column), Tabs(tabs:[{title,child}]), Modal(trigger:string,content:string), Divider(axis?:\"horizontal\"|\"vertical\"). Do NOT add extra CSS keys like gap/padding/style.",
  "- Content & Actions: Text(text:Markdown string,variant?:\"body\"|\"caption\" — NOT h1/h2), Button(child:string referencing a Text component — NOT label,variant?:\"default\"|\"primary\"|\"borderless\",action:{event:{name,context?}}), Image(url,description?), Icon(name).",
  "- Form inputs (bind with {\"@path\":\"/field\"} + dataModel): TextField(label,value,placeholder?,variant?:\"shortText\"|\"longText\"|\"number\"), CheckBox(label,value:boolean), ChoicePicker(label?,options:[{label,value}],value:string[],variant?:\"mutuallyExclusive\"|\"multipleSelection\"), Slider(label?,min?,max,value), DateTimeInput(label?,value,enableDate?,enableTime?).",
  "- Custom widgets: StatCard(label,value,delta?,caption?,tone?), Badge(text,tone?), KeyValue(items:[{label,value,mono?}]), DataTable(title?,columns:string[],rows:string[][],searchable?,selectable?,actionLabel?,onSelectAction?:{event:{name,context?}}), TabLink(title,tabId?,url?,subtitle?), ProgressBar(label,value:number,max?,caption?,tone?). Valid tone: neutral|accent|ai|success|warning|danger.",
  "- Keep layouts compact for 320-440px width (max 2 items in Row), never ask for passwords/secrets, never mimic permission dialogs, and include a concise text summary outside the block.",
].join("\n");

/** Full reusable OpenCode Skill (SKILL.md) users can copy or export into .opencode/skills/a2ui/SKILL.md. */
export const A2UI_SKILL_MARKDOWN = `---
name: agent-browser-a2ui
description: Render rich interactive A2UI v1.0 cards, dashboards, sortable tables, forms, and action previews inside the AgentBrowser Chrome side panel.
---

# AgentBrowser A2UI Generative UI Skill

When responding inside the AgentBrowser Chrome side panel, you can emit interactive **A2UI v1.0** surfaces inside a fenced \`\`\`a2ui code block.

> **Note:** \`${AGENT_BROWSER_CATALOG_ID}\` is a protocol URI identifier only (not a reachable HTTP endpoint — do not fetch it). The complete schema is documented below.

## Envelope Format (Single-Message v1.0)

\`\`\`a2ui
{
  "version": "1.0",
  "createSurface": {
    "surfaceId": "summary_card",
    "catalogId": "${AGENT_BROWSER_CATALOG_ID}",
    "components": [
      { "id": "root", "component": "Column", "children": ["header", "metrics", "table", "apply_btn"] },
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
        "id": "apply_btn",
        "component": "Button",
        "child": "apply_label",
        "variant": "primary",
        "action": { "event": { "name": "proceed", "context": { "choice": "top" } } }
      },
      { "id": "apply_label", "component": "Text", "text": "1순위 항목으로 계속" }
    ],
    "dataModel": {}
  }
}
\`\`\`

## Strict v1.0 Component Rules

1. **Flat Adjacency List & UAX #31 IDs**: Put every component in the top-level \`components\` array with \`id\` using only letters, digits, and underscores (e.g. \`stat_1\`, \`apply_btn\` — NO hyphens \`-\`). Always include \`id: "root"\`.
2. **\`Column\` / \`Row\` / \`List\`**: Pass \`children\` as an array of component ID strings (\`["a", "b"]\`), never nested objects. Do not pass extra CSS keys like \`gap\`, \`padding\`, or \`style\`.
3. **\`Card\`**: Takes a single \`child\` string ID (\`{ "id": "c1", "component": "Card", "child": "inner_col" }\`), never \`children\` or \`title\`. Wrap multiple items inside a \`Column\` first.
4. **\`Button\`**: Takes \`child\` referencing a \`Text\` component (never \`label\`), optional \`variant\` (\`"default" | "primary" | "borderless"\`), and \`action: { "event": { "name": "...", "context": { ... } } }\`.
5. **\`Text\`**: Use Markdown headings (\`"### 제목"\`) inside \`text\`. Allowed \`variant\` values are \`"body"\` or \`"caption"\` only.

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
