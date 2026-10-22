# 브라우저 품질 측정

실행 결과는 [status.md](./status.md), 수치 요약은 [2026-10-22 측정 기록](./reference/browser-quality-2026-10-22.json)에 있다. 브라우저 자체 지연과 실제 모델의 업무 수행을 별도로 측정한다.

## 합성 브라우저 benchmark

확장·Bridge와 고정된 테스트 의존성을 먼저 빌드한다([테스트 환경](./testing.md)). 저장소 루트에서 실행한다.

```bash
AB_METRICS_RUN=local-before AB_METRICS_SAMPLES=50 pnpm bench:browser
# 제품 수정·재빌드 뒤, 같은 환경에서 실행
AB_METRICS_RUN=local-after AB_METRICS_SAMPLES=50 AB_METRICS_REQUIRE_QUALITY=1 pnpm bench:browser
node tests/e2e/metrics-report.mjs \
  tests/agent/results/browser-metrics/local-before/run.json \
  tests/agent/results/browser-metrics/local-after/run.json \
  tests/agent/results/browser-metrics/local-comparison
```

각 실행 디렉터리에 `run.json`(개별 호출 수치), `summary.json`, `report.html`, `report.md`를 만든다. 비교 디렉터리의 **report.html**을 열면 전후 p50/p95, 실패 수, 실제 상태 검사 결과를 볼 수 있다. 같은 이름의 실행을 덮어쓰지 않는다. 중간에 실패해도 부분 결과와 `complete:false`를 남긴다. 결과는 ignored `tests/agent/results/`에만 저장하며, 원시 웹페이지·입력값·토큰은 브라우저 benchmark JSON에 넣지 않는다.

기본은 Linux Chromium + debug Bridge + DOM 입력이다. Windows는 이미 준비된 네이티브 테스트 폴더에서 Windows Node로 실행한다. WSL/Linux 실행과 섞어 비교하지 않는다.

```powershell
$env:AB_METRICS_RUN='windows-after'
$env:AB_METRICS_SAMPLES='50'
$env:AB_METRICS_REQUIRE_QUALITY='1'
node tests/e2e/windows-run.ts --exe 'C:\<test-directory>\browser-bridge.exe' --extension 'C:\<test-directory>\extension\dist' -- --config metrics.config.ts
```

- **지연:** 탭 목록, fill, 변화 없는 클릭, DOM 변경 클릭, 100/1,000/5,000행 snapshot과 일치 없는 query. 각 workload는 1회 예열 후 기본 50회 측정한다. 실패한 호출도 지연 통계에 포함한다. p95는 nearest-rank 방식이다.
- **정확도:** 합성 페이지의 실제 상태를 독립적으로 확인하는 13개 검사. 입력 유지/원복, 행 재사용, 레이블, disabled, 검색 문맥, 스크롤, 동일 요청 재전송, 중단 후 쓰기, 명시 완료 조건/이동, worker 복구를 검사한다. 도구의 `ok`만으로 성공을 판단하지 않는다. 실행 전 거부가 정답인 시험의 도구 오류는 정확도 실패가 아니다.
- **부가 수치:** 반환 bytes, relay가 관찰한 브라우저 명령·snapshot 왕복 시간, 50ms 이상 long task, heartbeat 왕복, 강제로 종료한 worker의 재연결 시간. 이 값은 DOM 내부 단계별 CPU 프로파일이나 패널 렌더 시간은 아니다. long task는 콜백 전달 시점 때문에 누락될 수 있다.
- **비교 조건:** platform/arch, 브라우저 버전, headless, 입력 방식, Bridge debug/release, fixture 해시가 같고 양쪽 수집이 완료돼야 변화율을 계산한다. 이 조건만으로 OS 부하·열 상태까지 통제되지는 않는다. 별도 환경과 단일 표본의 품질 검사를 성능 SLA로 해석하지 않는다.
- **신뢰 입력:** `AB_METRICS_TRUSTED=1`로 별도 측정한다. DOM 입력 결과와 합치지 않는다. 이번 기록의 반복 benchmark는 DOM 입력이다.

CI는 Linux/Windows 각각 5회 표본과 정확도 gate를 실행하고 숫자·HTML artifact를 14일 보존하도록 구성했다. 5회 p95는 빠른 회귀 탐색용이다. 현재 원격 CI 실행 여부는 status에 따로 기록한다.

## 드래그 완료 조건 반복 측정

빌드 후 `AB_ACTION_SAMPLES`로 P06의 포인터 정렬·HTML5 drop 반복 수를 지정한다(1~50, 기본 1). 각 입력 방식은 독립된 시험이며 한 번 예열한 뒤 측정한다.

```bash
AB_ACTION_SAMPLES=50 pnpm --filter agent-browser-e2e exec playwright test pointer-keys-upload.spec.ts --grep 'P06 DOM'
AB_ACTION_SAMPLES=50 pnpm --filter agent-browser-e2e exec playwright test pointer-keys-upload.spec.ts --grep 'P06 trusted'
```

표준 출력의 `DRAG METRICS` JSON에 개별 시간·p50/p95·브라우저/Node 버전이 남는다. 매 반복에서 실제 순서/drop 결과와 이벤트 1회 실행을 검사한다. 이 시험은 위 benchmark의 자동 보고서 디렉터리를 생성하지 않는다. [2026-10-22 후속 기록](./reference/browser-quality-followup-2026-10-22.json)은 이 출력에서 수집한 DOM 입력 전후 50표본을 보존한다.

## 실제 모델 업무 평가

기존 [OpenCode runner](../tests/agent/run-agent.mjs)에 `--task-mode goal`을 추가했다. 모델에 검색·첫 결과 새 탭 열기·표 요약·원래 탭 복귀·제어 해제라는 목표만 주며, 특정 도구 순서를 요구하지 않는다. 기존 순서 지정 검사는 `--task-mode guided`(기본값)로 유지한다.

Linux의 빈 임시 브라우저·Bridge·fixture를 자동으로 준비하는 명령:

```bash
AB_OPENCODE=/absolute/path/to/opencode \
AB_METRICS_MODEL=opencode/<verified-free-model> \
AB_MODEL_RUNS=3 AB_MODEL_TIMEOUT_MS=180000 pnpm eval:browser
```

Windows의 격리 demo는 [testing.md](./testing.md)의 준비 절차 후 `run-agent.sh`/`run-agent.mjs`에 `--task-mode goal`을 추가한다. 검증한 설치본 OpenCode v1 버전은 1.18.29와 1.19.3이다. 전역 설정·다른 MCP·인증정보를 상속하지 않으며, 매 실행 전에 공식 무료 가격·현재 모델 목록·설치본 도구 호출 metadata를 확인한다. HTTP 403/한도/비무료 비용/불확실한 가격에서는 중단한다. 유료 모델로 대체하지 않는다.

각 결과 폴더의 `metrics.json`과 `report.html`에서 업무 정답, CLI 시작~종료 시간, 모델 step, 고유 도구 호출, 명시/연속 snapshot, 오류, 도구 시간 합계, 출력 bytes, input/output/reasoning/cache 토큰을 본다. 공급자가 보고한 total만 합산하며, 토큰 항목을 임의로 더해 total을 만들지 않는다. 누락된 usage·시간은 `null`/미측정이다. 도구 시간 합계는 추론 시간 추정치가 아니다.

검색 서버 로그, 실제 성공한 읽기 결과, 독립된 마지막 탭 목록, 확인된 상세 탭 닫기, 복귀·해제 결과, 요약의 합성 정답을 채점한다. 실행 순서가 달라도 같은 목표를 달성하면 인정한다. runner가 나중에 수행한 정리는 모델 점수에 넣지 않는다. 원시 합성 모델 JSONL은 ignored 디렉터리에만 보관하고 CI/Release에 게시하지 않는다. 공급자가 도구 실행 전에 거부한 실행은 모델 성공률이나 토큰 절감의 근거가 아니다.

## 수집기 회귀 검사

```bash
pnpm test:metrics
node --test tests/agent/runner.test.mjs tests/agent/runner-process.test.mjs
```

percentile·실패 포함·환경 불일치·HTML escaping·누락 수치·이벤트 중복·여러 도구 경로의 정답·격리 및 무료 가격 경계를 합성 데이터로 검사한다. 실제 모델을 부르지 않는다.
