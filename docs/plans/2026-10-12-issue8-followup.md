# Issue #8 follow-up

원장: https://github.com/jihoon22-lee/agent-browser/issues/8 본문 최종본 §2.
기준 `db397ea`, 브랜치 `feat/issue8-followup`. 기존 완료 계획의 배포 권한은 승계하지 않는다.

요청된 순서대로 과제별 실패 회귀 → 구현 → 영향 검사 → 실제 Windows 검증 → 영어 Conventional Commit을 진행한다.

- [x] WP2: F4 기본값 정규화, F8 편집 내용과 ref identity 분리, F11 포인터 전달 후 unsafe outcome.
- [x] WP1: F1/F2/F3/F16/F12 Stop과 lease 수명. 정상 완료/사용자 중단/MCP operation 취소를 구분하고 패널 없이 완료를 정리한다.
- [x] WP3: F5/F6/F7/F13 및 F10. router 제한 내 snapshot/newTab 결과, 탭 URL과 content OR 대기, 짧은 history no-op 판정.
- [x] WP4: F15/F14. WSL 경로 오류 반환과 MCP 실패 상태의 세부 진단.
- [x] WP5: F9. about:blank close 계약은 유지하고 설명과 오류 메시지를 맞춘다.

실행 결과와 미검증은 `docs/status.md`에 기록한다. push/PR/Release/운영 설치 변경은 요청 범위에 없다.

최종 검증 완료: Extension 370, Rust 전체, Node 28, Linux/Windows E2E 각각 81 통과(각 bookmarks opt-in 2 skipped). 마지막 Chrome 116 alarm 호환성 조정은 빌드와 Windows F16 재검증으로 확인했다. 상세 실패·수정·통과 기록은 status.md를 따른다.
