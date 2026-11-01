// Bridge, runtime and network failures arrive as English protocol text. The panel and Options show a
// Korean explanation with the next step and keep the original text for support.
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Bridge is not connected|^Bridge connection closed/, "Bridge에 연결되어 있지 않습니다. Windows에서 Bridge가 실행 중인지 확인한 뒤 다시 연결하세요."],
  [/^Bridge returned an error without details/, "Bridge가 오류 내용을 보내지 않았습니다. 설정의 연결 진단을 실행하세요."],
  [/mutual authentication|authentication verification failed|server proof is invalid/, "Bridge와 상호 인증하지 못했습니다. 설정에서 다시 페어링하세요."],
  [/did not become ready within 60 seconds/, "OpenCode가 60초 안에 준비되지 않았습니다. 설정의 연결 진단으로 실행 파일·버전, 포트, WSL localhost 전달, 작업 디렉터리를 확인하세요."],
  [/^Cannot launch OpenCode;/, "OpenCode를 실행하지 못했습니다. 설정에서 실행 파일 경로·작업 디렉터리·추가 환경변수를 확인하세요."],
  [/browser MCP is not connected/, "OpenCode는 실행됐지만 브라우저 MCP가 연결되지 않았습니다. WSL interop과 Bridge 실행 파일 위치를 확인하세요."],
  [/browser MCP initialization did not finish/, "OpenCode는 실행됐지만 브라우저 MCP 준비가 끝나지 않았습니다. 잠시 후 다시 시도하세요."],
  [/needs its browser MCP configuration refreshed/, "브라우저 MCP 설정을 새로 적용해야 합니다. 설정에서 이 실행 환경의 서버를 중지한 뒤 다시 연결하세요. 지금 서버는 계속 실행 중입니다."],
  [/^Missing OpenCode executable/, "OpenCode 실행 파일 경로를 입력하세요."],
  [/^OpenCode is not reachable/, "OpenCode 서버에 연결할 수 없습니다. 서버 주소와 실행 상태를 확인하세요."],
  [/^OpenCode connection failed/, "OpenCode에 연결하지 못했습니다. 서버 주소·시스템 프록시·인증서를 확인하세요."],
  [/^OpenCode health returned HTTP 40[13]\b/, "OpenCode 인증에 실패했습니다. 설정에서 인증 사용자와 비밀번호를 확인하세요."],
  [/^Only OpenCode v1 is supported|required OpenCode v1 APIs|v1 API discovery failed/, "이 서버에서 OpenCode v1 API를 찾지 못했습니다. OpenCode 1.x 서버인지 확인하세요."],
  [/^Another operation is already managing this profile/, "다른 작업이 이 실행 환경을 처리하는 중입니다. 끝난 뒤 다시 시도하세요."],
  [/port is already occupied/, "지정한 포트를 다른 프로그램이 사용하고 있습니다. 설정에서 다른 포트를 고르거나 비워 두세요."],
  [/port is reserved by another managed profile/, "지정한 포트를 다른 실행 환경이 쓰고 있습니다. 다른 포트를 고르거나 비워 두세요."],
  [/must be on a Windows drive for WSL profiles/, "WSL 실행 환경을 쓰려면 Bridge가 Windows 드라이브(예: C:)에 설치되어 있어야 합니다."],
  [/^Stop the managed runtime before editing its profile/, "프로필을 고치기 전에 이 실행 환경의 서버를 중지하세요."],
  [/^This profile id already exists/, "같은 ID의 프로필이 이미 있습니다. 다른 ID를 쓰세요."],
  [/^Unknown runtime profile/, "선택한 실행 환경을 찾을 수 없습니다. 실행 환경을 다시 선택하세요."],
  [/Run diagnose\.cmd in the installation folder/, "WSL 서버가 멈췄는지 확인하지 못해 기록을 유지했습니다. 설치 폴더의 diagnose.cmd를 실행하세요."],
  [/^Failed to fetch|^NetworkError/, "OpenCode 서버에 연결할 수 없습니다. 서버가 멈췄다면 다시 시도하세요."],
  [/signal timed out|aborted due to timeout/i, "OpenCode가 제한 시간 안에 응답하지 않았습니다. 잠시 후 다시 시도하세요."],
];

export function friendlyError(message: string): { text: string; original?: string } {
  for (const [pattern, text] of RULES) if (pattern.test(message)) return { text, original: message };
  return { text: message };
}
