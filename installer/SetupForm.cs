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
        readonly TextBox folder=new TextBox(),package=new TextBox(),startupPath=new TextBox(),config=new TextBox(),preview=new TextBox(),status=new TextBox(),extensionFolder=new TextBox(),pairingUrl=new TextBox(),pairingToken=new TextBox();
        readonly ComboBox operation=new ComboBox(),kind=new ComboBox(),distribution=new ComboBox(),candidates=new ComboBox(),installs=new ComboBox();
        readonly NumericUpDown port=new NumericUpDown();
        readonly CheckBox start=new CheckBox(),startup=new CheckBox(),register=new CheckBox();
        readonly Button prepare=new Button(),apply=new Button(),back=new Button(),cancel=new Button(),discover=new Button(),add=new Button(),profiles=new Button(),manage=new Button();
        readonly ListBox registrations=new ListBox();
        readonly Panel welcome=new Panel(),input=new Panel(),advanced=new Panel(),review=new Panel(),connection=new Panel(),pairing=new Panel(),runtime=new Panel(),done=new Panel();
        readonly Label heading=new Label(),steps=new Label(),installing=new Label();
        readonly ProgressBar progress=new ProgressBar();
        readonly List<McpRecord> selected=new List<McpRecord>();
        readonly string[] args;InstallPlan plan;CancellationTokenSource cancellation;bool working;int revision,page;string loadedFolder;
        static readonly Color Ink=Color.FromArgb(28,33,40),Muted=Color.FromArgb(94,101,112),Accent=Color.FromArgb(0,103,192),Border=Color.FromArgb(214,218,224);
        static string DefaultFolder {get{return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AgentBrowser");}}
        static string Arg(string[] args,string name,string fallback) {int index=Array.IndexOf(args,name);return index>=0&&index+1<args.Length?args[index+1]:fallback;}
        static bool Has(string[] args,string name) {return args.Contains(name);}
        static Label LabelAt(Control parent,string text,int x,int y,int width=170,int height=24) {var label=new Label{Text=text,Left=x,Top=y,Width=width,Height=height,ForeColor=Ink};parent.Controls.Add(label);return label;}
        static void StyleButton(Button button,bool primary=false){button.FlatStyle=FlatStyle.Flat;button.FlatAppearance.BorderColor=Border;button.FlatAppearance.BorderSize=primary?0:1;button.BackColor=primary?Accent:Color.White;button.ForeColor=primary?Color.White:Ink;button.FlatAppearance.MouseOverBackColor=primary?Color.FromArgb(0,88,165):Color.FromArgb(243,245,248);button.UseVisualStyleBackColor=false;}
        static void Position(Control parent,Control c,string name,int x,int y,int width,int height=28) {c.Name=name;c.AccessibleName=name;c.SetBounds(x,y,width,height);parent.Controls.Add(c);var button=c as Button;if(button!=null)StyleButton(button);}
        public SetupForm(string[] arguments,Func<DiscoveryResult> installedDiscovery=null) {
            args=arguments;Text="AgentBrowser 설치";Name="AgentBrowserSetup";ClientSize=new Size(720,564);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;Font=new Font("맑은 고딕",10F);ForeColor=Ink;BackColor=Color.White;AutoScaleMode=AutoScaleMode.Dpi;
            heading.Font=new Font(Font.FontFamily,18F,FontStyle.Bold);Position(this,heading,"PageTitle",32,24,656,36);
            steps.ForeColor=Muted;Position(this,steps,"SetupSteps",32,68,656,30);
            var line=new Panel{BackColor=Border};line.SetBounds(0,108,720,1);Controls.Add(line);
            var panels=new[]{welcome,input,review,connection,pairing,runtime,done};var names=new[]{"WelcomePanel","SettingsPanel","PreviewPanel","ConnectionPanel","PairingPanel","RuntimePanel","DonePanel"};
            for(int i=0;i<panels.Length;i++)Position(this,panels[i],names[i],32,132,656,308);
            LabelAt(welcome,"기존 OpenCode를 Chrome에서 사용할 수 있도록 설치합니다.\r\n\r\n설치가 끝나면 Chrome 확장 추가와 연결 설정을\r\n차례대로 안내합니다.",0,4,656,104);
            LabelAt(welcome,"수행할 작업",0,134);Position(welcome,operation,"Operation",154,130,240);operation.DropDownStyle=ComboBoxStyle.DropDownList;operation.Items.AddRange(new object[]{"설치","업데이트","제거"});operation.SelectedIndex=0;
            LabelAt(welcome,"기존 설치",0,178);Position(welcome,installs,"ExistingInstallations",154,174,502);installs.DropDownStyle=ComboBoxStyle.DropDownList;installs.SelectedIndexChanged+=delegate{if(installs.SelectedItem!=null){folder.Text=(string)installs.SelectedItem;LoadState();}};
            manage.Text="기존 설치의 연결 설정...";Position(welcome,manage,"ManageConnection",154,222,240,34);manage.Click+=delegate{ShowConnection();};
            LabelAt(input,"설치할 폴더",0,0,656);Position(input,folder,"InstallFolder",0,30,536);folder.Text=Arg(args,"--install-dir",DefaultFolder);
            var browse=new Button{Text="찾아보기..."};Position(input,browse,"BrowseInstall",548,28,108,32);browse.Click+=delegate{using(var dialog=new FolderBrowserDialog{Description="AgentBrowser 전용 설치 폴더",SelectedPath=folder.Text})if(dialog.ShowDialog(this)==DialogResult.OK){folder.Text=dialog.SelectedPath;LoadState();}};
            LabelAt(input,"기본 위치를 권장합니다. 다른 로컬 드라이브도 선택할 수 있습니다.",0,72,656,24).ForeColor=Muted;
            var reset=new Button{Text="기본 위치로 되돌리기"};Position(input,reset,"UseDefaultFolder",0,106,182,32);reset.Click+=delegate{folder.Text=DefaultFolder;LoadState();};
            startup.Text="Windows 로그인 시 자동 실행";startup.Checked=!Has(args,"--no-startup");Position(input,startup,"EnableStartup",0,168,450);
            var advancedToggle=new Button{Text="고급 설정..."};Position(input,advancedToggle,"AdvancedSettings",0,226,132,32);advancedToggle.Click+=delegate{ShowAdvanced();};
            Position(input,advanced,"AdvancedPanel",0,0,772,336);advanced.AutoScroll=true;advanced.Visible=false;
            LabelAt(advanced,"설치 파일 위치",0,4);Position(advanced,package,"PackageFolder",180,0,570);package.Text=Arg(args,"--package-dir",AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'));
            LabelAt(advanced,"Bridge 포트",0,42);Position(advanced,port,"BridgePort",180,38,110);port.Minimum=1;port.Maximum=65535;port.Value=Int32.Parse(Arg(args,"--port","4317"));
            start.Text="설치 후 자동 실행";start.Checked=!Has(args,"--no-start");Position(advanced,start,"StartBridge",320,38,240);
            LabelAt(advanced,"자동 실행 폴더",0,80);Position(advanced,startupPath,"StartupFolder",180,76,570);startupPath.Text=Arg(args,"--startup-dir",Environment.GetFolderPath(Environment.SpecialFolder.Startup));
            discover.Text="OpenCode 찾기";Position(advanced,discover,"Discover",0,118,160,32);discover.Click+=async delegate{await Discover();};
            Position(advanced,candidates,"OpenCodeCandidates",180,118,570);candidates.DropDownStyle=ComboBoxStyle.DropDownList;candidates.SelectedIndexChanged+=delegate{SelectCandidate();};
            register.Text="일반 CLI에도 browser MCP 등록 (선택)";Position(advanced,register,"RegisterMcp",0,160,360);
            Position(advanced,kind,"OpenCodeKind",370,160,130);kind.DropDownStyle=ComboBoxStyle.DropDownList;kind.Items.AddRange(new object[]{"windows","wsl"});kind.SelectedIndex=0;
            Position(advanced,distribution,"Distribution",510,160,240);distribution.DropDownStyle=ComboBoxStyle.DropDown;
            LabelAt(advanced,"OpenCode 설정 파일",0,204);Position(advanced,config,"OpenCodeConfig",180,200,475);
            add.Text="추가";Position(advanced,add,"AddRegistration",665,198,85,31);add.Click+=delegate{AddRegistration();};
            Position(advanced,registrations,"Registrations",180,240,570,54);
            var remove=new Button{Text="선택 제거"};Position(advanced,remove,"RemoveRegistration",0,240,160,32);remove.Click+=delegate{int i=registrations.SelectedIndex;if(i>=0){selected.RemoveAt(i);registrations.Items.RemoveAt(i);}};
            LabelAt(advanced,"Chrome에서만 사용할 때는 CLI 등록이 필요하지 않습니다.",0,308,750).ForeColor=Muted;
            preview.Multiline=true;preview.ReadOnly=true;preview.BorderStyle=BorderStyle.None;preview.BackColor=Color.White;preview.ScrollBars=ScrollBars.Vertical;Position(review,preview,"ChangePreview",0,0,656,300);
            installing.Text="프로그램 파일을 설치하고 연결 서비스를 시작합니다.";Position(review,installing,"InstallingMessage",0,50,656,30);
            progress.Style=ProgressBarStyle.Marquee;Position(review,progress,"InstallProgress",0,104,656,20);
            LabelAt(connection,"1. Chrome 주소창에 chrome://extensions 를 입력하세요.",0,0,656);
            LabelAt(connection,"2. 개발자 모드를 켜고 [압축해제된 확장 프로그램 로드]를 누르세요.",0,32,656);
            LabelAt(connection,"3. 아래 폴더를 선택하세요. 업데이트했다면 기존 확장을 새로고침하세요.",0,64,656);
            LabelAt(connection,"Chrome에 추가할 확장 폴더",0,112,656).ForeColor=Muted;
            extensionFolder.ReadOnly=true;Position(connection,extensionFolder,"ExtensionFolder",0,140,656);
            var copyPath=new Button{Text="폴더 경로 복사"};Position(connection,copyPath,"CopyExtensionFolder",0,184,160,34);copyPath.Click+=delegate{Clipboard.SetText(extensionFolder.Text);status.Text="폴더 경로를 복사했습니다.";};
            LabelAt(connection,"Chrome에 확장을 추가한 뒤 [다음]을 누르세요.",0,252,656).ForeColor=Muted;
            LabelAt(pairing,"Chrome의 AgentBrowser 세부정보에서 [확장 프로그램 옵션]을 여세요.\r\n아래 주소와 토큰을 입력하고 [저장 후 연결]을 누르세요.",0,0,656,52);
            LabelAt(pairing,"Bridge 주소",0,72,656).ForeColor=Muted;pairingUrl.ReadOnly=true;Position(pairing,pairingUrl,"PairingUrl",0,98,656);
            LabelAt(pairing,"페어링 토큰",0,142,656).ForeColor=Muted;pairingToken.ReadOnly=true;pairingToken.UseSystemPasswordChar=true;Position(pairing,pairingToken,"PairingToken",0,168,480);
            var copyToken=new Button{Text="토큰 복사"};Position(pairing,copyToken,"CopyPairingToken",496,166,160,32);copyToken.Click+=delegate{Clipboard.SetText(pairingToken.Text);status.Text="토큰을 복사했습니다. Chrome 확장 옵션에 붙여 넣으세요.";};
            LabelAt(pairing,"확장에 ‘Bridge에 연결되었습니다’가 표시되면 [다음]을 누르세요.",0,240,656,42).ForeColor=Muted;
            LabelAt(runtime,"사용할 OpenCode 실행 환경을 설정합니다.\r\nWindows 또는 WSL의 실행 파일과 작업 폴더를 확인하고 저장하세요.",0,4,656,62);
            profiles.Text="OpenCode 실행 환경 설정...";Position(runtime,profiles,"ManagedProfiles",0,98,268,36);profiles.Click+=delegate{try{using(var dialog=new ProfileForm(Installed()))dialog.ShowDialog(this);}catch(Exception error){status.Text=error.Message;}};
            LabelAt(runtime,"이미 저장된 실행 환경은 그대로 사용할 수 있습니다.\r\n외부 서버 연결은 Chrome 확장 옵션에서 설정할 수 있습니다.",0,182,656,56).ForeColor=Muted;
            LabelAt(runtime,"설정을 마쳤으면 [다음]을 누르세요.",0,264,656).ForeColor=Muted;
            var check=LabelAt(done,"✓",0,30,56,60);check.Font=new Font("Segoe UI Symbol",32F);check.ForeColor=Color.FromArgb(24,128,74);
            var complete=LabelAt(done,"설정이 끝났습니다.",76,40,560,38);complete.Font=new Font(Font.FontFamily,16F,FontStyle.Bold);
            LabelAt(done,"Chrome에서 AgentBrowser 아이콘을 눌러 시작하세요.\r\n\r\n다음부터는 설치 관리자를 열 필요가 없습니다.",76,102,560,94);
            status.Multiline=true;status.ReadOnly=true;status.BorderStyle=BorderStyle.None;status.BackColor=Color.White;status.ForeColor=Muted;status.ScrollBars=ScrollBars.None;status.TextChanged+=delegate{status.ScrollBars=status.Lines.Length>2?ScrollBars.Vertical:ScrollBars.None;};status.TabStop=false;Position(this,status,"Status",32,450,656,44);
            var footer=new Panel{BackColor=Color.FromArgb(246,247,249)};footer.SetBounds(0,508,720,56);Controls.Add(footer);
            var footerLine=new Panel{BackColor=Border};footerLine.SetBounds(0,0,720,1);footer.Controls.Add(footerLine);
            back.Text="< 뒤로";Position(footer,back,"Back",384,520-508,96,32);back.Click+=delegate{status.Clear();if(page<3)plan=null;SetPage(page==2?1:page==5?4:page==6?5:0);};
            prepare.Text="다음 >";Position(footer,prepare,"Preview",488,12,96,32);StyleButton(prepare,true);prepare.Click+=async delegate{if(page==0){SetPage(1);status.Clear();}else if(page==1)await Prepare();else if(page==4)await PreparePairing();else if(page==5){SetPage(6);status.Clear();}else if(page==6){SetPage(7);status.Clear();}};
            apply.Text="설치";Position(footer,apply,"Apply",488,12,96,32);StyleButton(apply,true);apply.Click+=async delegate{await Apply();};
            cancel.Text="취소";Position(footer,cancel,"Cancel",600,12,96,32);cancel.Click+=delegate{if(working&&cancellation!=null){cancellation.Cancel();status.Text="취소 중입니다. 변경 사항을 복구할 때까지 기다려 주세요.";}else Close();};
            FormClosing+=delegate(object sender,FormClosingEventArgs e){if(working){e.Cancel=true;if(cancellation!=null)cancellation.Cancel();status.Text="작업이 끝날 때까지 기다려 주세요.";}};
            operation.SelectedIndexChanged+=delegate{package.Enabled=operation.SelectedIndex!=2;register.Enabled=operation.SelectedIndex!=2;startup.Enabled=operation.SelectedIndex!=2;advancedToggle.Enabled=operation.SelectedIndex!=2;manage.Enabled=operation.SelectedIndex!=2&&profiles.Enabled;};
            folder.TextChanged+=delegate{revision++;manage.Enabled=profiles.Enabled=false;};folder.Leave+=delegate{LoadState();};
            foreach(Control field in new Control[]{config,kind,distribution,operation})field.TextChanged+=delegate{revision++;};
            LoadState();SetPage(0);
            installs.Enabled=false;
            var scan=installedDiscovery??new Func<DiscoveryResult>(Discovery.InstalledPaths);
            Shown+=async delegate{if(!Has(args,"--no-discover"))await DiscoverInstallations(scan);};
        }
        void SetPage(int value){
            revision++;page=value;welcome.Visible=page==0;input.Visible=page==1;review.Visible=page==2||page==3;connection.Visible=page==4;pairing.Visible=page==5;runtime.Visible=page==6;done.Visible=page==7;
            preview.Visible=page==2;installing.Visible=progress.Visible=page==3;
            heading.Text=new[]{"AgentBrowser 설치","설치 위치 선택","설치 준비 완료","설치 중","Chrome 확장 추가","Chrome 연결","OpenCode 설정","설정 완료"}[page];
            steps.Text=new[]{"설치 마법사에 오신 것을 환영합니다.","프로그램을 설치할 폴더를 선택하세요.","아래 내용을 확인한 뒤 [설치]를 누르세요.","잠시 기다려 주세요.","Chrome에서 한 번만 진행하면 됩니다.","추가한 확장 프로그램과 연결합니다.","기존 OpenCode의 실행 환경을 선택합니다.","AgentBrowser를 사용할 준비가 되었습니다."}[page];
            if(operation.SelectedIndex==2&&page>=2){heading.Text=page==7?"제거 완료":"AgentBrowser 제거";steps.Text=page==7?"페어링과 프로필 데이터는 보존했습니다.":"제거할 설치 위치를 확인하세요.";}
            back.Visible=page==1||page==2||page==5||page==6;prepare.Visible=page==0||page==1||page==4||page==5||page==6;apply.Visible=page==2;apply.Text=operation.SelectedIndex==2?"제거":operation.SelectedIndex==1?"업데이트":"설치";
            if(page==2)steps.Text="아래 내용을 확인한 뒤 ["+apply.Text+"]를 누르세요.";
            cancel.Text=page==7?"마침":page>=4?"닫기":"취소";StyleButton(cancel,page==7);AcceptButton=(page==0||page==1||page==4||page==5||page==6)?prepare:page==2?apply:page==7?cancel:null;
        }
        void LoadState(){
            manage.Enabled=profiles.Enabled=false;
            try{var old=InstallerEngine.State(folder.Text);bool changed=!InstallerEngine.Same(loadedFolder,folder.Text);if(old!=null){if(changed){if(operation.SelectedIndex!=2)operation.SelectedIndex=1;port.Value=old.Port;startup.Checked=old.Startup!=null;if(old.Startup!=null)startupPath.Text=Path.GetDirectoryName(old.Startup.Path);}profiles.Enabled=true;manage.Enabled=operation.SelectedIndex!=2;status.Text="기존 설치 "+old.Version+"을 찾았습니다.";}else{if(operation.SelectedIndex==1)operation.SelectedIndex=0;status.Clear();}loadedFolder=folder.Text;}catch(Exception error){status.Text=error.Message;}
        }
        InstallState Installed(){
            var state=InstallerEngine.State(folder.Text);if(state==null)throw new IOException("아직 설치되지 않았습니다. [다음]을 눌러 설치를 완료하세요.");
            InstallerEngine.Root(folder.Text);InstallerEngine.Owned(state);
            var extensionFiles=state.OwnedFiles.Where(file=>file.Path.Replace('\\','/').StartsWith("extension/",StringComparison.OrdinalIgnoreCase)).ToArray();
            if(!extensionFiles.Any(file=>InstallerEngine.Same(file.Path.Replace('\\','/'),"extension/manifest.json")))throw new IOException("설치 기록에 Chrome 확장이 없습니다. 설치 폴더를 확인하세요.");
            foreach(var file in extensionFiles){string path=NativeIO.SafePath(state.InstallDir,file.Path);if(!File.Exists(path))throw new IOException("Chrome 확장 파일이 없습니다. 업데이트로 복구한 뒤 연결하세요: "+path);}
            return state;
        }
        bool ShowConnection(){try{if(operation.SelectedIndex==2)throw new IOException("제거하려면 [다음]을 눌러 진행하세요. 연결 설정은 설치 또는 업데이트에서 열 수 있습니다.");var state=Installed();extensionFolder.Text=Path.Combine(state.InstallDir,"extension");profiles.Enabled=true;SetPage(4);status.Clear();return true;}catch(Exception error){status.Text=error.Message;return false;}}
        void ShowAdvanced(){
            using(var dialog=new Form{Text="AgentBrowser 고급 설정",ClientSize=new Size(800,404),Font=Font,BackColor=Color.White,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false,StartPosition=FormStartPosition.CenterParent}){
                advanced.Parent=dialog;advanced.Location=new Point(20,20);advanced.Visible=true;
                var close=new Button{Text="확인"};Position(dialog,close,"CloseAdvanced",680,358,100,32);StyleButton(close,true);close.Click+=delegate{dialog.Close();};dialog.AcceptButton=close;
                try{dialog.ShowDialog(this);}finally{advanced.Visible=false;advanced.Parent=input;}
            }
        }
        async Task PreparePairing(){
            if(working)return;working=true;prepare.Enabled=false;cancel.Enabled=false;status.Text="Chrome 연결을 준비하고 있습니다.";
            try{var state=Installed();await Task.Run(()=>BridgeControl.Start(state));var data=InstallerEngine.Read<Dictionary<string,object>>(Path.Combine(state.DataDir,"config.json"));string token=(string)data["token"];
                if(!System.Text.RegularExpressions.Regex.IsMatch(token??"","^[a-fA-F0-9]{64}$"))throw new IOException("페어링 토큰을 확인할 수 없습니다.");pairingUrl.Text="ws://127.0.0.1:"+state.Port+"/extension";pairingToken.Text=token;SetPage(5);status.Clear();
            }catch(Exception error){status.Text=error.Message;}finally{working=false;prepare.Enabled=true;cancel.Enabled=true;}
        }
        async Task DiscoverInstallations(Func<DiscoveryResult> scan){
            int current=revision;
            try{var result=await Task.Run(scan);if(IsDisposed||Disposing)return;
                installs.Items.Clear();foreach(string path in result.Installs)installs.Items.Add(path);installs.Enabled=installs.Items.Count>0;
                if(current==revision&&result.Notices.Count>0)status.Text=String.Join("\r\n",result.Notices);
            }catch(Exception error){if(!IsDisposed&&!Disposing&&current==revision)status.Text=error.Message;}
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
        async Task Prepare(){
            if(working)return;working=true;prepare.Enabled=false;back.Enabled=false;input.Enabled=false;status.Text="설치 위치와 파일을 확인하고 있습니다.";
            try{
                if(operation.SelectedIndex!=2&&register.Checked&&selected.Count==0)throw new IOException("CLI에 등록할 설정을 먼저 추가하세요.");
                var options=new SetupOptions{Operation=new[]{"install","update","uninstall"}[operation.SelectedIndex],InstallDir=folder.Text,PackageDir=package.Text,Port=(int)port.Value,Start=start.Checked,Startup=startup.Checked,StartupDir=startupPath.Text};
                if(options.Operation!="uninstall"&&register.Checked)options.Registrations.AddRange(selected);
                plan=await Task.Run(()=>InstallerEngine.Prepare(options));
                preview.Text=plan.Preview;
                SetPage(2);status.Text="준비가 완료됐습니다.";
            }catch(Exception error){plan=null;status.Text=error.Message;}finally{working=false;prepare.Enabled=true;back.Enabled=true;input.Enabled=true;}
        }
        async Task Apply(){
            if(working||plan==null)return;working=true;cancellation=new CancellationTokenSource();SetPage(3);status.Text="설치 중입니다.";
            try{var result=await Task.Run(()=>InstallerEngine.Apply(plan,cancellation.Token,message=>BeginInvoke((Action)(()=>status.Text=message))));
                if(plan.Next!=null){
                    if(!ShowConnection()){
                        string failure=status.Text;plan=null;loadedFolder=null;LoadState();SetPage(0);
                        heading.Text="연결 준비 실패";steps.Text="설치 파일을 확인한 뒤 연결 설정을 다시 열어 주세요.";cancel.Text="닫기";
                        status.Text="설치 파일은 저장됐지만 연결 준비에 실패했습니다.\r\n"+failure;
                        int warningIndex=result.IndexOf("경고:",StringComparison.Ordinal);if(warningIndex>=0)status.Text+="\r\n"+result.Substring(warningIndex);
                        return;
                    }
                }else{manage.Enabled=profiles.Enabled=false;SetPage(7);done.Visible=false;review.Visible=true;preview.Visible=true;preview.Text=result;}
                status.Text=plan.Next==null?"제거 완료.":"설치 완료.";
                int warning=result.IndexOf("경고:",StringComparison.Ordinal);if(warning>=0)status.Text=result.Substring(warning);
            }catch(OperationCanceledException){SetPage(2);status.Text="취소됐습니다. 변경 사항을 복구했습니다.";}
            catch(Exception error){SetPage(2);status.Text=error.Message+"\r\n[뒤로]를 눌러 확인하고 다시 시도하세요.";}
            finally{working=false;cancellation.Dispose();cancellation=null;}
        }
    }
    internal static class Program {
        // Installed maintenance runs outside its owned files so Windows can remove
        // or replace them. Reuse only an exact-hash private per-user maintenance executable.
        internal static void PrepareMaintenanceCache(string cache) {InstallerEngine.Root(cache);InstallerEngine.PrivateDirectory(cache);InstallerEngine.Root(cache);}
        static bool RelaunchInstalled(string[] args) {
            string exe=Application.ExecutablePath;var directory=Directory.GetParent(exe);if(directory==null)return false;
            // Legacy scripts put the GUI at the install root; updates retain old
            // versioned GUIs. Any owned running copy would otherwise lock removal.
            string root=directory.Parent!=null&&directory.Parent.Name=="app"&&directory.Parent.Parent!=null?directory.Parent.Parent.FullName:directory.FullName;
            var state=InstallerEngine.State(root);if(state==null)return false;
            InstallerEngine.Owned(state);string hash=NativeIO.FileHash(exe);
            if(!state.OwnedFiles.Any(f=>InstallerEngine.Same(NativeIO.SafePath(root,f.Path),exe)&&InstallerEngine.Same(f.Sha256,hash)))throw new IOException("Installed setup ownership is invalid.");
            string cache=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AgentBrowser-Setup",hash);PrepareMaintenanceCache(cache);string copy=Path.Combine(cache,"AgentBrowser-Setup.exe");
            if(File.Exists(copy)){NativeIO.PlainPath(copy);if(NativeIO.FileHash(copy)!=hash)throw new IOException("Maintenance setup ownership is invalid.");}
            else {File.Copy(exe,copy);if(NativeIO.FileHash(copy)!=hash)throw new IOException("Maintenance setup verification failed.");}
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

