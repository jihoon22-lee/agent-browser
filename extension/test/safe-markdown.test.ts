import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeMarkdown } from "../src/sidepanel/SafeMarkdown";
it("renders markdown without executing raw HTML or javascript links", () => {
  const html = renderToStaticMarkup(createElement(SafeMarkdown, { text: "# 제목\n\n## 부제목\n\n**굵게** [링크](https://example.test) [위험](javascript:alert(1))\n<script>alert(1)</script>\n\n```js\nconst x = '<img onerror=alert(1)>';\n```" }));
  expect(html).toContain("<h3"); expect(html).toContain("<h4"); expect(html).toContain("<strong>"); expect(html).toContain("<pre>");
  expect(html).not.toContain("<script>"); expect(html).not.toContain('href="javascript:'); expect(html).not.toContain("<img");
});
it("supports parentheses in URLs, nested inline formatting, separate lists, and merged blockquotes", () => {
  const html = renderToStaticMarkup(createElement(SafeMarkdown, {
    text: "[Wiki](https://en.wikipedia.org/wiki/A_(b))\n\n**bold with `code`**\n\n- bullet\n1. ordered\n\n> line 1\n> line 2",
  }));
  expect(html).toContain('href="https://en.wikipedia.org/wiki/A_(b)"');
  expect(html).toContain("<strong>bold with <code>code</code></strong>");
  expect(html).toContain("<ul><li>bullet</li></ul><ol><li>ordered</li></ol>");
  expect(html.match(/<blockquote>/g)).toHaveLength(1);
});
it("parses unclosed long markdown links in linear time without backtracking and supports escaped italics", () => {
  const start = performance.now();
  const unclosed = `[Docs](https://example.com/${"a".repeat(80)}`;
  const html = renderToStaticMarkup(createElement(SafeMarkdown, { text: unclosed }));
  expect(performance.now() - start).toBeLessThan(200);
  expect(html).toContain("[Docs](https://example.com/");
  const italic = renderToStaticMarkup(createElement(SafeMarkdown, { text: "*hello \\* world*" }));
  expect(italic).toContain("<em>hello \\* world</em>");
});
it("parses indented fenced code blocks cleanly", () => {
  const html = renderToStaticMarkup(createElement(SafeMarkdown, { text: "  ```json\n  {\"ok\":true}\n  ```" }));
  expect(html).toContain("code-block");
  expect(html).toContain("&quot;ok&quot;:true");
});
