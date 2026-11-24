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
