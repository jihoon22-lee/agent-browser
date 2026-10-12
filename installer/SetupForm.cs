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
    internal sealed class SetupForm : Form {
        readonly TextBox folder=new TextBox(),package=new TextBox(),startupPath=new TextBox(),config=new TextBox(),preview=new TextBox(),status=new TextBox();
        readonly ComboBox operation=new ComboBox(),kind=new ComboBox(),distribution=new ComboBox(),candidates=new ComboBox(),installs=new ComboBox();
        readonly NumericUpDown port=new NumericUpDown();
        readonly CheckBox start=new CheckBox(),startup=new CheckBox(),register=new CheckBox();
        readonly Button prepare=new Button(),apply=new Button(),back=new Button(),cancel=new Button(),discover=new Button(),add=new Button();
        readonly ListBox registrations=new ListBox();
        readonly Button profiles=new Button();
        readonly Panel input=new Panel(),review=new Panel();
        readonly List<McpRecord> selected=new List<McpRecord>();
        readonly string[] args;InstallPlan plan;CancellationTokenSource cancellation;bool working;int revision;
        static string Arg(string[] args,string name,string fallback) {int index=Array.IndexOf(args,name);return index>=0&&index+1<args.Length?args[index+1]:fallback;}
        static bool Has(string[] args,string name) {return args.Contains(name);}
        static Label LabelAt(Control parent,string text,int x,int y,int width=170) {var label=new Label{Text=text,Left=x,Top=y+4,Width=width,Height=24};parent.Controls.Add(label);return label;}
        static void Position(Control parent,Control c,string name,int x,int y,int width,int height=28) {c.Name=name;c.AccessibleName=name;c.SetBounds(x,y,width,height);parent.Controls.Add(c);}
        public SetupForm(string[] arguments) {
            args=arguments;Text="AgentBrowser 설치 관리자";Name="AgentBrowserSetup";Size=new Size(850,775);MinimumSize=new Size(850,775);StartPosition=FormStartPosition.CenterScreen;Font=new Font("Segoe UI",10F);AutoScaleMode=AutoScaleMode.Dpi;
            var title=new Label{Text="AgentBrowser",Font=new Font("Segoe UI",22F,FontStyle.Bold),Left=26,Top=20,Width=760,Height=45};Controls.Add(title);
            var subtitle=new Label{Text="설치 · 업데이트 · 제거  |  적용 전에 대상과 변경 내용을 확인합니다.",Left=28,Top=70,Width=760,Height=30};Controls.Add(subtitle);
            Position(this,input,"SettingsPanel",24,112,780,488);Position(this,review,"PreviewPanel",24,112,780,488);review.Visible=false;
            LabelAt(input,"작업",0,0);Position(input,operation,"Operation",180,0,170);operation.DropDownStyle=ComboBoxStyle.DropDownList;operation.Items.AddRange(new object[]{"설치","업데이트","제거"});operation.SelectedIndex=0;
            LabelAt(input,"기존 설치 선택",360,0,110);
            Position(input,installs,"ExistingInstallations",470,0,300);installs.DropDownStyle=ComboBoxStyle.DropDownList;installs.SelectedIndexChanged+=delegate {if(installs.SelectedItem!=null){folder.Text=(string)installs.SelectedItem;LoadState();}};
            LabelAt(input,"설치 폴더",0,40);Position(input,folder,"InstallFolder",180,40,485);folder.Text=Arg(args,"--install-dir",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AgentBrowser"));
            var browse=new Button{Text="찾아보기"};Position(input,browse,"BrowseInstall",675,38,95,31);browse.Click+=delegate {using(var dialog=new FolderBrowserDialog{Description="AgentBrowser 전용 설치 폴더",SelectedPath=folder.Text}) if(dialog.ShowDialog(this)==DialogResult.OK) {folder.Text=dialog.SelectedPath;LoadState();}};
            LabelAt(input,"압축 해제한 패키지",0,80);Position(input,package,"PackageFolder",180,80,590);package.Text=Arg(args,"--package-dir",AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'));
            LabelAt(input,"Bridge 포트",0,120);Position(input,port,"BridgePort",180,120,110);port.Minimum=1;port.Maximum=65535;port.Value=Int32.Parse(Arg(args,"--port","4317"));
            start.Text="적용 후 Bridge 시작";start.Checked=!Has(args,"--no-start");Position(input,start,"StartBridge",320,120,230);
            startup.Text="Windows 로그인 시 시작";startup.Checked=!Has(args,"--no-startup");Position(input,startup,"EnableStartup",180,158,250);
            var startNow=new Button{Text="Bridge 시작"};Position(input,startNow,"StartInstalledBridge",0,150,160,32);startNow.Click+=async delegate{
                if(working)return;working=true;input.Enabled=false;prepare.Enabled=false;profiles.Enabled=false;
                try{var installed=InstallerEngine.State(InstallerEngine.Root(folder.Text));if(installed==null)throw new IOException("먼저 AgentBrowser를 설치하세요.");await Task.Run(()=>BridgeControl.Start(installed));status.Text="Bridge가 실행 중입니다. 페어링 주소와 토큰을 확인하세요.";}
                catch(Exception error){status.Text=error.Message;}finally{working=false;input.Enabled=true;prepare.Enabled=true;profiles.Enabled=true;}
            };
            Position(input,startupPath,"StartupFolder",180,190,590);startupPath.Text=Arg(args,"--startup-dir",Environment.GetFolderPath(Environment.SpecialFolder.Startup));
            var pairing=new Button{Text="페어링 토큰"};Position(input,pairing,"Pairing",0,188,160,32);pairing.Click+=delegate{ShowPairing();};
            discover.Text="OpenCode 찾기";Position(input,discover,"Discover",0,232,160,32);discover.Click+=async delegate {await Discover();};
            Position(input,candidates,"OpenCodeCandidates",180,232,590);candidates.DropDownStyle=ComboBoxStyle.DropDownList;candidates.SelectedIndexChanged+=delegate {SelectCandidate();};
            register.Text="일반 CLI에 browser MCP 등록";Position(input,register,"RegisterMcp",0,274,300);
            Position(input,kind,"OpenCodeKind",320,274,130);kind.DropDownStyle=ComboBoxStyle.DropDownList;kind.Items.AddRange(new object[]{"windows","wsl"});kind.SelectedIndex=0;
            Position(input,distribution,"Distribution",470,274,300);distribution.DropDownStyle=ComboBoxStyle.DropDown;
            LabelAt(input,"OpenCode 설정 파일",0,311);Position(input,config,"OpenCodeConfig",180,311,485);
            add.Text="추가";Position(input,add,"AddRegistration",675,309,95,31);add.Click+=delegate {AddRegistration();};
            Position(input,registrations,"Registrations",180,350,590,68);
            var remove=new Button{Text="선택 제거"};Position(input,remove,"RemoveRegistration",0,350,160,32);remove.Click+=delegate{int i=registrations.SelectedIndex;if(i>=0){selected.RemoveAt(i);registrations.Items.RemoveAt(i);}};
            var help=new Label{Text="선택한 설정의 browser MCP만 변경합니다. Windows와 WSL은 각각 추가할 수 있습니다.\r\n관리 서버: Chrome 페어링 후 프로필에서 실행 파일과 작업 폴더를 설정하세요.\r\n제거 시 사용자 데이터는 보존합니다.",Left=0,Top=426,Width=770,Height=60};input.Controls.Add(help);
            preview.Multiline=true;preview.ReadOnly=true;preview.ScrollBars=ScrollBars.Vertical;Position(review,preview,"ChangePreview",0,0,770,450);
            status.Multiline=true;status.ReadOnly=true;status.ScrollBars=ScrollBars.Vertical;Position(this,status,"Status",24,610,780,58);
            prepare.Text="변경 내용 확인";Position(this,prepare,"Preview",420,681,140,34);prepare.Click+=async delegate {await Prepare();};
            back.Text="이전";Position(this,back,"Back",270,681,130,34);back.Visible=false;back.Click+=delegate {plan=null;review.Visible=false;input.Visible=true;apply.Visible=false;back.Visible=false;prepare.Visible=true;status.Text="선택을 변경한 뒤 다시 확인하세요.";};
            apply.Text="적용";Position(this,apply,"Apply",570,681,105,34);apply.Visible=false;apply.Click+=async delegate {await Apply();};
            cancel.Text="닫기";Position(this,cancel,"Cancel",690,681,115,34);cancel.Click+=delegate {if(working&&cancellation!=null) {cancellation.Cancel();status.Text="취소 요청을 받았습니다. 현재 단계가 끝나면 변경 사항을 복구합니다.";}else Close();};
            profiles.Text="관리 프로필 설정";Position(this,profiles,"ManagedProfiles",24,681,200,34);profiles.Click+=delegate{try{var state=InstallerEngine.State(InstallerEngine.Root(folder.Text));if(state==null)throw new IOException("먼저 AgentBrowser를 설치하세요.");using(var dialog=new ProfileForm(state))dialog.ShowDialog(this);}catch(Exception error){status.Text=error.Message;}};
            FormClosing+=delegate(object sender,FormClosingEventArgs e) {if(working) {e.Cancel=true;if(cancellation!=null)cancellation.Cancel();status.Text="복구가 끝날 때까지 기다려 주세요.";}};
            operation.SelectedIndexChanged+=delegate {package.Enabled=operation.SelectedIndex!=2;register.Enabled=operation.SelectedIndex!=2;};
            folder.Leave+=delegate {LoadState();};
            foreach(Control field in new Control[]{folder,config,kind,distribution,operation})field.TextChanged+=delegate{revision++;};
            LoadState();
            status.Text="설치 폴더와 작업을 선택하세요. 검색과 미리보기는 설정을 변경하지 않습니다.";
            Shown+=async delegate{if(!Has(args,"--no-discover"))await Discover();};
        }
        void LoadState() {try {var old=InstallerEngine.State(folder.Text);if(old!=null) {operation.SelectedIndex=1;port.Value=old.Port;startup.Checked=old.Startup!=null;if(old.Startup!=null)startupPath.Text=Path.GetDirectoryName(old.Startup.Path);status.Text="기존 설치 "+old.Version+"을 찾았습니다. 데이터는 보존합니다.";}}catch(Exception error){status.Text=error.Message;}}
        void ShowPairing() {
            try {
                var state=InstallerEngine.State(InstallerEngine.Root(folder.Text));if(state==null)throw new IOException("먼저 AgentBrowser를 설치하고 Bridge를 시작하세요.");InstallerEngine.Owned(state);
                string token=(string)InstallerEngine.Read<Dictionary<string,object>>(Path.Combine(state.DataDir,"config.json"))["token"];
                if(!System.Text.RegularExpressions.Regex.IsMatch(token??"","^[a-fA-F0-9]{64}$"))throw new IOException("페어링 토큰을 확인할 수 없습니다.");
                using(var dialog=new Form{Text="AgentBrowser 페어링",Size=new Size(610,260),StartPosition=FormStartPosition.CenterParent,Font=Font}) {
                    dialog.Controls.Add(new Label{Text="Chrome 확장 Options에 주소와 토큰을 넣으세요. 토큰은 공유하지 마세요.",Left=20,Top=20,Width=560,Height=32});
                    var url=new TextBox{ReadOnly=true,Text="ws://127.0.0.1:"+state.Port+"/extension"};Position(dialog,url,"PairingUrl",20,65,560);
                    var secret=new TextBox{ReadOnly=true,UseSystemPasswordChar=true,Text=token};Position(dialog,secret,"PairingToken",20,105,560);
                    var copy=new Button{Text="토큰 복사"};Position(dialog,copy,"CopyPairingToken",310,160,130,32);copy.Click+=delegate{Clipboard.SetText(token);};
                    var close=new Button{Text="닫기"};Position(dialog,close,"ClosePairing",450,160,130,32);close.Click+=delegate{dialog.Close();};dialog.ShowDialog(this);
                }
            }catch(Exception error){status.Text=error.Message;}
        }
        async Task Discover() {
            if(!discover.Enabled||working)return;discover.Enabled=false;int current=revision;status.Text="OpenCode 위치를 확인하고 있습니다.";
            try {var result=await Task.Run(()=>Discovery.Find());if(IsDisposed||Disposing||current!=revision||working)return;
                candidates.Items.Clear();distribution.Items.Clear();installs.Items.Clear();foreach(var p in result.Installs)installs.Items.Add(p);foreach(var d in result.Distributions)distribution.Items.Add(d);foreach(var c in result.OpenCode)candidates.Items.Add(c);
                status.Text="기존 설치 "+result.Installs.Count+"개, OpenCode "+result.OpenCode.Count+"개를 찾았습니다.\r\n"+String.Join("\r\n",result.Notices);if(candidates.Items.Count==1)candidates.SelectedIndex=0;
            }catch(Exception error){if(!IsDisposed&&!Disposing&&current==revision)status.Text=error.Message;}finally{if(!IsDisposed&&!Disposing)discover.Enabled=true;}
        }
        void SelectCandidate() {
            var c=candidates.SelectedItem as OpenCodeCandidate;if(c==null)return;kind.SelectedItem=c.Kind;distribution.Text=c.Distribution??"";
            if(c.Settings.Count==1)config.Text=c.Settings[0];else if(c.Settings.Count==0) config.Text=c.Kind=="wsl"?@"\\wsl.localhost\"+c.Distribution+(c.Home+"/.config/opencode/opencode.json").Replace('/','\\'):Path.Combine(c.Home,@".config\opencode\opencode.json");
            else {config.Clear();status.Text="설정 파일이 여러 개입니다. 사용할 파일 경로를 선택해 입력하세요:\r\n"+String.Join("\r\n",c.Settings);}
        }
        void AddRegistration() {
            if(!register.Checked){status.Text="CLI 등록을 선택한 뒤 설정 파일을 추가하세요.";return;}
            try {var c=candidates.SelectedItem as OpenCodeCandidate;string path=Path.GetFullPath(config.Text);if(selected.Any(x=>InstallerEngine.Same(x.Path,path)))throw new IOException("이미 추가한 설정입니다.");var entry=new McpRecord{Path=path,Kind=(string)kind.SelectedItem,Distribution=distribution.Text,User=c!=null&&c.Kind=="wsl"&&c.Distribution==distribution.Text?c.User:null};if(entry.Kind=="wsl"&&String.IsNullOrWhiteSpace(entry.Distribution))throw new IOException("WSL 배포판을 선택하세요.");selected.Add(entry);registrations.Items.Add(entry.Kind+" · "+path);status.Text="선택 목록에 추가했습니다. 미리보기 후 적용할 수 있습니다.";}catch(Exception error){status.Text=error.Message;}
        }
        async Task Prepare() {
            if(working)return;working=true;prepare.Enabled=false;input.Enabled=false;status.Text="패키지와 대상 소유권, 설정 변경 내용을 확인합니다.";
            try {
                if(register.Checked&&selected.Count==0)throw new IOException("CLI에 등록할 설정을 먼저 추가하세요.");
                var options=new SetupOptions{Operation=new []{"install","update","uninstall"}[operation.SelectedIndex],InstallDir=folder.Text,PackageDir=package.Text,Port=(int)port.Value,Start=start.Checked,Startup=startup.Checked,StartupDir=startupPath.Text};
                if(register.Checked) options.Registrations.AddRange(selected);
                plan=await Task.Run(()=>InstallerEngine.Prepare(options));preview.Text=plan.Preview+"\r\n\r\n변경 파일: "+plan.Changes.Count+"개\r\n진행하려면 적용을 누르세요.";input.Visible=false;review.Visible=true;prepare.Visible=false;back.Visible=true;apply.Visible=true;status.Text="아직 변경하지 않았습니다. 대상과 등록할 설정을 확인하세요.";
            }catch(Exception error){status.Text=error.Message;}finally{working=false;prepare.Enabled=true;input.Enabled=true;}
        }
        async Task Apply() {
            if(working||plan==null)return;working=true;cancellation=new CancellationTokenSource();apply.Enabled=false;back.Enabled=false;profiles.Enabled=false;cancel.Text="취소";status.Text="변경 사항을 적용합니다.";
            try {var result=await Task.Run(()=>InstallerEngine.Apply(plan,cancellation.Token,message=>BeginInvoke((Action)(()=>status.Text=message))));status.Text=result;preview.Text+="\r\n\r\n"+result;apply.Visible=false;back.Visible=true;cancel.Text="닫기";}
            catch(OperationCanceledException){status.Text="취소됐습니다. 적용한 변경 사항을 복구했습니다.";cancel.Text="닫기";}
            catch(Exception error){status.Text=error.Message+"\r\n이전으로 돌아가 확인하거나 다시 시도하세요.";cancel.Text="닫기";}
            finally{working=false;apply.Enabled=true;back.Enabled=true;profiles.Enabled=true;cancellation.Dispose();cancellation=null;}
        }
    }
    internal static class Program {
        // Installed maintenance runs outside its owned files so Windows can remove
        // or replace them. Reuse only an exact-hash private temporary executable.
        static bool RelaunchInstalled(string[] args) {
            string exe=Application.ExecutablePath;var directory=Directory.GetParent(exe);if(directory==null)return false;
            // Legacy scripts put the GUI at the install root; updates retain old
            // versioned GUIs. Any owned running copy would otherwise lock removal.
            string root=directory.Parent!=null&&directory.Parent.Name=="app"&&directory.Parent.Parent!=null?directory.Parent.Parent.FullName:directory.FullName;
            var state=InstallerEngine.State(root);if(state==null)return false;
            InstallerEngine.Owned(state);string hash=NativeIO.FileHash(exe);
            if(!state.OwnedFiles.Any(f=>InstallerEngine.Same(NativeIO.SafePath(root,f.Path),exe)&&InstallerEngine.Same(f.Sha256,hash)))throw new IOException("Installed setup ownership is invalid.");
            string cache=Path.Combine(Path.GetTempPath(),"AgentBrowser-Setup",hash);InstallerEngine.PrivateDirectory(cache);string copy=Path.Combine(cache,"AgentBrowser-Setup.exe");
            if(File.Exists(copy)){NativeIO.PlainPath(copy);if(NativeIO.FileHash(copy)!=hash)throw new IOException("Temporary setup ownership is invalid.");}
            else {File.Copy(exe,copy);if(NativeIO.FileHash(copy)!=hash)throw new IOException("Temporary setup verification failed.");}
            var forwarded=new List<string>(args);if(!args.Contains("--install-dir"))forwarded.AddRange(new[]{"--install-dir",root});
            using(var child=Process.Start(new ProcessStartInfo(copy,String.Join(" ",forwarded.Select(NativeIO.Quote))){UseShellExecute=false})) {if(child==null)throw new IOException("Could not open installed maintenance.");}
            return true;
        }
        [STAThread] public static int Main(string[] args) {
            try {
                if(args.Length==2&&args[0]=="--start") {var state=InstallerEngine.State(InstallerEngine.Root(args[1]));if(state==null)throw new IOException("설치 상태를 찾지 못했습니다.");BridgeControl.Start(state);return 0;}
                if(RelaunchInstalled(args))return 0;
                Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new SetupForm(args));return 0;
            } catch(Exception error) {MessageBox.Show(error.Message,"AgentBrowser",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
        }
    }
}

