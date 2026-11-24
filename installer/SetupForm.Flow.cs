using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace AgentBrowser.Installer {
    internal sealed partial class SetupForm {
        async Task DetectExtension(){
            if(page!=4||detecting||IsDisposed||Disposing)return;detecting=true;bool advance=false;
            try{
                // Never hash every installed file on the UI thread per tick: the page verified the
                // installation when it opened. Without that result, verify once in the background.
                if(detectionState==null||detectionExtensionId==null){
                    string selected=folder.Text;
                    var verified=await Task.Run(()=>{var checkedState=Verified(selected);return new KeyValuePair<InstallState,string>(checkedState,Pairing.ExtensionId(Path.Combine(checkedState.InstallDir,"extension","manifest.json")));});
                    if(page!=4||IsDisposed||Disposing)return;
                    detectionState=verified.Key;detectionExtensionId=verified.Value;
                }
                var state=detectionState;string id=detectionExtensionId;
                // Starting (or verifying) the Bridge hashes files and queries processes: once per page visit.
                // One attempt per page visit, successful or not: a failing start must not be repeated every tick.
                if(!detectionBridgeStarted){detectionBridgeStarted=true;await Task.Run(()=>BridgeControl.Start(state));if(page!=4||IsDisposed||Disposing)return;}
                var current=await Task.Run(()=>BridgeStatus(state));
                if(IsDisposed||Disposing)return;
                if(page==4&&Pairing.Seen(current,id)){
                    advance=connectionAuto;connectionAuto=false;
                    extensionDetected.ForeColor=Notice.Good;extensionDetected.Text="✓ Chrome에 AgentBrowser 확장이 추가되었습니다."+(advance?"":" [다음]을 누르세요.");
                }
            }catch(Exception){/* Detection is only a hint; the next step reports real errors. */}
            finally{detecting=false;}
            if(advance&&page==4&&!IsDisposed&&!Disposing){
                await PreparePairing();
                // The step could not be opened (its error is in the status line): leave the manual way visible.
                if(page==4&&!IsDisposed&&!Disposing)extensionDetected.Text+=" [다음]을 누르세요.";
            }
        }
        async Task OpenPairingCode(CancellationTokenSource wait,InstallState verifiedState,string id,bool bridgeStarted=false){
            if(!bridgeStarted)await Task.Run(()=>BridgeControl.Start(verifiedState));
            var opened=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(verifiedState,new[]{"pair","--open","--extension-id",id,"--seconds","180"})));
            // The user may have left the page or asked for another code meanwhile: show nothing and open nothing.
            if(wait.IsCancellationRequested||page!=5||IsDisposed)return;
            string code=(string)opened["code"];
            pairingCode.Text=code.Substring(0,3)+" "+code.Substring(3);
            pairingState.Text="3분 동안 유효합니다. 설정 화면이 열리지 않으면 Chrome의 확장 세부정보 → 확장 프로그램 옵션을 여세요.";
            string chrome=ChromePath();
            if(chrome!=null&&!Has(args,"--no-browser-launch"))try{Process.Start(new ProcessStartInfo(chrome,"chrome-extension://"+id+"/src/options/index.html"){UseShellExecute=false});}catch(Exception){/* The user can open Options manually. */}
        }
        Task ConnectChrome(){return ConnectChromeWith(null,false);}
        async Task ConnectChromeWith(InstallState verifiedState,bool bridgeStarted){
            // Waiting for Chrome is not an installer operation: it never takes `working`,
            // so the wizard stays usable and leaving this page or closing stops it.
            CancelPairingWait();
            var wait=new CancellationTokenSource();pairingWait=wait;bool connected=false;
            try{
                pairingCode.Text="";pairingState.Text="코드를 준비하고 있습니다…";
                string selectedFolder=folder.Text;
                var state=verifiedState??await Task.Run(()=>Verified(selectedFolder));
                if(wait.IsCancellationRequested||IsDisposed||Disposing)return;
                string id=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
                if(!bridgeStarted)await Task.Run(()=>BridgeControl.Start(state));
                if(wait.IsCancellationRequested||IsDisposed||Disposing)return;
                if(Pairing.Connected(await Task.Run(()=>BridgeStatus(state)),id))connected=true;
                else if(!wait.IsCancellationRequested&&!IsDisposed&&!Disposing){
                    await OpenPairingCode(wait,state,id,bridgeStarted:true);
                    var deadline=DateTime.UtcNow.AddSeconds(180);
                    for(int i=0;i<180&&!wait.IsCancellationRequested&&!IsDisposed&&!Disposing;i++){
                        var remaining=(int)Math.Ceiling((deadline-DateTime.UtcNow).TotalSeconds);
                        if(remaining>0)pairingState.Text=String.Format("남은 시간: {0}:{1:D2} · 설정 화면이 열리지 않으면 Chrome의 확장 세부정보 → 확장 프로그램 옵션을 여세요.",remaining/60,remaining%60);
                        var current=await Task.Run(()=>BridgeStatus(state));
                        if(wait.IsCancellationRequested||IsDisposed||Disposing)break;
                        if(Pairing.Connected(current,id)){connected=true;break;}
                        if(DateTime.UtcNow>=deadline)break;
                        try{await Task.Delay(1000,wait.Token);}catch(TaskCanceledException){break;}
                    }
                }
                if(!IsDisposed&&!Disposing){
                    if(connected){pairingState.Text="✓ Chrome과 연결되었습니다.";pairingCode.Text="";}
                    else if(!wait.IsCancellationRequested){pairingCode.Text="";pairingState.Fail("연결을 확인하지 못했습니다. [코드 다시 받기]를 눌러 새 코드를 입력하거나, 아래 토큰을 직접 입력하세요.");}
                }
            }catch(Exception error){if(!wait.IsCancellationRequested&&!IsDisposed&&!Disposing)pairingState.Fail(Friendly.Message(error));}
            finally{if(pairingWait==wait)pairingWait=null;wait.Dispose();}
            if(connected&&page==5&&!IsDisposed&&!Disposing){SetPage(6);status.Clear();await EnterRuntimePage();}
        }
        async Task RunDoneChecks(){
            int run=++doneRun;
            MarkDone(true);doneChecks.Items.Clear();doneChecks.Items.Add("연결 상태를 확인하고 있습니다…");fixChrome.Visible=fixRuntime.Visible=false;recheck.Enabled=false;
            try{
                string selectedFolder=folder.Text;
                var state=await Task.Run(()=>Verified(selectedFolder));
                if(IsDisposed||doneChecks.IsDisposed||run!=doneRun)return;
                string id=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
                var current=await Task.Run(()=>BridgeStatus(state));
                var doctor=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"doctor","--json"},60000)));
                // The wizard may have closed or moved on while the checks ran.
                if(IsDisposed||doneChecks.IsDisposed||run!=doneRun)return;
                var report=DoneChecks.Report(current,doctor,id);ShowDone(report);
                // After an update Chrome reconnects by itself within its retry interval: keep that line current for a minute.
                for(int i=0;i<30&&!report.ChromeConnected;i++){
                    await Task.Delay(2000);
                    if(IsDisposed||doneChecks.IsDisposed||run!=doneRun)return;
                    try{current=await Task.Run(()=>BridgeStatus(state));}catch(Exception){continue;}
                    if(IsDisposed||doneChecks.IsDisposed||run!=doneRun)return;
                    report=DoneChecks.Report(current,doctor,id);if(report.ChromeConnected)ShowDone(report);
                }
            }catch(Exception error){
                if(IsDisposed||doneChecks.IsDisposed||run!=doneRun)return;
                doneChecks.Items.Clear();doneChecks.Items.Add("✗ "+Friendly.Message(error));MarkDone(false);recheck.Enabled=true;
            }
        }
        void ShowDone(DoneReport report){
            doneChecks.Items.Clear();foreach(var line in report.Lines)doneChecks.Items.Add(line);
            fixChrome.Visible=report.NeedsChrome;fixRuntime.Visible=report.NeedsRuntime;recheck.Enabled=true;
            MarkDone(!report.Lines.Any(line=>line.StartsWith("✗")));
        }
        /// The large mark and title must not announce success above a failed check.
        void MarkDone(bool finished){
            complete.Text=finished?"설정이 끝났습니다.":"설정을 마무리하세요.";
            doneMark.Text=finished?"✓":"!";doneMark.ForeColor=finished?Notice.Good:Notice.Danger;
            if(page==7&&operation.SelectedIndex!=2)steps.Text=finished?"AgentBrowser를 사용할 준비가 되었습니다.":"아래 항목을 확인하세요.";
        }
        bool InstalledHere(){try{return InstallerEngine.State(folder.Text)!=null;}catch(Exception){return false;}}
        async Task EnterRuntimePage(){
            await RefreshSavedProfiles();
            if(!runtimeDiscovered&&!Has(args,"--no-discover")){runtimeDiscovered=true;await DiscoverRuntime(null);}
        }
        async Task RefreshSavedProfiles(){
            try{
                string selectedFolder=folder.Text;
                var state=await Task.Run(()=>Verified(selectedFolder));
                if(IsDisposed||Disposing||savedProfiles.IsDisposed)return;
                var listed=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"profile","list","--json"})));
                if(IsDisposed||Disposing||savedProfiles.IsDisposed)return;
                savedProfiles.Items.Clear();object def;listed.TryGetValue("defaultProfileId",out def);
                foreach(var item in ((System.Collections.IEnumerable)listed["profiles"]).OfType<Dictionary<string,object>>())
                    savedProfiles.Items.Add((item["id"] as string==def as string?"★ ":"")+item["name"]+" · "+item["kind"]+" · "+item["directory"]);
                if(savedProfiles.Items.Count==0)savedProfiles.Items.Add("아직 없습니다");
            }catch(Exception error){if(!IsDisposed&&!Disposing)runtimeResult.Fail(Friendly.Message(error));}
        }
        /// The distribution [배포판 켜고 찾기] starts: the typed name, else the first one found stopped.
        /// A running distribution is never restarted for an empty field.
        internal static string DistributionToStart(string typed,IEnumerable<string> found,IEnumerable<string> stopped){
            var name=(typed??"").Trim();
            if(name.Length>0)return name;
            var off=new HashSet<string>(stopped,StringComparer.OrdinalIgnoreCase);
            return found.FirstOrDefault(off.Contains);
        }
        readonly List<string> stoppedDistributions=new List<string>();
        /// The discovery result line; stopped-distribution notices are always shown.
        internal static string DiscoveryMessage(int candidates,IEnumerable<string> notices){
            string text=candidates>0?"OpenCode "+candidates+"개를 찾았습니다. 확인 후 [저장하고 연결 확인]을 누르세요.":"OpenCode를 찾지 못했습니다. 실행 파일 경로를 직접 입력하세요.";
            var extra=notices.Where(n=>!String.IsNullOrWhiteSpace(n)).ToList();
            return extra.Count>0?text+"\r\n"+String.Join("\r\n",extra):text;
        }
        async Task DiscoverRuntime(string distribution){
            if(discoveringRuntime)return;discoveringRuntime=true;
            startDistribution.Enabled=false;rediscoverRuntime.Enabled=false;runtimeResult.Text="OpenCode 위치를 확인하고 있습니다…";
            try{
                var explicitStart=distribution!=null;
                var name=explicitStart?DistributionToStart(distribution,runtimeDistribution.Items.Cast<object>().Select(i=>i.ToString()),stoppedDistributions):null;
                if(explicitStart&&name==null){runtimeResult.Fail("켜고 찾을 WSL 배포판 이름을 입력하세요.");return;}
                var found=await Task.Run(()=>{
                    if(!explicitStart)return Discovery.Find();
                    // A stopped distribution may take a while to boot.
                    var single=new DiscoveryResult();single.Distributions.Add(name);single.OpenCode.AddRange(Discovery.FindWsl(name,null,60000));return single;
                });
                if(IsDisposed||Disposing)return;
                foreach(var d in found.Distributions)if(!runtimeDistribution.Items.Cast<object>().Any(x=>String.Equals(x.ToString(),d,StringComparison.OrdinalIgnoreCase)))runtimeDistribution.Items.Add(d);
                if(!explicitStart){stoppedDistributions.Clear();stoppedDistributions.AddRange(found.Stopped);}
                else stoppedDistributions.RemoveAll(d=>String.Equals(d,name,StringComparison.OrdinalIgnoreCase));
                if(explicitStart)runtimeDistribution.Text=name;
                runtimeCandidates.Items.Clear();foreach(var c in found.OpenCode)runtimeCandidates.Items.Add(c);
                if(runtimeCandidates.Items.Count>0)runtimeCandidates.SelectedIndex=0;
                runtimeResult.Text=DiscoveryMessage(runtimeCandidates.Items.Count,found.Notices);
            }catch(Exception error){if(!IsDisposed&&!Disposing)runtimeResult.Fail(Friendly.Message(error));}
            finally{discoveringRuntime=false;if(!IsDisposed&&!Disposing){rediscoverRuntime.Enabled=true;SyncRuntimeMode();}}
        }
        void UseRuntimeCandidate(){
            var c=runtimeCandidates.SelectedItem as OpenCodeCandidate;if(c==null)return;
            runtimeKind.SelectedIndex=c.Kind=="wsl"?1:0;runtimeDistribution.Text=c.Distribution??"";runtimeExecutable.Text=c.Executable;
            // A Windows home left over from another candidate is not a valid WSL work folder (and vice versa).
            if(String.IsNullOrWhiteSpace(runtimeDirectory.Text)||runtimeDirectory.Text==suggestedRuntimeDirectory){runtimeDirectory.Text=c.Home;suggestedRuntimeDirectory=c.Home;}
        }
        /// The discovered WSL user is reused only for the same distribution and executable it was found with.
        internal static string RuntimeUser(OpenCodeCandidate chosen,string kind,string distribution,string executable){
            return chosen!=null&&kind=="wsl"&&chosen.Kind=="wsl"&&chosen.Executable==executable&&String.Equals(chosen.Distribution,distribution,StringComparison.OrdinalIgnoreCase)?chosen.User:null;
        }
        async Task SaveRuntime(){
            if(working)return;working=true;saveRuntime.Enabled=false;prepare.Enabled=false;back.Enabled=false;runtimeResult.Text="실행 환경을 확인하고 있습니다…";
            try{
                string selectedFolder=folder.Text;
                var chosen=runtimeCandidates.SelectedItem as OpenCodeCandidate;
                var candidate=new OpenCodeCandidate{Kind=runtimeKind.SelectedIndex==1?"wsl":"windows",Distribution=runtimeDistribution.Text.Trim(),Executable=runtimeExecutable.Text.Trim()};
                candidate.User=RuntimeUser(chosen,candidate.Kind,candidate.Distribution,candidate.Executable);
                string directory=runtimeDirectory.Text.Trim();
                var state=await Task.Run(()=>Verified(selectedFolder));
                if(IsDisposed||Disposing)return;
                bool replace=savedRuntimeId!=null,save=true;
                string id=savedRuntimeId,name=candidate.Kind=="wsl"?"OpenCode ("+candidate.Distribution+")":"OpenCode (Windows)";
                if(id==null) {
                    // An earlier wizard run may have saved this same runtime: reuse it instead of adding another.
                    var listed=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"profile","list","--json"})));
                    if(IsDisposed||Disposing)return;
                    var same=ManagedProfile.FindSame(listed,candidate,directory);
                    if(same!=null) {
                        id=(string)same["id"];replace=true;object value;
                        if(same.TryGetValue("name",out value)&&!String.IsNullOrWhiteSpace(value as string))name=(string)value;
                        if(String.IsNullOrEmpty(candidate.User)&&same.TryGetValue("user",out value))candidate.User=value as string;
                        // Already the default: nothing to write. Otherwise rewrite only when no other setting would be lost.
                        save=!(listed.TryGetValue("defaultProfileId",out value)&&value as string==id)&&ManagedProfile.WizardCanRewrite(same);
                    } else id="managed-"+Guid.NewGuid().ToString("N").Substring(0,8);
                }
                var profile=await Task.Run(()=>ManagedProfile.Prepare(state,candidate,id,name,directory,replace));
                if(save)await Task.Run(()=>ManagedProfile.Save(state,profile,makeDefault:true,replace:replace));
                if(IsDisposed||Disposing)return;
                savedRuntimeId=id;
                await RefreshSavedProfiles();
                if(IsDisposed||Disposing)return;
                if(Has(args,"--no-runtime-start")){runtimeResult.Text="✓ 저장했습니다. (시작 확인 생략)";return;}
                runtimeResult.Text="저장했습니다. OpenCode를 시작해 브라우저 연결을 확인하고 있습니다… (최대 2분 30초)";
                string started=await Task.Run(()=>ManagedProfile.Start(state,id));
                if(IsDisposed||Disposing)return;
                if(started.StartsWith("✓"))runtimeResult.Text=started;else runtimeResult.Fail(started);
            }catch(Exception error){if(!IsDisposed&&!Disposing)runtimeResult.Fail(Friendly.Message(error));}
            finally{working=false;if(!IsDisposed&&!Disposing){saveRuntime.Enabled=true;prepare.Enabled=true;back.Enabled=true;}}
        }
        void LoadState(){
            manage.Enabled=false;
            try{var old=InstallerEngine.State(folder.Text);bool changed=!InstallerEngine.Same(loadedFolder,folder.Text);if(old!=null){if(changed){if(operation.SelectedIndex!=2)operation.SelectedIndex=1;port.Value=Math.Max(1,Math.Min(65535,old.Port));startup.Checked=old.Startup!=null;if(old.Startup!=null)startupPath.Text=Path.GetDirectoryName(old.Startup.Path);}manage.Enabled=operation.SelectedIndex!=2;status.Text="기존 설치 "+old.Version+"을 찾았습니다.";}else{if(operation.SelectedIndex==1)operation.SelectedIndex=0;status.Clear();}loadedFolder=folder.Text;}catch(Exception error){status.Fail(Friendly.Message(error));}
        }
        InstallState Installed(){return Verified(folder.Text);}
        /// Full verification of the selected installation; reads and hashes every owned file.
        static InstallState Verified(string selected){
            var state=InstallerEngine.State(selected);if(state==null)throw new IOException("아직 설치되지 않았습니다. [다음]을 눌러 설치를 완료하세요.");
            InstallerEngine.Root(selected);InstallerEngine.Owned(state);
            var extensionFiles=state.OwnedFiles.Where(file=>file.Path.Replace('\\','/').StartsWith("extension/",StringComparison.OrdinalIgnoreCase)).ToArray();
            if(!extensionFiles.Any(file=>InstallerEngine.Same(file.Path.Replace('\\','/'),"extension/manifest.json")))throw new IOException("설치 기록에 Chrome 확장이 없습니다. 설치 폴더를 확인하세요.");
            foreach(var file in extensionFiles){string path=NativeIO.SafePath(state.InstallDir,file.Path);if(!File.Exists(path))throw new IOException("Chrome 확장 파일이 없습니다. 업데이트로 복구한 뒤 연결하세요: "+path);}
            return state;
        }
        /// Verifies the selected installation and fills in the Chrome steps. Does not change the page.
        InstallState PrepareConnection(){
            if(operation.SelectedIndex==2)throw new IOException("제거하려면 [다음]을 눌러 진행하세요. 연결 설정은 설치 또는 업데이트에서 열 수 있습니다.");
            var state=Installed();extensionFolder.Text=Path.Combine(state.InstallDir,"extension");
            detectionState=state;detectionExtensionId=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
            return state;
        }
        /// Opens the Chrome extension step going forward.
        bool EnterConnection(){
            try{PrepareConnection();}catch(Exception error){status.Fail(Friendly.Message(error));return false;}
            SetPage(4);connectionAuto=true;WaitForExtension();return true;
        }
        /// The first setup step that still needs the user: 4 add the extension, 6 choose OpenCode, 7 nothing left.
        /// An extension that is already paired is not paired again, and a saved default runtime is not asked for again.
        internal static int ResumePage(Dictionary<string,object> status,Dictionary<string,object> listed,string extensionId){
            object paired=null,chosen=null,profiles=null;
            if(!status.TryGetValue("pairedExtensionId",out paired)||paired as string!=extensionId)return 4;
            if(listed==null||!listed.TryGetValue("defaultProfileId",out chosen)||String.IsNullOrEmpty(chosen as string)||!listed.TryGetValue("profiles",out profiles)||!(profiles is System.Collections.IEnumerable))return 6;
            string id=(string)chosen;
            return ((System.Collections.IEnumerable)profiles).OfType<Dictionary<string,object>>().Any(p=>p.ContainsKey("id")&&p["id"] as string==id)?7:6;
        }
        /// After installing, and from [기존 설치의 연결 설정]: opens the first step that still needs the user,
        /// so an update does not walk a finished setup through every step again. Returns the failure, or null.
        async Task<string> OpenSetup(){
            int from=page;InstallState state;
            try{state=PrepareConnection();}catch(Exception error){string failure=Friendly.Message(error);status.Fail(failure);return failure;}
            int target=4;string id=detectionExtensionId;bool started=false;
            manage.Enabled=false;status.Text="연결 상태를 확인하고 있습니다.";
            try{
                await Task.Run(()=>BridgeControl.Start(state));started=true;
                var current=await Task.Run(()=>BridgeStatus(state));
                var listed=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"profile","list","--json"})));
                target=ResumePage(current,listed,id);
            }catch(Exception){/* The state is unknown: start at the first step. Each step reports its own errors. */}
            if(IsDisposed)return null;
            // The user moved on while the state was read.
            if(page!=from){manage.Enabled=page==0&&operation.SelectedIndex!=2&&InstalledHere();if(status.Text=="연결 상태를 확인하고 있습니다.")status.Clear();return null;}
            status.Clear();
            if(target==4){detectionState=state;detectionExtensionId=id;SetPage(4);detectionBridgeStarted=started;connectionAuto=true;WaitForExtension();}
            else{
                SetPage(target);
                // Not awaited: these belong to the page, not to the installation that may have called this.
                var entering=target==7?RunDoneChecks():EnterRuntimePage();
            }
            return null;
        }
        async Task PreparePairing(){
            if(working)return;working=true;prepare.Enabled=false;cancel.Enabled=false;status.Text="Chrome 연결을 준비하고 있습니다.";
            InstallState state=null;
            try{
                string selectedFolder=folder.Text;
                state=await Task.Run(()=>{var s=Verified(selectedFolder);BridgeControl.Start(s);return s;});
                if(IsDisposed||Disposing)return;
                LoadPairingFields(state);pairingCode.Text="";pairingState.Clear();SetPage(5);status.Clear();
            }catch(Exception error){state=null;if(!IsDisposed&&!Disposing)status.Fail(Friendly.Message(error));}finally{working=false;if(!IsDisposed&&!Disposing){prepare.Enabled=true;cancel.Enabled=true;}}
            // The code is issued as soon as the page opens; reuse the verified state and running Bridge.
            if(state!=null&&!IsDisposed&&!Disposing){var waiting=ConnectChromeWith(state,true);}
        }
        /// The address and token for connecting by hand, from the data the running Bridge created.
        void LoadPairingFields(InstallState state){
            var data=InstallerEngine.Read<Dictionary<string,object>>(Path.Combine(state.DataDir,"config.json"));string token=(string)data["token"];
            if(!System.Text.RegularExpressions.Regex.IsMatch(token??"","^[a-fA-F0-9]{64}$"))throw new IOException("페어링 토큰을 확인할 수 없습니다.");
            pairingUrl.Text="ws://127.0.0.1:"+state.Port+"/extension";pairingToken.Text=token;
        }
        async Task DiscoverInstallations(Func<DiscoveryResult> scan){
            int current=revision;
            try{var result=await Task.Run(scan);if(IsDisposed||Disposing)return;
                installs.Items.Clear();foreach(string path in result.Installs)installs.Items.Add(path);installs.Enabled=installs.Items.Count>0;
                if(current==revision&&result.Notices.Count>0)status.Text=String.Join("\r\n",result.Notices);
            }catch(Exception error){if(!IsDisposed&&!Disposing&&current==revision)status.Fail(Friendly.Message(error));}
        }
        async Task Discover() {
            if(!discover.Enabled||working)return;discover.Enabled=false;int current=revision;advancedStatus.Text="OpenCode 위치를 확인하고 있습니다.";
            try {var result=await Task.Run(()=>Discovery.Find());if(IsDisposed||Disposing||!advanced.Visible||current!=revision||working)return;
                candidates.Items.Clear();distribution.Items.Clear();installs.Items.Clear();foreach(var p in result.Installs)installs.Items.Add(p);installs.Enabled=installs.Items.Count>0;foreach(var d in result.Distributions)distribution.Items.Add(d);foreach(var c in result.OpenCode)candidates.Items.Add(c);
                advancedStatus.Text="기존 설치 "+result.Installs.Count+"개, OpenCode "+result.OpenCode.Count+"개를 찾았습니다."+(result.Notices.Count>0?"\r\n"+String.Join("\r\n",result.Notices):"");if(candidates.Items.Count==1)candidates.SelectedIndex=0;
            }catch(Exception error){if(!IsDisposed&&!Disposing&&advanced.Visible&&current==revision)advancedStatus.Fail(Friendly.Message(error));}finally{if(!IsDisposed&&!Disposing)discover.Enabled=true;}
        }
        void SelectCandidate() {
            var c=candidates.SelectedItem as OpenCodeCandidate;if(c==null)return;kind.SelectedItem=c.Kind;distribution.Text=c.Distribution??"";
            if(c.Settings.Count==1)config.Text=c.Settings[0];else if(c.Settings.Count==0) config.Text=c.Kind=="wsl"?@"\\wsl.localhost\"+c.Distribution+(c.Home+"/.config/opencode/opencode.json").Replace('/','\\'):Path.Combine(c.Home,@".config\opencode\opencode.json");
            else {config.Clear();advancedStatus.Text="설정 파일이 여러 개입니다. 사용할 파일 경로를 선택해 입력하세요:\r\n"+String.Join("\r\n",c.Settings);}
        }
        void AddRegistration() {
            if(!register.Checked){advancedStatus.Fail("CLI 등록을 선택한 뒤 설정 파일을 추가하세요.");return;}
            try {var c=candidates.SelectedItem as OpenCodeCandidate;string path=Path.GetFullPath(config.Text);if(selected.Any(x=>InstallerEngine.Same(x.Path,path)))throw new IOException("이미 추가한 설정입니다.");string distro=distribution.Text.Trim();var entry=new McpRecord{Path=path,Kind=(string)kind.SelectedItem,Distribution=distro,User=c!=null&&c.Kind=="wsl"&&String.Equals(c.Distribution,distro,StringComparison.OrdinalIgnoreCase)?c.User:null};if(entry.Kind=="wsl"&&String.IsNullOrWhiteSpace(entry.Distribution))throw new IOException("WSL 배포판을 선택하세요.");selected.Add(entry);registrations.Items.Add(entry.Kind+" · "+path);advancedStatus.Text="선택 목록에 추가했습니다. 미리보기 후 적용할 수 있습니다.";}catch(Exception error){advancedStatus.Fail(Friendly.Message(error));}
        }
        async Task Prepare(){
            if(working)return;working=true;prepare.Enabled=false;back.Enabled=false;input.Enabled=false;status.Text="설치 위치와 파일을 확인하고 있습니다.";
            try{
                if(operation.SelectedIndex!=2&&register.Checked&&selected.Count==0)throw new IOException("CLI에 등록할 설정을 먼저 추가하세요.");
                var options=new SetupOptions{Operation=new[]{"install","update","uninstall"}[operation.SelectedIndex],InstallDir=folder.Text,PackageDir=package.Text,Port=(int)port.Value,Start=start.Checked,Startup=startup.Checked,StartupDir=startupPath.Text};
                if(options.Operation!="uninstall"&&register.Checked)options.Registrations.AddRange(selected);
                plan=await Task.Run(()=>InstallerEngine.Prepare(options));
                preview.Text=plan.Preview;
                SetPage(2);status.Text="준비가 완료됐습니다.";
            }catch(Exception error){plan=null;status.Fail(Friendly.Message(error));}finally{working=false;prepare.Enabled=true;back.Enabled=true;input.Enabled=true;}
        }
        async Task Apply(){
            if(working||plan==null)return;working=true;cancellation=new CancellationTokenSource();SetPage(3);status.Text="설치 중입니다.";
            // Progress reports and the code after the installation are queued separately, so a report can
            // arrive after the result is shown. It must not replace that result.
            bool reporting=true;
            try{string result;
                try{result=await Task.Run(()=>InstallerEngine.Apply(plan,cancellation.Token,message=>BeginInvoke((Action)(()=>{if(reporting)status.Text=message;}))));}
                finally{reporting=false;}
                if(plan.Next!=null){
                    string failure=await OpenSetup();
                    if(failure!=null){
                        plan=null;loadedFolder=null;LoadState();SetPage(0);
                        heading.Text="연결 준비 실패";steps.Text="설치 파일을 확인한 뒤 연결 설정을 다시 열어 주세요.";cancel.Text="닫기";
                        int warningIndex=result.IndexOf("경고:",StringComparison.Ordinal);
                        status.Fail("설치 파일은 저장됐지만 연결 준비에 실패했습니다.\r\n"+failure+(warningIndex>=0?"\r\n"+result.Substring(warningIndex):""));
                        return;
                    }
                }else{manage.Enabled=false;SetPage(7);back.Visible=false;done.Visible=false;review.Visible=true;preview.Visible=true;preview.Text=result;}
                status.Text=plan.Next==null?"제거 완료.":(operation.SelectedIndex==1?"업데이트 완료.":"설치 완료.")+(page>4?" 이미 끝난 연결 단계는 건너뛰었습니다.":"");
                int warning=result.IndexOf("경고:",StringComparison.Ordinal);if(warning>=0)status.Fail(result.Substring(warning));
            }catch(OperationCanceledException){SetPage(2);status.Text="취소됐습니다. 변경 사항을 복구했습니다.";}
            catch(Exception error){SetPage(2);status.Fail(Friendly.Message(error)+"\r\n[뒤로]를 눌러 확인하고 다시 시도하세요.");}
            finally{working=false;cancellation.Dispose();cancellation=null;}
        }
    }
}
