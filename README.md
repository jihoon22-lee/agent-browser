# AgentBrowser (가칭)

기존 OpenCode v1 에이전트가 사용자의 Windows Chrome을 읽고 조작하게 하고,
그 작업을 Chrome 사이드 패널에서 지시·확인·관리하는 도구.

- `extension/` — Chrome Extension (MV3): 탭 제어, 사이드 패널, OpenCode 작업 UI
- `bridge/` — `browser-bridge.exe` (Rust, Windows): `serve` / `mcp` / `doctor`
- `protocol/` — Bridge ↔ Extension 내부 RPC 스키마와 fixture
- `docs/` — 요구사항([handoff](docs/handoff.md)), [상태](docs/status.md), [아키텍처](docs/architecture.md), 계획

현재 단계와 검증 결과는 [docs/status.md](docs/status.md)를 본다.
