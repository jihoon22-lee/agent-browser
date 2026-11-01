// Korean names for tool cards and the browser timeline. The raw tool name stays visible next to them.
const BROWSER_TOOLS: Record<string, string> = {
  browser_tabs: "탭 관리", browser_bookmarks: "북마크 읽기", browser_snapshot: "페이지 읽기", browser_navigate: "페이지 이동",
  browser_click: "클릭", browser_fill: "텍스트 입력", browser_select: "항목 선택", browser_press: "키 입력",
  browser_scroll: "스크롤", browser_wait: "조건 대기", browser_extract: "내용 추출", browser_screenshot: "화면 캡처",
  browser_pointer: "화면 좌표 조작", browser_dialog: "대화상자 응답", browser_downloads: "다운로드 확인", browser_upload: "파일 올리기",
};
const OPENCODE_TOOLS: Record<string, string> = {
  bash: "셸 명령", read: "파일 읽기", edit: "파일 수정", write: "파일 쓰기", grep: "내용 검색", glob: "파일 찾기",
  list: "폴더 목록", webfetch: "웹 가져오기", todowrite: "할 일 갱신", todoread: "할 일 읽기", task: "하위 작업",
};

/** OpenCode prefixes MCP tools with the server name (`browser_browser_click`), so browser tools match by suffix. */
export function toolLabel(tool: string | undefined): string | undefined {
  if (!tool) return undefined;
  if (OPENCODE_TOOLS[tool]) return OPENCODE_TOOLS[tool];
  for (const [name, label] of Object.entries(BROWSER_TOOLS)) if (tool === name || tool.endsWith(`_${name}`)) return label;
  return undefined;
}

/** Timeline outcomes are "ok" or a protocol error code; the code is kept for diagnosis. */
export const outcomeLabel = (outcome: string) => outcome === "ok" ? "성공" : `실패 · ${outcome}`;
