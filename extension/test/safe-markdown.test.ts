import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeMarkdown } from "../src/sidepanel/SafeMarkdown";
it("renders markdown without executing raw HTML or javascript links", () => {
  const html = renderToStaticMarkup(createElement(SafeMarkdown, { text: "# 제목\n\n**굵게** [링크](https://example.test) [위험](javascript:alert(1))\n<script>alert(1)</script>\n\n```js\nconst x = '<img onerror=alert(1)>';\n```" }));
  expect(html).toContain("<h1>"); expect(html).toContain("<strong>"); expect(html).toContain("<pre>");
  expect(html).not.toContain("<script>"); expect(html).not.toContain('href="javascript:'); expect(html).not.toContain("<img");
});
