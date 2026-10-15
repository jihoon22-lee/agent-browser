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
        readonly Button prepare=new Button(),apply=new Button(),back=new Button(),cancel=new Button(),discover=new Button(),add=new Button(),manage=new Button();
        readonly ComboBox runtimeKind=new ComboBox(),runtimeDistribution=new ComboBox(),runtimeCandidates=new ComboBox();
        readonly TextBox runtimeExecutable=new TextBox(),runtimeDirectory=new TextBox();
        readonly Button startDistribution=new Button(),browseRuntimeDirectory=new Button(),saveRuntime=new Button();
        readonly Label runtimeResult=new Label();readonly ListBox savedProfiles=new ListBox();
        bool runtimeDiscovered;
        readonly ListBox doneChecks=new ListBox();readonly Label complete=new Label();
        readonly ListBox registrations=new ListBox();
        readonly Panel welcome=new Panel(),input=new Panel(),advanced=new Panel(),review=new Panel(),connection=new Panel(),pairing=new Panel(),runtime=new Panel(),done=new Panel();
        readonly Label heading=new Label(),steps=new Label(),installing=new Label(),extensionDetected=new Label(),pairingCode=new Label(),pairingState=new Label();
        readonly Button openExtensions=new Button(),connectChrome=new Button();
        readonly System.Windows.Forms.Timer detect=new System.Windows.Forms.Timer();
        bool detecting;
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
            SuspendLayout();
            args=arguments;Text="AgentBrowser 설치";Name="AgentBrowserSetup";ClientSize=new Size(720,600);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;Font=new Font("Malgun Gothic",10F);ForeColor=Ink;BackColor=Color.White;AutoScaleMode=AutoScaleMode.Font;AutoScaleDimensions=new SizeF(7F,17F);
            heading.Font=new Font(Font.FontFamily,18F,FontStyle.Bold);Position(this,heading,"PageTitle",32,24,656,36);
            steps.ForeColor=Muted;Position(this,steps,"SetupSteps",32,68,656,30);
            var line=new Panel{BackColor=Border};line.SetBounds(0,108,720,1);Controls.Add(line);
            var panels=new[]{welcome,input,review,connection,pairing,runtime,done};var names=new[]{"WelcomePanel","SettingsPanel","PreviewPanel","ConnectionPanel","PairingPanel","RuntimePanel","DonePanel"};
            for(int i=0;i<panels.Length;i++)Position(this,panels[i],names[i],32,132,656,panels[i]==runtime?372:308);
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
            openExtensions.Text="Chrome 확장 페이지 열기";Position(connection,openExtensions,"OpenExtensions",176,184,220,34);openExtensions.Click+=delegate{OpenChromeExtensions();};
            extensionDetected.ForeColor=Muted;extensionDetected.Text="확장을 추가하면 여기에서 자동으로 확인합니다. 추가한 뒤 [다음]을 누르세요.";Position(connection,extensionDetected,"ExtensionDetected",0,240,656,42);
            LabelAt(pairing,"[Chrome에 연결]을 누르면 6자리 코드가 표시됩니다. Chrome의 AgentBrowser 설정에서 그 코드를 입력하세요.",0,0,656,48);
            connectChrome.Text="Chrome에 연결";Position(pairing,connectChrome,"ConnectChrome",0,54,220,38);StyleButton(connectChrome,true);connectChrome.Click+=async delegate{await ConnectChrome();};
            pairingCode.Font=new Font(Font.FontFamily,Font.Size*2F,FontStyle.Bold);pairingCode.ForeColor=Ink;Position(pairing,pairingCode,"PairingCode",236,50,420,46);
            pairingState.ForeColor=Muted;Position(pairing,pairingState,"PairingState",0,102,656,44);
            LabelAt(pairing,"코드 대신 직접 입력할 때: 확장 설정의 Bridge 주소·페어링 토큰 칸에 아래 값을 넣고 [저장 후 연결]",0,152,656,28).ForeColor=Muted;
            pairingUrl.ReadOnly=true;Position(pairing,pairingUrl,"PairingUrl",0,182,656);
            pairingToken.ReadOnly=true;pairingToken.UseSystemPasswordChar=true;Position(pairing,pairingToken,"PairingToken",0,220,480);
            var copyToken=new Button{Text="토큰 복사"};Position(pairing,copyToken,"CopyPairingToken",496,218,160,32);copyToken.Click+=delegate{Clipboard.SetText(pairingToken.Text);status.Text="토큰을 복사했습니다. Chrome 확장 옵션에 붙여 넣으세요.";};
            LabelAt(runtime,"사용할 OpenCode를 확인하고 [저장하고 연결 확인]을 누르세요.",0,0,656,28);
            LabelAt(runtime,"실행 방식",0,40);Position(runtime,runtimeKind,"RuntimeKind",150,36,160);runtimeKind.DropDownStyle=ComboBoxStyle.DropDownList;runtimeKind.Items.AddRange(new object[]{"Windows","WSL"});runtimeKind.SelectedIndex=0;
            LabelAt(runtime,"WSL 배포판",330,40,110);Position(runtime,runtimeDistribution,"RuntimeDistribution",440,36,216);runtimeDistribution.DropDownStyle=ComboBoxStyle.DropDown;
            startDistribution.Text="배포판 켜고 찾기";Position(runtime,startDistribution,"StartDistribution",440,72,216,30);startDistribution.Click+=async delegate{await DiscoverRuntime(runtimeDistribution.Text.Trim());};
            LabelAt(runtime,"찾은 OpenCode",0,112);Position(runtime,runtimeCandidates,"RuntimeCandidates",150,108,506);runtimeCandidates.DropDownStyle=ComboBoxStyle.DropDownList;runtimeCandidates.SelectedIndexChanged+=delegate{UseRuntimeCandidate();};
            LabelAt(runtime,"실행 파일",0,148);Position(runtime,runtimeExecutable,"RuntimeExecutable",150,144,506);
            LabelAt(runtime,"작업 폴더",0,184);Position(runtime,runtimeDirectory,"RuntimeDirectory",150,180,390);
            browseRuntimeDirectory.Text="폴더 선택";Position(runtime,browseRuntimeDirectory,"BrowseRuntimeDirectory",548,178,108,32);browseRuntimeDirectory.Click+=delegate{if(runtimeKind.SelectedIndex==1){status.Text="WSL 작업 폴더는 /home/<사용자>/project 같은 Linux 경로로 입력하세요.";return;}using(var dialog=new FolderBrowserDialog{Description="OpenCode 작업 폴더",SelectedPath=runtimeDirectory.Text})if(dialog.ShowDialog(this)==DialogResult.OK)runtimeDirectory.Text=dialog.SelectedPath;};
            saveRuntime.Text="저장하고 연결 확인";Position(runtime,saveRuntime,"SaveRuntime",0,222,220,36);StyleButton(saveRuntime,true);saveRuntime.Click+=async delegate{await SaveRuntime();};
            runtimeResult.ForeColor=Muted;Position(runtime,runtimeResult,"RuntimeResult",230,222,426,52);
            LabelAt(runtime,"저장된 실행 환경 (Chrome 설정에도 같은 목록이 보입니다)",0,280,656,24).ForeColor=Muted;
            Position(runtime,savedProfiles,"SavedProfiles",0,304,656,64);
            var check=LabelAt(done,"✓",0,30,56,60);check.Font=new Font("Segoe UI Symbol",32F);check.ForeColor=Color.FromArgb(24,128,74);
            complete.Text="설정이 끝났습니다.";Position(done,complete,"CompleteTitle",76,40,560,38);complete.Font=new Font(Font.FontFamily,16F,FontStyle.Bold);
            LabelAt(done,"Chrome에서 AgentBrowser 아이콘을 눌러 시작하세요.\r\n다음부터는 설치 관리자를 열 필요가 없습니다.",76,96,560,56);
            Position(done,doneChecks,"DoneChecks",76,160,580,120);
            status.Multiline=true;status.ReadOnly=true;status.BorderStyle=BorderStyle.None;status.BackColor=Color.White;status.ForeColor=Muted;status.ScrollBars=ScrollBars.None;status.TextChanged+=delegate{status.ScrollBars=status.Lines.Length>2?ScrollBars.Vertical:ScrollBars.None;};status.TabStop=false;Position(this,status,"Status",32,450,656,44);
            var footer=new Panel{BackColor=Color.FromArgb(246,247,249)};footer.SetBounds(0,508,720,56);Controls.Add(footer);
            var footerLine=new Panel{BackColor=Border};footerLine.SetBounds(0,0,720,1);footer.Controls.Add(footerLine);
            back.Text="< 뒤로";Position(footer,back,"Back",384,520-508,96,32);back.Click+=delegate{status.Clear();if(page<3)plan=null;SetPage(page==2?1:page==5?4:page==6?5:0);};
            prepare.Text="다음 >";Position(footer,prepare,"Preview",488,12,96,32);StyleButton(prepare,true);prepare.Click+=async delegate{if(page==0){SetPage(1);status.Clear();}else if(page==1)await Prepare();else if(page==4)await PreparePairing();else if(page==5){SetPage(6);status.Clear();await EnterRuntimePage();}else if(page==6){SetPage(7);status.Clear();await RunDoneChecks();}};
            apply.Text="설치";Position(footer,apply,"Apply",488,12,96,32);StyleButton(apply,true);apply.Click+=async delegate{await Apply();};
            cancel.Text="취소";Position(footer,cancel,"Cancel",600,12,96,32);cancel.Click+=delegate{if(working&&cancellation!=null){cancellation.Cancel();status.Text="취소 중입니다. 변경 사항을 복구할 때까지 기다려 주세요.";}else Close();};
            FormClosing+=delegate(object sender,FormClosingEventArgs e){if(working){e.Cancel=true;if(cancellation!=null)cancellation.Cancel();status.Text="작업이 끝날 때까지 기다려 주세요.";}};
            operation.SelectedIndexChanged+=delegate{package.Enabled=operation.SelectedIndex!=2;register.Enabled=operation.SelectedIndex!=2;startup.Enabled=operation.SelectedIndex!=2;advancedToggle.Enabled=operation.SelectedIndex!=2;manage.Enabled=operation.SelectedIndex!=2&&InstalledHere();};
            folder.TextChanged+=delegate{revision++;manage.Enabled=false;};folder.Leave+=delegate{LoadState();};
            foreach(Control field in new Control[]{config,kind,distribution,operation})field.TextChanged+=delegate{revision++;};
            detect.Interval=1500;detect.Tick+=async delegate{await DetectExtension();};
            LoadState();SetPage(0);
            installs.Enabled=false;
            var scan=installedDiscovery??new Func<DiscoveryResult>(Discovery.InstalledPaths);
            Shown+=async delegate{if(!Has(args,"--no-discover"))await DiscoverInstallations(scan);};
            // Keep navigation visible on small displays; only the page content scrolls.
            var header=new Panel{Dock=DockStyle.Top,Height=110,BackColor=Color.White};
            header.Controls.Add(heading);header.Controls.Add(steps);header.Controls.Add(line);
            var bottom=new Panel{Dock=DockStyle.Bottom,Height=124,BackColor=Color.White};
            status.Location=new Point(32,8);status.Height=52;bottom.Controls.Add(status);
            footer.Dock=DockStyle.Bottom;bottom.Controls.Add(footer);
            var navigation=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.RightToLeft,WrapContents=false,Padding=new Padding(12,9,12,9)};
            foreach(var button in new[]{cancel,prepare,apply,back}){button.Margin=new Padding(6,0,6,0);navigation.Controls.Add(button);}
            footer.Controls.Add(navigation);footerLine.Dock=DockStyle.Top;footerLine.BringToFront();
            status.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;heading.Anchor=steps.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            FontChanged+=delegate{heading.Font=new Font(Font.FontFamily,Font.Size*1.8F,FontStyle.Bold);complete.Font=new Font(Font.FontFamily,Font.Size*1.6F,FontStyle.Bold);check.Font=new Font("Segoe UI Symbol",Font.Size*3.2F);};
            var body=new Panel{Name="PageViewport",Dock=DockStyle.Fill,AutoScroll=true,AutoScrollMinSize=new Size(720,412)};
            foreach(var panel in panels){panel.Location=new Point(32,20);body.Controls.Add(panel);}
            Controls.Add(body);Controls.Add(bottom);Controls.Add(header);
            FormBorderStyle=FormBorderStyle.Sizable;MaximizeBox=true;
            MinimumSize=new Size(520,420);
            ResumeLayout(true);
            Shown+=delegate{var area=Screen.FromControl(this).WorkingArea;if(Height>area.Height||Width>area.Width){Size=new Size(Math.Min(Width,area.Width),Math.Min(Height,area.Height));Location=area.Location;}};
        }
        void SetPage(int value){
            revision++;page=value;welcome.Visible=page==0;input.Visible=page==1;review.Visible=page==2||page==3;connection.Visible=page==4;pairing.Visible=page==5;runtime.Visible=page==6;done.Visible=page==7;
            preview.Visible=page==2;installing.Visible=progress.Visible=page==3;
            heading.Text=new[]{"AgentBrowser 설치","설치 위치 선택","설치 준비 완료","설치 중","Chrome 확장 추가","Chrome 연결","OpenCode 설정","설정 완료"}[page];
            steps.Text=new[]{"설치 마법사에 오신 것을 환영합니다.","프로그램을 설치할 폴더를 선택하세요.","아래 내용을 확인한 뒤 [설치]를 누르세요.","잠시 기다려 주세요.","Chrome에서 한 번만 진행하면 됩니다.","추가한 확장 프로그램과 연결합니다.","기존 OpenCode의 실행 환경을 선택합니다.","AgentBrowser를 사용할 준비가 되었습니다."}[page];
            if(operation.SelectedIndex==2&&page>=2){heading.Text=page==7?"제거 완료":"AgentBrowser 제거";steps.Text=page==7?"페어링과 프로필 데이터는 보존했습니다.":"제거할 설치 위치를 확인하세요.";}
            back.Visible=page==1||page==2||page==5||page==6;prepare.Visible=page==0||page==1||page==4||page==5||page==6;apply.Visible=page==2;apply.Text=operation.SelectedIndex==2?"제거":operation.SelectedIndex==1?"업데이트":"설치";
            if(page==2)steps.Text="아래 내용을 확인한 뒤 ["+apply.Text+"]를 누르세요.";
            detect.Enabled=page==4;
            cancel.Text=page==7?"마침":page>=4?"닫기":"취소";StyleButton(cancel,page==7);AcceptButton=(page==0||page==1||page==4||page==5||page==6)?prepare:page==2?apply:page==7?cancel:null;
        }
        void OpenChromeExtensions(){
            try{
                string chrome=ChromePath();
                if(chrome==null)throw new IOException("Chrome을 찾지 못했습니다.");
                if(!Has(args,"--no-browser-launch"))Process.Start(new ProcessStartInfo(chrome,"chrome://extensions"){UseShellExecute=false});
                Clipboard.SetText(extensionFolder.Text);
                status.Text="Chrome 확장 페이지를 열고 폴더 경로를 복사했습니다. 개발자 모드를 켜고 [압축해제된 확장 프로그램 로드]에서 Alt+D 후 붙여 넣으세요.";
            }catch(Exception error){Clipboard.SetText(extensionFolder.Text);status.Text="Chrome을 직접 열고 주소창에 chrome://extensions 를 입력하세요. 폴더 경로는 복사했습니다.\r\n("+error.Message+")";}
        }
        static string ChromePath(){
            foreach(var hive in new[]{"HKEY_CURRENT_USER","HKEY_LOCAL_MACHINE"}){var value=Microsoft.Win32.Registry.GetValue(hive+@"\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe","",null) as string;if(!String.IsNullOrEmpty(value)&&File.Exists(value))return value;}
            return null;
        }
        async Task DetectExtension(){
            if(page!=4||detecting)return;detecting=true;
            try{
                var state=Installed();string id=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
                await Task.Run(()=>BridgeControl.Start(state));
                var current=await Task.Run(()=>Pairing.Status(state));
                if(page==4&&Pairing.Seen(current,id))extensionDetected.Text="✓ Chrome에 AgentBrowser 확장이 추가되었습니다. [다음]을 누르세요.";
            }catch(Exception){/* Detection is only a hint; the next step reports real errors. */}
            finally{detecting=false;}
        }
        async Task OpenPairingCode(){
            var state=Installed();string id=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
            await Task.Run(()=>BridgeControl.Start(state));
            var opened=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"pair","--open","--extension-id",id,"--seconds","180"})));
            string code=(string)opened["code"];
            pairingCode.Text=code.Substring(0,3)+" "+code.Substring(3);
            pairingState.Text="Chrome의 AgentBrowser 설정(확장 세부정보 → 확장 프로그램 옵션)에서 이 코드를 입력하고 [코드로 연결]을 누르세요. 3분 동안 유효합니다.";
            string chrome=ChromePath();
            if(chrome!=null&&!Has(args,"--no-browser-launch"))try{Process.Start(new ProcessStartInfo(chrome,"chrome-extension://"+id+"/src/options/index.html"){UseShellExecute=false});}catch(Exception){/* The user can open Options manually. */}
        }
        async Task ConnectChrome(){
            if(working)return;working=true;connectChrome.Enabled=false;
            try{
                await OpenPairingCode();
                var state=Installed();string id=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
                for(int i=0;i<180&&!IsDisposed;i++){
                    var current=await Task.Run(()=>Pairing.Status(state));
                    if(Pairing.Connected(current,id)){pairingState.Text="✓ Chrome과 연결되었습니다.";pairingCode.Text="";SetPage(6);status.Clear();await EnterRuntimePage();return;}
                    await Task.Delay(1000);
                }
                pairingState.Text="연결을 확인하지 못했습니다. 코드를 정확히 입력했는지 확인하고 [Chrome에 연결]을 다시 누르거나, 아래 토큰을 직접 입력하세요.";
            }catch(Exception error){pairingState.Text=Friendly.Message(error);}
            finally{working=false;if(!IsDisposed)connectChrome.Enabled=true;}
        }
        async Task RunDoneChecks(){
            complete.Text="설정이 끝났습니다.";doneChecks.Items.Clear();doneChecks.Items.Add("연결 상태를 확인하고 있습니다…");
            try{
                var state=Installed();string id=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
                var current=await Task.Run(()=>Pairing.Status(state));
                var doctor=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"doctor","--json"},60000)));
                doneChecks.Items.Clear();foreach(var line in DoneChecks.Lines(current,doctor,id))doneChecks.Items.Add(line);
            }catch(Exception error){doneChecks.Items.Clear();doneChecks.Items.Add("✗ "+Friendly.Message(error));}
            if(doneChecks.Items.Cast<object>().Any(item=>item.ToString().StartsWith("✗")))complete.Text="설정을 마무리하세요.";
        }
        bool InstalledHere(){try{return InstallerEngine.State(folder.Text)!=null;}catch(Exception){return false;}}
        async Task EnterRuntimePage(){
            await RefreshSavedProfiles();
            if(!runtimeDiscovered&&!Has(args,"--no-discover")){runtimeDiscovered=true;await DiscoverRuntime(null);}
        }
        async Task RefreshSavedProfiles(){
            try{
                var state=Installed();
                var listed=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"profile","list","--json"})));
                savedProfiles.Items.Clear();object def;listed.TryGetValue("defaultProfileId",out def);
                foreach(var item in ((System.Collections.IEnumerable)listed["profiles"]).OfType<Dictionary<string,object>>())
                    savedProfiles.Items.Add((item["id"] as string==def as string?"★ ":"")+item["name"]+" · "+item["kind"]+" · "+item["directory"]);
                if(savedProfiles.Items.Count==0)savedProfiles.Items.Add("아직 없습니다");
            }catch(Exception error){runtimeResult.Text=Friendly.Message(error);}
        }
        async Task DiscoverRuntime(string distribution){
            startDistribution.Enabled=false;runtimeResult.Text="OpenCode 위치를 확인하고 있습니다…";
            try{
                var found=await Task.Run(()=>{
                    if(String.IsNullOrEmpty(distribution))return Discovery.Find();
                    var single=new DiscoveryResult();single.Distributions.Add(distribution);single.OpenCode.AddRange(Discovery.FindWsl(distribution,null));return single;
                });
                foreach(var d in found.Distributions)if(!runtimeDistribution.Items.Contains(d))runtimeDistribution.Items.Add(d);
                runtimeCandidates.Items.Clear();foreach(var c in found.OpenCode)runtimeCandidates.Items.Add(c);
                if(runtimeCandidates.Items.Count>0)runtimeCandidates.SelectedIndex=0;
                runtimeResult.Text=runtimeCandidates.Items.Count>0?"OpenCode "+runtimeCandidates.Items.Count+"개를 찾았습니다. 확인 후 [저장하고 연결 확인]을 누르세요.":"OpenCode를 찾지 못했습니다. 실행 파일 경로를 직접 입력하세요."+(found.Notices.Count>0?"\r\n"+String.Join("\r\n",found.Notices):"");
            }catch(Exception error){runtimeResult.Text=Friendly.Message(error);}
            finally{startDistribution.Enabled=true;}
        }
        void UseRuntimeCandidate(){
            var c=runtimeCandidates.SelectedItem as OpenCodeCandidate;if(c==null)return;
            runtimeKind.SelectedIndex=c.Kind=="wsl"?1:0;runtimeDistribution.Text=c.Distribution??"";runtimeExecutable.Text=c.Executable;if(String.IsNullOrWhiteSpace(runtimeDirectory.Text))runtimeDirectory.Text=c.Home;
        }
        async Task SaveRuntime(){
            if(working)return;working=true;saveRuntime.Enabled=false;runtimeResult.Text="실행 환경을 확인하고 있습니다…";
            try{
                var state=Installed();var chosen=runtimeCandidates.SelectedItem as OpenCodeCandidate;
                var candidate=new OpenCodeCandidate{Kind=runtimeKind.SelectedIndex==1?"wsl":"windows",Distribution=runtimeDistribution.Text.Trim(),Executable=runtimeExecutable.Text.Trim(),
                    User=chosen!=null&&chosen.Kind=="wsl"&&chosen.Executable==runtimeExecutable.Text.Trim()?chosen.User:null};
                string id="managed-"+Guid.NewGuid().ToString("N").Substring(0,8),name=candidate.Kind=="wsl"?"OpenCode ("+candidate.Distribution+")":"OpenCode (Windows)",directory=runtimeDirectory.Text.Trim();
                var profile=await Task.Run(()=>ManagedProfile.Prepare(state,candidate,id,name,directory));
                await Task.Run(()=>ManagedProfile.Save(state,profile,makeDefault:true));
                await RefreshSavedProfiles();
                if(Has(args,"--no-runtime-start")){runtimeResult.Text="✓ 저장했습니다. (시작 확인 생략)";return;}
                runtimeResult.Text="저장했습니다. OpenCode를 시작해 브라우저 연결을 확인하고 있습니다… (최대 1분)";
                runtimeResult.Text=await Task.Run(()=>ManagedProfile.Start(state,id));
            }catch(Exception error){runtimeResult.Text=Friendly.Message(error);}
            finally{working=false;saveRuntime.Enabled=true;}
        }
        void LoadState(){
            manage.Enabled=false;
            try{var old=InstallerEngine.State(folder.Text);bool changed=!InstallerEngine.Same(loadedFolder,folder.Text);if(old!=null){if(changed){if(operation.SelectedIndex!=2)operation.SelectedIndex=1;port.Value=old.Port;startup.Checked=old.Startup!=null;if(old.Startup!=null)startupPath.Text=Path.GetDirectoryName(old.Startup.Path);}manage.Enabled=operation.SelectedIndex!=2;status.Text="기존 설치 "+old.Version+"을 찾았습니다.";}else{if(operation.SelectedIndex==1)operation.SelectedIndex=0;status.Clear();}loadedFolder=folder.Text;}catch(Exception error){status.Text=Friendly.Message(error);}
        }
        InstallState Installed(){
            var state=InstallerEngine.State(folder.Text);if(state==null)throw new IOException("아직 설치되지 않았습니다. [다음]을 눌러 설치를 완료하세요.");
            InstallerEngine.Root(folder.Text);InstallerEngine.Owned(state);
            var extensionFiles=state.OwnedFiles.Where(file=>file.Path.Replace('\\','/').StartsWith("extension/",StringComparison.OrdinalIgnoreCase)).ToArray();
            if(!extensionFiles.Any(file=>InstallerEngine.Same(file.Path.Replace('\\','/'),"extension/manifest.json")))throw new IOException("설치 기록에 Chrome 확장이 없습니다. 설치 폴더를 확인하세요.");
            foreach(var file in extensionFiles){string path=NativeIO.SafePath(state.InstallDir,file.Path);if(!File.Exists(path))throw new IOException("Chrome 확장 파일이 없습니다. 업데이트로 복구한 뒤 연결하세요: "+path);}
            return state;
        }
        bool ShowConnection(){try{if(operation.SelectedIndex==2)throw new IOException("제거하려면 [다음]을 눌러 진행하세요. 연결 설정은 설치 또는 업데이트에서 열 수 있습니다.");var state=Installed();extensionFolder.Text=Path.Combine(state.InstallDir,"extension");SetPage(4);status.Clear();return true;}catch(Exception error){status.Text=Friendly.Message(error);return false;}}
        void ShowAdvanced(){
            // This panel has already scaled with the main form. Do not scale it again
            // when it moves into a dialog, or text and fields overlap at large fonts.
            int margin=(int)Math.Ceiling(20*Font.Size/10F),buttonHeight=(int)Math.Ceiling(32*Font.Size/10F);
            using(var dialog=new Form{Text="AgentBrowser 고급 설정",Font=Font,AutoScaleMode=AutoScaleMode.None,AutoScroll=true,BackColor=Color.White,FormBorderStyle=FormBorderStyle.Sizable,MaximizeBox=true,MinimizeBox=false,StartPosition=FormStartPosition.CenterParent}){
                advanced.Parent=dialog;advanced.Location=new Point(margin,margin);advanced.Visible=true;
                dialog.ClientSize=new Size(advanced.Width+2*margin,advanced.Height+3*margin+buttonHeight);
                var close=new Button{Text="확인"};Position(dialog,close,"CloseAdvanced",Math.Max(margin,advanced.Right-5*margin),advanced.Bottom+margin,5*margin,buttonHeight);StyleButton(close,true);close.Click+=delegate{dialog.Close();};dialog.AcceptButton=close;
                dialog.Shown+=delegate{var area=Screen.FromControl(dialog).WorkingArea;if(dialog.Height>area.Height||dialog.Width>area.Width){dialog.Size=new Size(Math.Min(dialog.Width,area.Width),Math.Min(dialog.Height,area.Height));dialog.Location=area.Location;}};
                try{dialog.ShowDialog(this);}finally{advanced.Visible=false;advanced.Parent=input;}
            }
        }
        async Task PreparePairing(){
            if(working)return;working=true;prepare.Enabled=false;cancel.Enabled=false;status.Text="Chrome 연결을 준비하고 있습니다.";
            try{var state=Installed();await Task.Run(()=>BridgeControl.Start(state));var data=InstallerEngine.Read<Dictionary<string,object>>(Path.Combine(state.DataDir,"config.json"));string token=(string)data["token"];
                if(!System.Text.RegularExpressions.Regex.IsMatch(token??"","^[a-fA-F0-9]{64}$"))throw new IOException("페어링 토큰을 확인할 수 없습니다.");pairingUrl.Text="ws://127.0.0.1:"+state.Port+"/extension";pairingToken.Text=token;SetPage(5);status.Clear();
            }catch(Exception error){status.Text=Friendly.Message(error);}finally{working=false;prepare.Enabled=true;cancel.Enabled=true;}
        }
        async Task DiscoverInstallations(Func<DiscoveryResult> scan){
            int current=revision;
            try{var result=await Task.Run(scan);if(IsDisposed||Disposing)return;
                installs.Items.Clear();foreach(string path in result.Installs)installs.Items.Add(path);installs.Enabled=installs.Items.Count>0;
                if(current==revision&&result.Notices.Count>0)status.Text=String.Join("\r\n",result.Notices);
            }catch(Exception error){if(!IsDisposed&&!Disposing&&current==revision)status.Text=Friendly.Message(error);}
        }
        async Task Discover() {
            if(!discover.Enabled||working)return;discover.Enabled=false;int current=revision;status.Text="OpenCode 위치를 확인하고 있습니다.";
            try {var result=await Task.Run(()=>Discovery.Find());if(IsDisposed||Disposing||current!=revision||working)return;
                candidates.Items.Clear();distribution.Items.Clear();installs.Items.Clear();foreach(var p in result.Installs)installs.Items.Add(p);foreach(var d in result.Distributions)distribution.Items.Add(d);foreach(var c in result.OpenCode)candidates.Items.Add(c);
                status.Text="기존 설치 "+result.Installs.Count+"개, OpenCode "+result.OpenCode.Count+"개를 찾았습니다.\r\n"+String.Join("\r\n",result.Notices);if(candidates.Items.Count==1)candidates.SelectedIndex=0;
            }catch(Exception error){if(!IsDisposed&&!Disposing&&current==revision)status.Text=Friendly.Message(error);}finally{if(!IsDisposed&&!Disposing)discover.Enabled=true;}
        }
        void SelectCandidate() {
            var c=candidates.SelectedItem as OpenCodeCandidate;if(c==null)return;kind.SelectedItem=c.Kind;distribution.Text=c.Distribution??"";
            if(c.Settings.Count==1)config.Text=c.Settings[0];else if(c.Settings.Count==0) config.Text=c.Kind=="wsl"?@"\\wsl.localhost\"+c.Distribution+(c.Home+"/.config/opencode/opencode.json").Replace('/','\\'):Path.Combine(c.Home,@".config\opencode\opencode.json");
            else {config.Clear();status.Text="설정 파일이 여러 개입니다. 사용할 파일 경로를 선택해 입력하세요:\r\n"+String.Join("\r\n",c.Settings);}
        }
        void AddRegistration() {
            if(!register.Checked){status.Text="CLI 등록을 선택한 뒤 설정 파일을 추가하세요.";return;}
            try {var c=candidates.SelectedItem as OpenCodeCandidate;string path=Path.GetFullPath(config.Text);if(selected.Any(x=>InstallerEngine.Same(x.Path,path)))throw new IOException("이미 추가한 설정입니다.");var entry=new McpRecord{Path=path,Kind=(string)kind.SelectedItem,Distribution=distribution.Text,User=c!=null&&c.Kind=="wsl"&&c.Distribution==distribution.Text?c.User:null};if(entry.Kind=="wsl"&&String.IsNullOrWhiteSpace(entry.Distribution))throw new IOException("WSL 배포판을 선택하세요.");selected.Add(entry);registrations.Items.Add(entry.Kind+" · "+path);status.Text="선택 목록에 추가했습니다. 미리보기 후 적용할 수 있습니다.";}catch(Exception error){status.Text=Friendly.Message(error);}
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
            }catch(Exception error){plan=null;status.Text=Friendly.Message(error);}finally{working=false;prepare.Enabled=true;back.Enabled=true;input.Enabled=true;}
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
                }else{manage.Enabled=false;SetPage(7);done.Visible=false;review.Visible=true;preview.Visible=true;preview.Text=result;}
                status.Text=plan.Next==null?"제거 완료.":"설치 완료.";
                int warning=result.IndexOf("경고:",StringComparison.Ordinal);if(warning>=0)status.Text=result.Substring(warning);
            }catch(OperationCanceledException){SetPage(2);status.Text="취소됐습니다. 변경 사항을 복구했습니다.";}
            catch(Exception error){SetPage(2);status.Text=Friendly.Message(error)+"\r\n[뒤로]를 눌러 확인하고 다시 시도하세요.";}
            finally{working=false;cancellation.Dispose();cancellation=null;}
        }
    }
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
        public static List<string> Lines(Dictionary<string,object> status,Dictionary<string,object> doctor,string extensionId){
            var lines=new List<string>{"✓ Bridge가 실행 중입니다."};
            lines.Add(Pairing.Connected(status,extensionId)?"✓ Chrome 확장이 연결되었습니다.":"✗ Chrome 확장이 연결되지 않았습니다. [뒤로]로 Chrome 연결 단계를 다시 진행하세요.");
            var runtimes=Checks(doctor).Where(c=>c.ContainsKey("id")&&c["id"] as string=="opencode").ToList();
            if(runtimes.Count==0)lines.Add("✗ 저장된 실행 환경이 없습니다. [뒤로]로 실행 환경을 저장하거나 Chrome 설정에서 추가하세요.");
            foreach(var check in runtimes){
                string state=check.ContainsKey("status")?check["status"] as string:null;
                lines.Add(state=="ok"?"✓ 실행 환경이 준비되었습니다.":state=="warning"?"• 실행 환경을 저장했습니다. 패널에서 처음 보낼 때 시작합니다.":"✗ 실행 환경 오류: "+(check.ContainsKey("message")?check["message"]:"")+" — Chrome 설정의 [시작·연결 확인]으로 확인하세요.");
            }
            foreach(var check in Checks(doctor).Where(c=>c.ContainsKey("id")&&c["id"] as string=="mcp"&&c.ContainsKey("status")&&c["status"] as string=="ok"))lines.Add("✓ 브라우저 도구(MCP)가 연결되었습니다.");
            return lines;
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
            new KeyValuePair<string,string>("Another operation is already managing this profile","같은 실행 환경을 다른 작업이 처리 중입니다. 잠시 후 다시 시도하세요."),
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
        [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool SetProcessDPIAware();
        [STAThread] public static int Main(string[] args) {
            try {
                if(args.Length==2&&args[0]=="--start") {var state=InstallerEngine.State(InstallerEngine.Root(args[1]));if(state==null)throw new IOException("설치 상태를 찾지 못했습니다.");BridgeControl.Start(state);return 0;}
                if(RelaunchInstalled(args))return 0;
                SetProcessDPIAware();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new SetupForm(args));return 0;
            } catch(Exception error) {MessageBox.Show(Friendly.Message(error),"AgentBrowser",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
        }
    }
}

