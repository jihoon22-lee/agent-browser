using System;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace AgentBrowser.Installer {
    internal static class Pairing {
        /// Chrome derives an extension id from the manifest key: SHA-256 of the DER key, first 16 bytes, hex digits mapped to a-p.
        public static string ExtensionId(string manifestPath) {
            var manifest=NativeIO.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(manifestPath,NativeIO.Utf8));
            byte[] hash;using(var sha=System.Security.Cryptography.SHA256.Create())hash=sha.ComputeHash(Convert.FromBase64String((string)manifest["key"]));
            var id=new System.Text.StringBuilder();
            for(int i=0;i<16;i++){id.Append((char)('a'+(hash[i]>>4)));id.Append((char)('a'+(hash[i]&15)));}
            return id.ToString();
        }
        static IEnumerable<Dictionary<string,object>> Browsers(Dictionary<string,object> status){object value;return status.TryGetValue("browsers",out value)&&value is System.Collections.IEnumerable?((System.Collections.IEnumerable)value).OfType<Dictionary<string,object>>():Enumerable.Empty<Dictionary<string,object>>();}
        public static bool Connected(Dictionary<string,object> status,string extensionId){object paired;return status.TryGetValue("pairedExtensionId",out paired)&&paired as string==extensionId&&Browsers(status).Any(b=>b.ContainsKey("connected")&&b["connected"] is bool&&(bool)b["connected"]);}
        public static bool Seen(Dictionary<string,object> status,string extensionId){object seen;return Connected(status,extensionId)||(status.TryGetValue("extensionSeen",out seen)&&seen as string==extensionId);}
        public static Dictionary<string,object> Status(InstallState state){return NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"status","--json"}));}
    }
    internal static class DoneChecks {
        static IEnumerable<Dictionary<string,object>> Checks(Dictionary<string,object> doctor){object value;return doctor.TryGetValue("checks",out value)&&value is System.Collections.IEnumerable?((System.Collections.IEnumerable)value).OfType<Dictionary<string,object>>():Enumerable.Empty<Dictionary<string,object>>();}
        public static List<string> Lines(Dictionary<string,object> status,Dictionary<string,object> doctor,string extensionId){return Report(status,doctor,extensionId).Lines;}
        public static DoneReport Report(Dictionary<string,object> status,Dictionary<string,object> doctor,string extensionId){
            var report=new DoneReport();var lines=report.Lines;lines.Add("✓ Bridge가 실행 중입니다.");
            object paired;bool known=status.TryGetValue("pairedExtensionId",out paired)&&paired as string==extensionId;
            report.ChromeConnected=Pairing.Connected(status,extensionId);report.NeedsChrome=!report.ChromeConnected;
            // A paired extension that is not connected right now is usually a closed Chrome, or Chrome still reconnecting after an update.
            lines.Add(report.ChromeConnected?"✓ Chrome 확장이 연결되었습니다.":known?"• Chrome이 아직 연결되지 않았습니다. Chrome을 열면 자동으로 연결됩니다.":"✗ Chrome 확장이 연결되지 않았습니다. [Chrome 연결 단계로]를 누르세요.");
            var runtimes=Checks(doctor).Where(c=>c.ContainsKey("id")&&c["id"] as string=="opencode").ToList();
            if(runtimes.Count==0){report.NeedsRuntime=true;lines.Add("✗ 저장된 실행 환경이 없습니다. [OpenCode 설정으로]를 누르세요.");}
            foreach(var check in runtimes){
                string state=check.ContainsKey("status")?check["status"] as string:null;
                if(state!="ok"&&state!="warning")report.NeedsRuntime=true;
                lines.Add(state=="ok"?"✓ 실행 환경이 준비되었습니다.":state=="warning"?"• 실행 환경을 저장했습니다. 패널에서 처음 보낼 때 시작합니다.":"✗ 실행 환경 오류: "+(check.ContainsKey("message")?check["message"]:"")+" — Chrome 설정의 [시작·연결 확인]으로 확인하세요.");
            }
            foreach(var check in Checks(doctor).Where(c=>c.ContainsKey("id")&&c["id"] as string=="mcp"&&c.ContainsKey("status")&&c["status"] as string=="ok"))lines.Add("✓ 브라우저 도구(MCP)가 연결되었습니다.");
            return report;
        }
    }
    /// The final page's checks and the steps that still need the user.
    internal sealed class DoneReport {
        public readonly List<string> Lines=new List<string>();
        public bool ChromeConnected,NeedsChrome,NeedsRuntime;
    }
    /// A read-only message area. Routine text is muted; Fail() marks an error with colour and a ⚠ prefix
    /// (not colour alone), and the next routine text removes the mark.
    internal sealed class Notice : TextBox {
        internal static readonly Color Routine=Color.FromArgb(94,101,112),Good=Color.FromArgb(24,128,74),Danger=Color.FromArgb(168,28,28),DangerBack=Color.FromArgb(253,238,238);
        bool failing;
        public Notice(){Multiline=true;ReadOnly=true;BorderStyle=BorderStyle.None;BackColor=Color.White;ForeColor=Routine;TabStop=false;}
        public override string Text {
            get{return base.Text;}
            set{string text=value??"";if(!failing){BackColor=Color.White;ForeColor=text.StartsWith("✓")?Good:Routine;}base.Text=text;}
        }
        public new void Clear(){Text="";}
        public void Fail(string text){failing=true;try{BackColor=DangerBack;ForeColor=Danger;Text="⚠ "+text;}finally{failing=false;}}
        // A scroll bar only when the text does not fit: an always-on bar beside a one-line result looked broken,
        // and counting line breaks missed a long line that wraps.
        protected override void OnTextChanged(EventArgs e){base.OnTextChanged(e);FitScrollBar();}
        protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);FitScrollBar();}
        protected override void OnFontChanged(EventArgs e){base.OnFontChanged(e);FitScrollBar();}
        void FitScrollBar(){
            int width=Math.Max(1,Width-SystemInformation.VerticalScrollBarWidth-6);
            int needed=TextRenderer.MeasureText(Text.Length==0?" ":Text,Font,new Size(width,Int32.MaxValue),TextFormatFlags.WordBreak|TextFormatFlags.TextBoxControl).Height;
            var wanted=needed>Height?ScrollBars.Vertical:ScrollBars.None;
            if(ScrollBars!=wanted)ScrollBars=wanted;
        }
    }
    /// User-facing installer errors: Korean, with the next action. The original stays for diagnosis.
    internal static class Friendly {
        static readonly KeyValuePair<string,string>[] Known={
            new KeyValuePair<string,string>("Choose an absolute dedicated installation folder","설치 폴더는 전체 경로로 지정하세요. 예: C:\\Users\\<사용자>\\AppData\\Local\\AgentBrowser"),
            new KeyValuePair<string,string>("A drive root cannot be an installation folder","드라이브 최상위(C:\\ 등)에는 설치할 수 없습니다. 전용 하위 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Choose a dedicated subfolder","사용자 폴더 자체가 아닌 AgentBrowser 전용 하위 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Bridge installation must be on a Windows local disk","네트워크 경로에는 설치할 수 없습니다. 로컬 드라이브의 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Bridge installation requires a writable Windows local disk","네트워크 드라이브에는 설치할 수 없습니다. 로컬 드라이브의 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Installation ownership marker is invalid","선택한 폴더의 설치 기록이 손상됐거나 다른 프로그램의 것입니다. 다른 폴더를 선택하거나 diagnose.cmd 결과를 확인하세요."),
            new KeyValuePair<string,string>("An installed file was modified","설치된 파일이 수정되어 그대로 보존했습니다. 파일을 원래대로 되돌리거나 새 폴더에 설치하세요."),
            new KeyValuePair<string,string>("No owned installation was found","이 폴더에서 AgentBrowser 설치를 찾지 못했습니다. [설치]를 선택하거나 기존 설치 폴더를 고르세요."),
            new KeyValuePair<string,string>("Extract the package outside the destination","압축은 설치 폴더가 아닌 다른 폴더에 풀어 주세요."),
            new KeyValuePair<string,string>("An unowned file blocks installation","설치 폴더에 AgentBrowser가 만들지 않은 파일이 있습니다. 빈 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Existing unowned data will not be changed","data 폴더에 다른 데이터가 있어 바꾸지 않았습니다. 빈 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Package checksum mismatch","설치 파일이 손상됐습니다. 공식 릴리스에서 ZIP을 다시 받아 압축을 풀고 실행하세요."),
            new KeyValuePair<string,string>("Extract the complete GUI package","ZIP 전체를 압축 해제한 뒤 그 폴더의 AgentBrowser-Setup.exe를 실행하세요."),
            new KeyValuePair<string,string>("Installation changed after preview","미리보기 이후 설치 상태가 바뀌었습니다. [뒤로]를 눌러 다시 미리보기하세요."),
            new KeyValuePair<string,string>("A file changed after preview","미리보기 이후 파일이 바뀌었습니다. [뒤로]를 눌러 다시 미리보기하세요."),
            new KeyValuePair<string,string>("Settings changed during preview","미리보기 중 OpenCode 설정이 바뀌었습니다. [뒤로]를 눌러 다시 미리보기하세요."),
            new KeyValuePair<string,string>("Port must be between 1 and 65535","포트는 1~65535 사이로 입력하세요."),
            new KeyValuePair<string,string>("Pair the Chrome extension first","먼저 Chrome 연결 단계를 완료하세요."),
            new KeyValuePair<string,string>("No authenticated Bridge","Bridge가 실행 중이 아닙니다. [뒤로] 후 다시 [다음]을 누르면 Bridge를 시작합니다."),
            new KeyValuePair<string,string>("Bridge PID does not belong to this startup","Bridge를 시작하지 못했습니다. 포트를 다른 프로그램이 쓰고 있지 않은지 확인하세요. [뒤로] 후 고급 설정에서 포트를 바꾸거나, 설치 폴더의 diagnose.cmd 결과를 확인하세요."),
            new KeyValuePair<string,string>("Owned Bridge startup","Bridge를 시작하지 못했습니다. 포트를 다른 프로그램이 쓰고 있지 않은지 확인하세요. [뒤로] 후 고급 설정에서 포트를 바꾸거나, 설치 폴더의 diagnose.cmd 결과를 확인하세요."),
            new KeyValuePair<string,string>("Another operation is already managing this profile","같은 실행 환경을 다른 작업이 처리 중입니다. 잠시 후 다시 시도하세요."),
            new KeyValuePair<string,string>("Another installer is using this folder","다른 설치 프로그램이 이 폴더를 사용 중입니다. 끝날 때까지 기다려 주세요."),
            new KeyValuePair<string,string>("mcp.browser belongs to another installation or was changed","OpenCode 설정의 mcp.browser 항목이 다른 설치에 속하거나 직접 수정되어 변경하지 않았습니다."),
            new KeyValuePair<string,string>("The owned mcp.browser entry was removed","등록했던 mcp.browser 항목이 이미 삭제되어 그대로 두었습니다."),
            new KeyValuePair<string,string>("A symbolic link or junction is not supported","심볼릭 링크나 정션 폴더는 지원하지 않습니다. 실제 로컬 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Settings are being edited; no settings were overwritten","OpenCode 설정 파일이 다른 프로그램에서 편집 중이어서 덮어쓰지 않았습니다. 닫은 뒤 다시 시도하세요."),
            new KeyValuePair<string,string>("The selected command did not finish","실행한 명령이 제한 시간 안에 끝나지 않았습니다. WSL 또는 OpenCode 상태를 확인하세요."),
            new KeyValuePair<string,string>("A .cmd launcher path cannot contain cmd metacharacters","실행 파일 경로에 특수문자(&, |, <, >, ^, %, ! 등)가 포함되어 실행할 수 없습니다."),
            new KeyValuePair<string,string>("The Startup shortcut changed; it was preserved","자동 실행 바로 가기가 수정되어 그대로 보존했습니다."),
            new KeyValuePair<string,string>("The selected WSL settings path and distribution do not match","선택한 WSL 설정 파일 경로와 WSL 배포판 이름이 일치하지 않습니다."),
        };
        public static string Message(Exception error) {
            string text=error.Message??"";
            foreach(var item in Known) if(text.IndexOf(item.Key,StringComparison.OrdinalIgnoreCase)>=0) return item.Value+"\r\n(원문: "+text+")";
            return text;
        }
    }
    internal static class Program {
        // Installed maintenance runs outside its owned files so Windows can remove
        // or replace them. Reuse only an exact-hash private per-user maintenance executable.
        internal static void PrepareMaintenanceCache(string cache) {InstallerEngine.Root(cache);InstallerEngine.PrivateDirectory(cache);InstallerEngine.Root(cache);}
        /// Every update leaves one maintenance copy behind under its own hash. Only the current one is needed;
        /// a copy that is still running cannot be deleted and is left for the next run.
        internal static void PruneMaintenanceCache(string cacheRoot,string keepHash) {
            try {
                foreach(string directory in Directory.GetDirectories(cacheRoot)) {
                    string name=Path.GetFileName(directory);
                    if(!System.Text.RegularExpressions.Regex.IsMatch(name,"^[a-fA-F0-9]{64}$")||InstallerEngine.Same(name,keepHash))continue;
                    try{Directory.Delete(directory,true);}catch(Exception){/* In use or not ours to remove: keep it. */}
                }
            } catch(Exception) {/* Housekeeping never blocks maintenance. */}
        }
        static bool RelaunchInstalled(string[] args) {
            string exe=Application.ExecutablePath;var directory=Directory.GetParent(exe);if(directory==null)return false;
            // Legacy scripts put the GUI at the install root; updates retain old
            // versioned GUIs. Any owned running copy would otherwise lock removal.
            string root=directory.Parent!=null&&String.Equals(directory.Parent.Name,"app",StringComparison.OrdinalIgnoreCase)&&directory.Parent.Parent!=null?directory.Parent.Parent.FullName:directory.FullName;
            var state=InstallerEngine.State(root);if(state==null)return false;
            InstallerEngine.Owned(state);string hash=NativeIO.FileHash(exe);
            if(!state.OwnedFiles.Any(f=>InstallerEngine.Same(NativeIO.SafePath(root,f.Path),exe)&&InstallerEngine.Same(f.Sha256,hash)))throw new IOException("Installed setup ownership is invalid.");
            string cache=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AgentBrowser-Setup",hash);PrepareMaintenanceCache(cache);string copy=Path.Combine(cache,"AgentBrowser-Setup.exe");
            if(File.Exists(copy)){NativeIO.PlainPath(copy);if(NativeIO.FileHash(copy)!=hash)throw new IOException("Maintenance setup ownership is invalid.");}
            else {File.Copy(exe,copy);if(NativeIO.FileHash(copy)!=hash)throw new IOException("Maintenance setup verification failed.");}
            PruneMaintenanceCache(Path.GetDirectoryName(cache),hash);
            var forwarded=new List<string>(args);if(!args.Contains("--install-dir"))forwarded.AddRange(new[]{"--install-dir",root});
            using(var child=Process.Start(new ProcessStartInfo(copy,String.Join(" ",forwarded.Select(NativeIO.Quote))){UseShellExecute=false})) {if(child==null)throw new IOException("Could not open installed maintenance.");}
            return true;
        }
        [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool SetProcessDPIAware();
        [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        static void EnableDpiAwareness(){
            try{if(SetProcessDpiAwarenessContext(new IntPtr(-4)))return;}catch(EntryPointNotFoundException){}catch(DllNotFoundException){}
            try{SetProcessDPIAware();}catch(Exception){}
        }
        [STAThread] public static int Main(string[] args) {
            try {
                if(args.Length==2&&args[0]=="--start") {var state=InstallerEngine.State(InstallerEngine.Root(args[1]));if(state==null)throw new IOException("설치 상태를 찾지 못했습니다.");BridgeControl.Start(state);return 0;}
                if(RelaunchInstalled(args))return 0;
                EnableDpiAwareness();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new SetupForm(args));return 0;
            } catch(Exception error) {MessageBox.Show(Friendly.Message(error),"AgentBrowser",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
        }
    }
}

