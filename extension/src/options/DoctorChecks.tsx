import { friendlyError } from "../sidepanel/error-text";
import type { Data } from "../sidepanel/workbench-state";

type Status = "ok" | "warning" | "error" | "info";
type Row = { key: string; label: string; status: Status; summary: string; detail?: string };
const LABELS: Record<string, string> = { bridge: "Bridge", extension: "Chrome 연결", wslPrerequisites: "WSL 준비", executable: "OpenCode 실행 파일", opencode: "OpenCode 서버", mcp: "브라우저 MCP", model: "모델 정보" };
const ICONS: Record<Status, string> = { ok: "✓", warning: "!", error: "✗", info: "i" };
const STATUS_TEXT: Record<Status, string> = { ok: "정상", warning: "확인 필요", error: "오류", info: "참고" };

/** Bridge doctor checks as Korean rows. The original message stays as detail for support. */
export function doctorRows(result: Data, profiles: Data[]): Row[] {
  return (result.checks ?? []).map((check: Data, index: number) => {
    const profile = check.profileId ? profiles.find(item => item.id === check.profileId)?.name ?? check.profileId : "";
    const message = typeof check.message === "string" ? check.message : "";
    let status: Status = ["ok", "warning", "error"].includes(check.status) ? check.status : "warning", summary: string;
    switch (check.id) {
      case "bridge": summary = status === "ok" ? "인증된 Bridge가 실행 중입니다." : "인증된 Bridge를 찾지 못했습니다. Bridge를 시작하세요."; break;
      // The Bridge reports whether the Chrome profile it would control is connected, which may not be this one.
      case "extension": summary = status === "ok" ? "Bridge가 사용할 Chrome 프로필이 인증·연결되어 있습니다." : "Bridge가 사용할 Chrome 프로필이 선택되지 않았습니다. 패널의 브라우저 탭에서 이 브라우저를 선택하세요."; break;
      case "wslPrerequisites": summary = status === "ok" ? "WSL에서 OpenCode를 실행할 준비가 되어 있습니다." : "WSL 실행 준비를 확인하지 못했습니다. 배포판·사용자·interop 설정을 확인하세요."; break;
      case "executable": summary = status === "ok" ? "OpenCode 실행 파일과 작업 디렉터리가 있습니다." : "OpenCode 실행 파일이나 작업 디렉터리를 확인하지 못했습니다. 프로필의 경로를 확인하세요."; break;
      case "opencode": summary = status === "ok" ? "OpenCode 서버가 준비되었습니다." : status === "warning" ? "OpenCode 서버가 실행 중이 아닙니다. 패널을 열거나 [시작·연결 확인]을 누르면 시작합니다." : friendlyError(message).text; break;
      case "mcp": summary = status === "ok" ? "브라우저 MCP가 OpenCode에 연결되어 있습니다." : /not checked/.test(message) ? "OpenCode가 실행 중이 아니어서 확인하지 않았습니다." : "OpenCode가 브라우저 MCP를 사용할 수 없다고 보고했습니다. 원문을 확인하세요."; break;
      case "model":
        // Inference is never tested; reading the model list is the most this check can claim.
        if (typeof check.modelCount === "number" && check.modelCount > 0) { status = "info"; summary = `연결된 모델 ${check.modelCount}개를 확인했습니다. 실제 응답은 보내 보지 않았습니다.`; }
        else summary = typeof check.modelCount === "number" ? "연결된 모델을 찾지 못했습니다. OpenCode의 provider 설정을 확인하세요." : "OpenCode가 실행 중이 아니어서 확인하지 않았습니다.";
        break;
      default: summary = friendlyError(message).text || "결과를 확인하세요.";
    }
    const detail = [message, check.reason].filter(Boolean).join(" · ");
    return { key: `${check.id}:${check.profileId ?? ""}:${index}`, label: `${LABELS[check.id] ?? check.id}${profile ? ` · ${profile}` : ""}`, status, summary, ...(detail ? { detail } : {}) };
  });
}

export function DoctorChecks({ result, profiles }: { result: Data; profiles: Data[] }) {
  return <>
    <p role="status">{result.ok ? "오류 없이 확인을 마쳤습니다." : "오류가 있습니다. 아래 항목을 확인하세요."}</p>
    <ul className="doctor-checks">{doctorRows(result, profiles).map(row => <li key={row.key} className={`doctor-${row.status}`}>
      <span className="doctor-icon" aria-hidden="true">{ICONS[row.status]}</span>
      <div><strong>{row.label}</strong> <span className="doctor-status">{STATUS_TEXT[row.status]}</span><p>{row.summary}</p>{row.detail && <small>{row.detail}</small>}</div>
    </li>)}</ul>
    <details className="doctor-raw"><summary>원본 진단 결과(JSON)</summary><pre className="diagnostic">{JSON.stringify(result, null, 2)}</pre></details>
  </>;
}
