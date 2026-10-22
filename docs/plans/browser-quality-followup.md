# 브라우저 품질 후속 — 연결 경합과 클릭 관찰

상태: 드래그 개선·Linux 검증 완료, B10 원인 조사 미해결(2026-10-22). 이전 측정 계획은 완료했으며 이 문서가 후속 작업 원장이다. 요구사항은 `docs/handoff.md`, 실제 결과는 `docs/status.md`를 따른다. 로컬 실행은 사용자의 Linux 검증 범위를 유지하며, 후속 요청에 따라 push·PR·원격 CI·merge까지 진행한다.

- [x] B10 간헐 timeout을 리뷰 회귀 중 재현했다. 새 탭 snapshot·relay·heartbeat는 정상인 상태에서 첫 iframe 표시 확인이 멈췄다. 최초 renderer/관찰 정지 원인은 미확인이다.
- [ ] 원인이 확인되면 실패 회귀 검사부터 수정한다. 근거 없이 timeout을 늘리거나 재시도로 숨기지 않는다.
- [x] 일반 클릭의 두 관찰 구간을 검토했다. 명시 조건 없는 클릭은 지연 이동 계약 때문에 유지하고, `waitFor` 드래그에 남아 있던 500ms 대기를 제거해 전후 50회 측정했다.
- [x] 직접 영향받는 테스트, 마지막 전체 Linux 회귀 및 수치·제약 기록을 완료하고 과제별 Conventional Commit을 만들었다.
- [x] B10 실패 시 새 탭 snapshot 오류, 시험 단계, frame 상태, relay timing을 남기고 빠른 heartbeat 실험 옵션을 추가했다. 완료된 50회 게시판 반복은 450 통과/50 제외였으나 원인은 확인하지 못했다.
- [x] [PR #37](https://github.com/jihoon22-lee/agent-browser/pull/37)을 만들고 첫 Linux/Windows CI 성공 및 13/13 품질 artifact를 확인했다.
- [x] 리뷰에서 발견한 반응형 입력 확인·iframe의 최상위 이동 완료 조건을 단위/실제 브라우저 실패 검사부터 수정했다.

최종 커밋 CI와 main 병합 상태는 PR checks·병합 이력을 따른다. B10 원인 수정은 완료로 표시하지 않는다.

로컬 Windows 실행·유료 모델·전역 OpenCode 설정·Release는 이 후속 범위에 추가하지 않는다. 원격 Windows CI와 로컬 WSL interop 검증은 구분한다. 모델 403은 제공자 상태가 달라졌다는 근거 없이 반복 호출하지 않는다.
