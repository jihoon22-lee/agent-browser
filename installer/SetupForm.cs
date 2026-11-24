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
        readonly TextBox folder=new TextBox(),package=new TextBox(),startupPath=new TextBox(),config=new TextBox(),preview=new TextBox(),extensionFolder=new TextBox(),pairingUrl=new TextBox(),pairingToken=new TextBox();
        readonly Notice status=new Notice(),pairingState=new Notice(),runtimeResult=new Notice(),advancedStatus=new Notice();
        readonly ComboBox operation=new ComboBox(),kind=new ComboBox(),distribution=new ComboBox(),candidates=new ComboBox(),installs=new ComboBox();
        readonly NumericUpDown port=new NumericUpDown();
        readonly CheckBox start=new CheckBox(),startup=new CheckBox(),register=new CheckBox();
        readonly Button prepare=new Button(),apply=new Button(),back=new Button(),cancel=new Button(),discover=new Button(),add=new Button(),manage=new Button();
        readonly ComboBox runtimeKind=new ComboBox(),runtimeDistribution=new ComboBox(),runtimeCandidates=new ComboBox();
        readonly TextBox runtimeExecutable=new TextBox(),runtimeDirectory=new TextBox();
        readonly Button startDistribution=new Button(),rediscoverRuntime=new Button(),browseRuntimeDirectory=new Button(),saveRuntime=new Button();
        readonly Button browseConfig=new Button(),removeRegistration=new Button();
        CancellationTokenSource pairingWait;string savedRuntimeId;readonly ListBox savedProfiles=new ListBox();
        bool runtimeDiscovered,discoveringRuntime;
        Font headingFont,completeFont,doneMarkFont,pairingCodeFont;
        /// The work folder this page filled in itself; a folder the user typed or picked is never replaced.
        string suggestedRuntimeDirectory;
        readonly ListBox doneChecks=new ListBox();readonly Label complete=new Label(),doneMark=new Label();
        readonly FlowLayoutPanel doneActions=new FlowLayoutPanel();
        readonly Button fixChrome=new Button(),fixRuntime=new Button(),recheck=new Button();
        /// Only the newest run of the final checks may update the page.
        int doneRun;
        readonly ListBox registrations=new ListBox();
        readonly Panel welcome=new Panel(),input=new Panel(),advanced=new Panel(),review=new Panel(),connection=new Panel(),pairing=new Panel(),runtime=new Panel(),done=new Panel();
        readonly Label heading=new Label(),steps=new Label(),installing=new Label(),extensionDetected=new Label(),pairingCode=new Label();
        readonly FlowLayoutPanel stepBar=new FlowLayoutPanel();Font stepBold;
        readonly Panel body=new Panel();
        bool detectionBridgeStarted;
        /// True while the Chrome step was opened going forward: a detected extension then moves on by itself.
        /// [뒤로] clears it, so going back is not undone.
        bool connectionAuto;
        /// The Bridge status query. Tests replace it to describe a paired or detected extension.
        internal Func<InstallState,Dictionary<string,object>> BridgeStatus=Pairing.Status;
        /// Verified once when the connection page opens; the detection timer only reads these.
        InstallState detectionState;string detectionExtensionId;
        readonly Button openExtensions=new Button(),connectChrome=new Button();
        readonly System.Windows.Forms.Timer detect=new System.Windows.Forms.Timer();
        bool detecting;
        readonly ProgressBar progress=new ProgressBar();
        readonly List<McpRecord> selected=new List<McpRecord>();
        readonly string[] args;InstallPlan plan;CancellationTokenSource cancellation;bool working;int revision,page;string loadedFolder;
        static readonly Color Ink=Color.FromArgb(28,33,40),Muted=Notice.Routine,Accent=Color.FromArgb(0,103,192),Border=Color.FromArgb(214,218,224);
        static readonly string[] InstallSteps={"설치","확장 추가","Chrome 연결","OpenCode","완료"},RemoveSteps={"제거","완료"};
        static string DefaultFolder {get{return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AgentBrowser");}}
        static string Arg(string[] args,string name,string fallback) {int index=Array.IndexOf(args,name);return index>=0&&index+1<args.Length?args[index+1]:fallback;}
        static int ParsePort(string text,int fallback) {int value;return Int32.TryParse(text,out value)&&value>=1&&value<=65535?value:fallback;}
        static bool Has(string[] args,string name) {return args.Contains(name);}
        void CancelPairingWait(){var w=pairingWait;pairingWait=null;if(w!=null){try{w.Cancel();}catch(ObjectDisposedException){}try{w.Dispose();}catch(ObjectDisposedException){}}}
        void CopyText(string text,string okMessage){
            if(String.IsNullOrEmpty(text)){status.Fail("복사할 내용이 없습니다.");return;}
            try{Clipboard.SetText(text);status.Text=okMessage;}
            catch(System.Runtime.InteropServices.ExternalException){status.Fail("클립보드에 복사하지 못했습니다. 텍스트 칸에서 직접 복사하세요.");}
        }
        static string NearestExistingDirectory(string path){
            if(String.IsNullOrWhiteSpace(path))return "";
            try{
                string current=path.Trim();
                while(!String.IsNullOrEmpty(current)){
                    if(Directory.Exists(current))return current;
                    current=Path.GetDirectoryName(current);
                }
            }catch(Exception){}
            return "";
        }
        static void ReplaceFont(Control target,ref Font holder,Font next){var previous=holder;holder=next;target.Font=next;if(previous!=null)previous.Dispose();}
        /// A label on the same row as a field must end before that field: the label is on top and would cover its text.
        static Label LabelAt(Control parent,string text,int x,int y,int width=170,int height=24) {var label=new Label{Text=text,Left=x,Top=y,Width=width,Height=height,ForeColor=Ink};parent.Controls.Add(label);return label;}
        static void ApplyButtonColors(Button button,bool primary){
            if(button.Enabled){
                button.BackColor=primary?Accent:Color.White;
                button.ForeColor=primary?Color.White:Ink;
            }else{
                button.BackColor=primary?Color.FromArgb(160,185,212):Color.FromArgb(245,246,248);
                button.ForeColor=primary?Color.White:Muted;
            }
        }
        static void StyleButton(Button button,bool primary=false){
            bool hadHandler=button.Tag is bool;
            button.Tag=primary;
            button.FlatStyle=FlatStyle.Flat;
            button.FlatAppearance.BorderColor=Border;
            button.FlatAppearance.BorderSize=primary?0:1;
            button.FlatAppearance.MouseOverBackColor=primary?Color.FromArgb(0,88,165):Color.FromArgb(243,245,248);
            button.UseVisualStyleBackColor=false;
            ApplyButtonColors(button,primary);
            if(!hadHandler)button.EnabledChanged+=delegate{ApplyButtonColors(button,button.Tag is bool&&(bool)button.Tag);};
        }
        static Font PairingCodeFontFor(Font baseFont){
            try{return new Font("Consolas",baseFont.Size*1.9F,FontStyle.Bold);}
            catch(Exception){return new Font(baseFont.FontFamily,baseFont.Size*1.9F,FontStyle.Bold);}
        }
        static void Position(Control parent,Control c,string name,int x,int y,int width,int height=28) {c.Name=name;c.AccessibleName=name;c.SetBounds(x,y,width,height);parent.Controls.Add(c);var button=c as Button;if(button!=null)StyleButton(button);}
        public SetupForm(string[] arguments,Func<DiscoveryResult> installedDiscovery=null) {
            SuspendLayout();
            args=arguments;Text="AgentBrowser 설치";Name="AgentBrowserSetup";ClientSize=new Size(720,640);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;Font=new Font("Malgun Gothic",10F);ForeColor=Ink;BackColor=Color.White;AutoScaleMode=AutoScaleMode.Font;AutoScaleDimensions=new SizeF(7F,17F);
            stepBar.WrapContents=false;stepBar.TabStop=false;stepBar.AccessibleRole=AccessibleRole.StaticText;Position(this,stepBar,"StepBar",32,10,656,26);
            ReplaceFont(heading,ref headingFont,new Font(Font.FontFamily,18F,FontStyle.Bold));Position(this,heading,"PageTitle",32,40,656,36);
            steps.ForeColor=Muted;Position(this,steps,"SetupSteps",32,80,656,26);
            var line=new Panel{BackColor=Border,Height=1,Dock=DockStyle.Bottom};Controls.Add(line);
            var panels=new[]{welcome,input,review,connection,pairing,runtime,done};var names=new[]{"WelcomePanel","SettingsPanel","PreviewPanel","ConnectionPanel","PairingPanel","RuntimePanel","DonePanel"};
            for(int i=0;i<panels.Length;i++)Position(this,panels[i],names[i],32,132,656,panels[i]==runtime?372:308);
            LabelAt(welcome,"기존 OpenCode를 Chrome에서 사용할 수 있도록 설치합니다.\r\n\r\n설치가 끝나면 Chrome 확장 추가와 연결 설정을\r\n차례대로 안내합니다.",0,4,656,104);
            LabelAt(welcome,"수행할 작업",0,134,146);Position(welcome,operation,"Operation",154,130,240);operation.DropDownStyle=ComboBoxStyle.DropDownList;operation.Items.AddRange(new object[]{"설치","업데이트","제거"});operation.SelectedIndex=0;
            LabelAt(welcome,"기존 설치",0,178,146);Position(welcome,installs,"ExistingInstallations",154,174,502);installs.DropDownStyle=ComboBoxStyle.DropDownList;installs.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;installs.SelectedIndexChanged+=delegate{if(installs.SelectedItem!=null){folder.Text=(string)installs.SelectedItem;LoadState();}};
            manage.Text="기존 설치의 연결 설정...";Position(welcome,manage,"ManageConnection",154,222,240,34);manage.Click+=async delegate{await OpenSetup();};
            LabelAt(input,"설치할 폴더",0,0,656);Position(input,folder,"InstallFolder",0,30,536);folder.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;folder.Text=Arg(args,"--install-dir",DefaultFolder);
            var browse=new Button{Text="찾아보기..."};Position(input,browse,"BrowseInstall",548,28,108,32);browse.Anchor=AnchorStyles.Top|AnchorStyles.Right;browse.Click+=delegate{using(var dialog=new FolderBrowserDialog{Description="AgentBrowser 전용 설치 폴더",SelectedPath=NearestExistingDirectory(folder.Text)})if(dialog.ShowDialog(this)==DialogResult.OK){folder.Text=dialog.SelectedPath;LoadState();}};
            LabelAt(input,"기본 위치를 권장합니다. 다른 로컬 드라이브도 선택할 수 있습니다.",0,72,656,24).ForeColor=Muted;
            var reset=new Button{Text="기본 위치로 되돌리기"};Position(input,reset,"UseDefaultFolder",0,106,182,32);reset.Click+=delegate{folder.Text=DefaultFolder;LoadState();};
            startup.Text="Windows 로그인 시 자동 실행";startup.Checked=!Has(args,"--no-startup");Position(input,startup,"EnableStartup",0,168,450);
            var advancedToggle=new Button{Text="고급 설정..."};Position(input,advancedToggle,"AdvancedSettings",0,226,132,32);advancedToggle.Click+=delegate{ShowAdvanced();};
            Position(input,advanced,"AdvancedPanel",0,0,772,396);advanced.AutoScroll=false;advanced.Visible=false;
            LabelAt(advanced,"설치 파일 위치",0,4);Position(advanced,package,"PackageFolder",180,0,570);package.Text=Arg(args,"--package-dir",AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'));
            LabelAt(advanced,"Bridge 포트",0,42);Position(advanced,port,"BridgePort",180,38,110);port.Minimum=1;port.Maximum=65535;port.Value=ParsePort(Arg(args,"--port","4317"),4317);
            start.Text="설치 후 자동 실행";start.Checked=!Has(args,"--no-start");Position(advanced,start,"StartBridge",320,38,240);
            LabelAt(advanced,"자동 실행 폴더",0,80);Position(advanced,startupPath,"StartupFolder",180,76,570);startupPath.Text=Arg(args,"--startup-dir",Environment.GetFolderPath(Environment.SpecialFolder.Startup));
            discover.Text="OpenCode 찾기";Position(advanced,discover,"Discover",0,118,160,32);discover.Click+=async delegate{await Discover();};
            Position(advanced,candidates,"OpenCodeCandidates",180,118,570);candidates.DropDownStyle=ComboBoxStyle.DropDownList;candidates.SelectedIndexChanged+=delegate{SelectCandidate();};
            register.Text="일반 CLI에도 browser MCP 등록 (선택)";Position(advanced,register,"RegisterMcp",0,160,360);register.CheckedChanged+=delegate{SyncAdvancedCli();};
            Position(advanced,kind,"OpenCodeKind",370,160,130);kind.DropDownStyle=ComboBoxStyle.DropDownList;kind.Items.AddRange(new object[]{"windows","wsl"});kind.SelectedIndex=0;
            Position(advanced,distribution,"Distribution",510,160,240);distribution.DropDownStyle=ComboBoxStyle.DropDown;
            LabelAt(advanced,"OpenCode 설정 파일",0,204);Position(advanced,config,"OpenCodeConfig",180,200,365);
            browseConfig.Text="찾아보기...";Position(advanced,browseConfig,"BrowseOpenCodeConfig",551,198,108,31);browseConfig.Click+=delegate{using(var dialog=new OpenFileDialog{Title="OpenCode 설정 파일 선택",Filter="JSON/JSONC (*.json;*.jsonc)|*.json;*.jsonc|모든 파일 (*.*)|*.*",CheckFileExists=false,InitialDirectory=NearestExistingDirectory(Path.GetDirectoryName(config.Text??""))})if(dialog.ShowDialog(this)==DialogResult.OK)config.Text=dialog.FileName;};
            add.Text="추가";Position(advanced,add,"AddRegistration",665,198,85,31);add.Click+=delegate{AddRegistration();};
            Position(advanced,registrations,"Registrations",180,240,570,54);
            removeRegistration.Text="선택 제거";Position(advanced,removeRegistration,"RemoveRegistration",0,240,160,32);removeRegistration.Click+=delegate{int i=registrations.SelectedIndex;if(i>=0){selected.RemoveAt(i);registrations.Items.RemoveAt(i);}};
            LabelAt(advanced,"Chrome에서만 사용할 때는 CLI 등록이 필요하지 않습니다.",0,308,750).ForeColor=Muted;
            Position(advanced,advancedStatus,"AdvancedStatus",0,336,750,52);
            SyncAdvancedCli();
            preview.Multiline=true;preview.ReadOnly=true;preview.BorderStyle=BorderStyle.None;preview.BackColor=Color.White;preview.ScrollBars=ScrollBars.Vertical;Position(review,preview,"ChangePreview",0,0,656,300);preview.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            installing.Text="프로그램 파일을 설치하고 연결 서비스를 시작합니다.";Position(review,installing,"InstallingMessage",0,50,656,30);
            progress.Style=ProgressBarStyle.Marquee;Position(review,progress,"InstallProgress",0,104,656,20);progress.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            LabelAt(connection,"1. [Chrome 확장 페이지 열기]를 누르세요. 아래 폴더 경로가 함께 복사됩니다.",0,0,656);
            LabelAt(connection,"2. Chrome에서 개발자 모드를 켜고 [압축해제된 확장 프로그램 로드]를 누르세요.",0,32,656);
            LabelAt(connection,"3. 폴더 선택 창에서 Alt+D를 누르고 복사된 경로를 붙여 넣으세요.",0,64,656);
            LabelAt(connection,"Chrome에 추가할 확장 폴더",0,112,656).ForeColor=Muted;
            extensionFolder.ReadOnly=true;Position(connection,extensionFolder,"ExtensionFolder",0,140,656);extensionFolder.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            openExtensions.Text="Chrome 확장 페이지 열기";Position(connection,openExtensions,"OpenExtensions",0,184,220,34);StyleButton(openExtensions,true);openExtensions.Click+=delegate{OpenChromeExtensions();};
            var copyPath=new Button{Text="폴더 경로 복사"};Position(connection,copyPath,"CopyExtensionFolder",236,184,160,34);copyPath.Click+=delegate{CopyText(extensionFolder.Text,"폴더 경로를 복사했습니다.");};
            Position(connection,extensionDetected,"ExtensionDetected",0,240,656,42);WaitForExtension();
            LabelAt(pairing,"Chrome에 열린 AgentBrowser 설정의 [페어링 코드]에 아래 6자리 코드를 입력하고 [코드로 연결]을 누르세요.",0,0,656,48);
            connectChrome.Text="코드 다시 받기";Position(pairing,connectChrome,"ConnectChrome",0,54,220,38);connectChrome.Click+=async delegate{await ConnectChrome();};
            ReplaceFont(pairingCode,ref pairingCodeFont,PairingCodeFontFor(Font));pairingCode.ForeColor=Ink;pairingCode.BackColor=Color.FromArgb(245,248,252);pairingCode.BorderStyle=BorderStyle.FixedSingle;pairingCode.TextAlign=ContentAlignment.MiddleCenter;Position(pairing,pairingCode,"PairingCode",236,50,420,46);pairingCode.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            Position(pairing,pairingState,"PairingState",0,102,656,44);pairingState.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            LabelAt(pairing,"코드 대신 직접 입력할 때: 확장 설정의 Bridge 주소·페어링 토큰 칸에 아래 값을 넣고 [저장 후 연결]",0,152,656,42).ForeColor=Muted;
            pairingUrl.ReadOnly=true;Position(pairing,pairingUrl,"PairingUrl",0,200,480);pairingUrl.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            var copyUrl=new Button{Text="주소 복사"};Position(pairing,copyUrl,"CopyPairingUrl",496,198,160,32);copyUrl.Anchor=AnchorStyles.Top|AnchorStyles.Right;copyUrl.Click+=delegate{CopyText(pairingUrl.Text,"Bridge 주소를 복사했습니다.");};
            pairingToken.ReadOnly=true;pairingToken.UseSystemPasswordChar=true;Position(pairing,pairingToken,"PairingToken",0,238,480);pairingToken.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            var copyToken=new Button{Text="토큰 복사"};Position(pairing,copyToken,"CopyPairingToken",496,236,160,32);copyToken.Anchor=AnchorStyles.Top|AnchorStyles.Right;copyToken.Click+=delegate{CopyText(pairingToken.Text,"토큰을 복사했습니다. Chrome 확장 옵션에 붙여 넣으세요.");};
            LabelAt(runtime,"사용할 OpenCode를 확인하고 [저장하고 연결 확인]을 누르세요.",0,0,656,28);
            LabelAt(runtime,"실행 방식",0,40,142);Position(runtime,runtimeKind,"RuntimeKind",150,36,160);runtimeKind.DropDownStyle=ComboBoxStyle.DropDownList;runtimeKind.Items.AddRange(new object[]{"Windows","WSL"});runtimeKind.SelectedIndex=0;runtimeKind.SelectedIndexChanged+=delegate{SyncRuntimeMode();};
            LabelAt(runtime,"WSL 배포판",326,40,100);Position(runtime,runtimeDistribution,"RuntimeDistribution",440,36,216);runtimeDistribution.DropDownStyle=ComboBoxStyle.DropDown;runtimeDistribution.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            rediscoverRuntime.Text="다시 찾기";Position(runtime,rediscoverRuntime,"RediscoverRuntime",150,72,160,30);rediscoverRuntime.Click+=async delegate{await DiscoverRuntime(null);};
            startDistribution.Text="배포판 켜고 찾기";Position(runtime,startDistribution,"StartDistribution",440,72,216,30);startDistribution.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;startDistribution.Click+=async delegate{await DiscoverRuntime(runtimeDistribution.Text);};
            LabelAt(runtime,"찾은 OpenCode",0,112,142);Position(runtime,runtimeCandidates,"RuntimeCandidates",150,108,506);runtimeCandidates.DropDownStyle=ComboBoxStyle.DropDownList;runtimeCandidates.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;runtimeCandidates.SelectedIndexChanged+=delegate{UseRuntimeCandidate();};
            LabelAt(runtime,"실행 파일",0,148,142);Position(runtime,runtimeExecutable,"RuntimeExecutable",150,144,506);runtimeExecutable.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            LabelAt(runtime,"작업 폴더",0,184,142);Position(runtime,runtimeDirectory,"RuntimeDirectory",150,180,390);runtimeDirectory.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            browseRuntimeDirectory.Text="폴더 선택";Position(runtime,browseRuntimeDirectory,"BrowseRuntimeDirectory",548,178,108,32);browseRuntimeDirectory.Anchor=AnchorStyles.Top|AnchorStyles.Right;browseRuntimeDirectory.Click+=delegate{if(runtimeKind.SelectedIndex==1){status.Text="WSL 작업 폴더는 /home/<사용자>/project 같은 Linux 경로로 입력하세요.";return;}using(var dialog=new FolderBrowserDialog{Description="OpenCode 작업 폴더",SelectedPath=NearestExistingDirectory(runtimeDirectory.Text)})if(dialog.ShowDialog(this)==DialogResult.OK)runtimeDirectory.Text=dialog.SelectedPath;};
            saveRuntime.Text="저장하고 연결 확인";Position(runtime,saveRuntime,"SaveRuntime",0,222,220,36);StyleButton(saveRuntime,true);saveRuntime.Click+=async delegate{await SaveRuntime();};
            Position(runtime,runtimeResult,"RuntimeResult",230,222,426,52);runtimeResult.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            LabelAt(runtime,"저장된 실행 환경 (Chrome 설정에도 같은 목록이 보입니다)",0,280,656,24).ForeColor=Muted;
            savedProfiles.HorizontalScrollbar=true;Position(runtime,savedProfiles,"SavedProfiles",0,304,656,64);savedProfiles.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            SyncRuntimeMode();
            var check=doneMark;check.Text="✓";Position(done,check,"DoneMark",0,6,56,60);ReplaceFont(check,ref doneMarkFont,new Font("Segoe UI Symbol",32F));check.ForeColor=Notice.Good;
            complete.Text="설정이 끝났습니다.";Position(done,complete,"CompleteTitle",76,16,560,38);ReplaceFont(complete,ref completeFont,new Font(Font.FontFamily,16F,FontStyle.Bold));
            LabelAt(done,"Chrome에서 AgentBrowser 아이콘을 눌러 시작하세요.\r\n다음부터는 설치 관리자를 열 필요가 없습니다.",76,62,560,48);
            doneChecks.HorizontalScrollbar=true;Position(done,doneChecks,"DoneChecks",76,118,580,112);doneChecks.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            // A check that failed leads straight to its step without leaving a blank gap when one button is hidden.
            doneActions.FlowDirection=FlowDirection.LeftToRight;doneActions.WrapContents=false;doneActions.Margin=Padding.Empty;doneActions.Padding=Padding.Empty;Position(done,doneActions,"DoneActions",76,242,446,40);
            fixChrome.Text="Chrome 연결 단계로";fixChrome.Margin=new Padding(0,0,12,0);Position(doneActions,fixChrome,"FixChrome",0,0,190,34);fixChrome.Visible=false;fixChrome.Click+=delegate{if(EnterConnection())status.Clear();};
            fixRuntime.Text="OpenCode 설정으로";fixRuntime.Margin=Padding.Empty;Position(doneActions,fixRuntime,"FixRuntime",0,0,190,34);fixRuntime.Visible=false;fixRuntime.Click+=async delegate{SetPage(6);status.Clear();await EnterRuntimePage();};
            recheck.Text="다시 확인";Position(done,recheck,"Recheck",536,244,120,34);recheck.Anchor=AnchorStyles.Top|AnchorStyles.Right;recheck.Click+=async delegate{await RunDoneChecks();};
            Position(this,status,"Status",32,450,656,44);
            var footer=new Panel{BackColor=Color.FromArgb(246,247,249)};footer.SetBounds(0,508,720,56);Controls.Add(footer);
            var footerLine=new Panel{BackColor=Border};footerLine.SetBounds(0,0,720,1);footer.Controls.Add(footerLine);
            back.Text="< 뒤로";back.TabIndex=1;Position(footer,back,"Back",384,520-508,96,32);back.Click+=delegate{GoBack();};
            prepare.Text="다음 >";prepare.TabIndex=2;Position(footer,prepare,"Preview",488,12,96,32);StyleButton(prepare,true);prepare.Click+=async delegate{if(page==0){SetPage(1);status.Clear();}else if(page==1)await Prepare();else if(page==4)await PreparePairing();else if(page==5){SetPage(6);status.Clear();await EnterRuntimePage();}else if(page==6){SetPage(7);status.Clear();await RunDoneChecks();}};
            apply.Text="설치";apply.TabIndex=2;Position(footer,apply,"Apply",488,12,96,32);StyleButton(apply,true);apply.Click+=async delegate{await Apply();};
            cancel.Text="취소";cancel.TabIndex=3;Position(footer,cancel,"Cancel",600,12,96,32);cancel.Click+=delegate{if(working&&cancellation!=null){cancellation.Cancel();status.Text="취소 중입니다. 변경 사항을 복구할 때까지 기다려 주세요.";}else Close();};
            FormClosing+=delegate(object sender,FormClosingEventArgs e){CancelPairingWait();if(working){e.Cancel=true;if(cancellation!=null)cancellation.Cancel();status.Text="작업이 끝날 때까지 기다려 주세요.";}};
            operation.SelectedIndexChanged+=delegate{package.Enabled=operation.SelectedIndex!=2;register.Enabled=operation.SelectedIndex!=2;startup.Enabled=operation.SelectedIndex!=2;advancedToggle.Enabled=operation.SelectedIndex!=2;manage.Enabled=operation.SelectedIndex!=2&&InstalledHere();SyncAdvancedCli();RenderSteps();};
            folder.TextChanged+=delegate{revision++;manage.Enabled=false;};folder.Leave+=delegate{LoadState();};
            foreach(Control field in new Control[]{config,kind,distribution,operation})field.TextChanged+=delegate{revision++;};
            detect.Interval=1500;detect.Tick+=async delegate{await DetectExtension();};
            LoadState();SetPage(0);
            installs.Enabled=false;
            var scan=installedDiscovery??new Func<DiscoveryResult>(Discovery.InstalledPaths);
            Shown+=async delegate{if(!Has(args,"--no-discover"))await DiscoverInstallations(scan);};
            // Keep navigation visible on small displays; only the page content scrolls.
            var header=new Panel{Dock=DockStyle.Top,Height=116,BackColor=Color.White};
            header.Controls.Add(stepBar);header.Controls.Add(heading);header.Controls.Add(steps);header.Controls.Add(line);
            var bottom=new Panel{Dock=DockStyle.Bottom,Height=124,BackColor=Color.White};
            status.Location=new Point(32,8);status.Height=52;bottom.Controls.Add(status);
            footer.Dock=DockStyle.Bottom;bottom.Controls.Add(footer);
            var navigation=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.RightToLeft,WrapContents=false,Padding=new Padding(12,9,12,9)};
            foreach(var button in new[]{cancel,prepare,apply,back}){button.Margin=new Padding(6,0,6,0);navigation.Controls.Add(button);}
            footer.Controls.Add(navigation);footerLine.Dock=DockStyle.Top;footerLine.BringToFront();
            status.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;heading.Anchor=steps.Anchor=stepBar.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
            FontChanged+=delegate{ReplaceFont(heading,ref headingFont,new Font(Font.FontFamily,Font.Size*1.8F,FontStyle.Bold));ReplaceFont(complete,ref completeFont,new Font(Font.FontFamily,Font.Size*1.6F,FontStyle.Bold));ReplaceFont(check,ref doneMarkFont,new Font("Segoe UI Symbol",Font.Size*3.2F));ReplaceFont(pairingCode,ref pairingCodeFont,PairingCodeFontFor(Font));RenderSteps();};
            body.Name="PageViewport";body.Size=new Size(ClientSize.Width,ClientSize.Height-header.Height-bottom.Height);body.Dock=DockStyle.Fill;body.AutoScroll=true;
            foreach(var panel in panels){panel.Location=new Point(32,20);body.Controls.Add(panel);panel.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;panel.SizeChanged+=delegate{FitViewport();};}
            Controls.Add(body);Controls.Add(bottom);Controls.Add(header);FitViewport();
            FormBorderStyle=FormBorderStyle.Sizable;MaximizeBox=true;
            MinimumSize=new Size(520,420);
            ResumeLayout(true);
            Shown+=delegate{var area=Screen.FromControl(this).WorkingArea;if(Height>area.Height||Width>area.Width){Size=new Size(Math.Min(Width,area.Width),Math.Min(Height,area.Height));Location=area.Location;}};
        }
        void SyncAdvancedCli(){
            bool on=register.Enabled&&register.Checked;
            kind.Enabled=distribution.Enabled=config.Enabled=browseConfig.Enabled=add.Enabled=registrations.Enabled=removeRegistration.Enabled=on;
        }
        void SyncRuntimeMode(){
            bool wsl=runtimeKind.SelectedIndex==1;
            runtimeDistribution.Enabled=wsl;
            startDistribution.Enabled=wsl&&!discoveringRuntime;
            browseRuntimeDirectory.Enabled=!wsl;
        }
        /// The detection timer is not a child control: without this it keeps ticking on a disposed window.
        protected override void Dispose(bool disposing){
            if(disposing){detect.Dispose();CancelPairingWait();doneRun++;if(stepBold!=null){stepBold.Dispose();stepBold=null;}foreach(var f in new[]{headingFont,completeFont,doneMarkFont,pairingCodeFont})if(f!=null)f.Dispose();headingFont=completeFont=doneMarkFont=pairingCodeFont=null;}
            base.Dispose(disposing);
        }
        void SetPage(int value){
            revision++;page=value;welcome.Visible=page==0;input.Visible=page==1;review.Visible=page==2||page==3;connection.Visible=page==4;pairing.Visible=page==5;runtime.Visible=page==6;done.Visible=page==7;
            preview.Visible=page==2;installing.Visible=progress.Visible=page==3;
            heading.Text=new[]{"AgentBrowser 설치","설치 위치 선택","설치 준비 완료","설치 중","Chrome 확장 추가","Chrome 연결","OpenCode 설정","설정 완료"}[page];
            steps.Text=new[]{"설치 마법사에 오신 것을 환영합니다.","프로그램을 설치할 폴더를 선택하세요.","아래 내용을 확인한 뒤 [설치]를 누르세요.","잠시 기다려 주세요.","Chrome에서 한 번만 진행하면 됩니다.","추가한 확장 프로그램과 연결합니다.","기존 OpenCode의 실행 환경을 선택합니다.","AgentBrowser를 사용할 준비가 되었습니다."}[page];
            if(operation.SelectedIndex==2&&page>=2){heading.Text=page==7?"제거 완료":"AgentBrowser 제거";steps.Text=page==7?"페어링과 프로필 데이터는 보존했습니다.":"제거할 설치 위치를 확인하세요.";}
            back.Visible=page==1||page==2||page==5||page==6||page==7;if(page!=5)CancelPairingWait();prepare.Visible=page==0||page==1||page==4||page==5||page==6;apply.Visible=page==2;apply.Text=operation.SelectedIndex==2?"제거":operation.SelectedIndex==1?"업데이트":"설치";
            if(page==2)steps.Text="아래 내용을 확인한 뒤 ["+apply.Text+"]를 누르세요.";
            detect.Enabled=page==4;if(page!=4){detectionBridgeStarted=false;detectionState=null;detectionExtensionId=null;}
            cancel.Text=page==7?"마침":page>=4?"닫기":"취소";StyleButton(cancel,page==7);AcceptButton=(page==0||page==1||page==4||page==5||page==6)?prepare:page==2?apply:page==7?cancel:null;CancelButton=page==3?null:cancel;
            if(page!=7)doneRun++;
            RenderSteps();FitViewport();
        }
        /// The step a wizard page belongs to. Pages 0-3 (welcome to installing) are one step.
        internal static int StepOf(int page,bool uninstall){return uninstall?(page==7?1:0):(page<=3?0:page-3);}
        void RenderSteps(){
            bool uninstall=operation.SelectedIndex==2;var names=uninstall?RemoveSteps:InstallSteps;int current=StepOf(page,uninstall);
            var bold=new Font(Font,FontStyle.Bold);
            stepBar.SuspendLayout();
            while(stepBar.Controls.Count>0){var old=stepBar.Controls[0];stepBar.Controls.RemoveAt(0);old.Dispose();}
            for(int i=0;i<names.Length;i++){
                if(i>0)stepBar.Controls.Add(new Label{Text="›",AutoSize=true,ForeColor=Muted,Margin=new Padding(0,0,6,0)});
                var step=new Label{Text=(i<current?"✓ ":(i+1)+" ")+names[i],AutoSize=true,ForeColor=i==current?Accent:i<current?Notice.Good:Muted,Margin=new Padding(0,0,6,0)};
                if(i==current)step.Font=bold;
                stepBar.Controls.Add(step);
            }
            stepBar.ResumeLayout(true);
            if(stepBold!=null)stepBold.Dispose();stepBold=bold;
            // One sentence for screen readers instead of five fragments.
            stepBar.AccessibleName=names.Length+"단계 중 "+(current+1)+"단계: "+names[current];
        }
        /// The viewport scrolls only when the window is smaller than the page it shows.
        void FitViewport(){
            if(body.Parent==null)return;
            // By page, not by Visible: that is false for every panel until the window itself is shown.
            var shown=page==0?welcome:page==1?input:page<=3?review:page==4?connection:page==5?pairing:page==6?runtime:done;
            body.AutoScrollPosition=Point.Empty;
            body.AutoScrollMinSize=new Size(shown.Right,shown.Bottom+shown.Top/4);
        }
        void GoBack(){
            status.Clear();if(page<3)plan=null;
            int target=page==2?1:page==5?4:page==6?5:page==7?6:0;
            if(target==4)connectionAuto=false;
            // Steps that were skipped as already finished were never filled in.
            if(target==5&&pairingToken.Text.Length==0)try{LoadPairingFields(Installed());}catch(Exception error){status.Fail(Friendly.Message(error));}
            // Nobody is waiting on a code shown earlier: a new one is issued on request.
            if(target==5){pairingCode.Text="";pairingState.Clear();}
            SetPage(target);
            if(target==0)manage.Enabled=operation.SelectedIndex!=2&&InstalledHere();
            if(target==6){var entering=EnterRuntimePage();}
        }
        void WaitForExtension(){extensionDetected.ForeColor=Muted;extensionDetected.Text="확장을 추가하면 자동으로 다음 단계로 넘어갑니다.\r\n이미 추가했다면 확장 카드의 새로고침을 누르세요.";}
        void OpenChromeExtensions(){
            try{
                string chrome=ChromePath();
                if(chrome==null)throw new IOException("Chrome을 찾지 못했습니다.");
                if(!Has(args,"--no-browser-launch"))Process.Start(new ProcessStartInfo(chrome,"chrome://extensions"){UseShellExecute=false});
                CopyText(extensionFolder.Text,"Chrome 확장 페이지를 열고 폴더 경로를 복사했습니다. 개발자 모드를 켜고 [압축해제된 확장 프로그램 로드]에서 Alt+D 후 붙여 넣으세요.");
            }catch(Exception error){bool copied=false;if(!String.IsNullOrEmpty(extensionFolder.Text)){try{Clipboard.SetText(extensionFolder.Text);copied=true;}catch(System.Runtime.InteropServices.ExternalException){}}status.Fail("Chrome을 직접 열고 주소창에 chrome://extensions 를 입력하세요."+(copied?" 폴더 경로는 복사했습니다.":" 아래 폴더 경로를 직접 복사하세요.")+"\r\n("+error.Message+")");}
        }
        static string ChromePath(){
            foreach(var hive in new[]{"HKEY_CURRENT_USER","HKEY_LOCAL_MACHINE"}){var value=Microsoft.Win32.Registry.GetValue(hive+@"\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe","",null) as string;if(!String.IsNullOrEmpty(value)&&File.Exists(value))return value;}
            return null;
        }
        async Task DetectExtension(){
            if(page!=4||detecting)return;detecting=true;bool advance=false;
            try{
                // Never hash every installed file on the UI thread per tick: the page verified the
                // installation when it opened. Without that result, verify once in the background.
                if(detectionState==null||detectionExtensionId==null){
                    string selected=folder.Text;
                    var verified=await Task.Run(()=>{var checkedState=Verified(selected);return new KeyValuePair<InstallState,string>(checkedState,Pairing.ExtensionId(Path.Combine(checkedState.InstallDir,"extension","manifest.json")));});
                    if(page!=4)return;
                    detectionState=verified.Key;detectionExtensionId=verified.Value;
                }
                var state=detectionState;string id=detectionExtensionId;
                // Starting (or verifying) the Bridge hashes files and queries processes: once per page visit.
                // One attempt per page visit, successful or not: a failing start must not be repeated every tick.
                if(!detectionBridgeStarted){detectionBridgeStarted=true;await Task.Run(()=>BridgeControl.Start(state));}
                var current=await Task.Run(()=>BridgeStatus(state));
                if(page==4&&Pairing.Seen(current,id)){
                    advance=connectionAuto;connectionAuto=false;
                    extensionDetected.ForeColor=Notice.Good;extensionDetected.Text="✓ Chrome에 AgentBrowser 확장이 추가되었습니다."+(advance?"":" [다음]을 누르세요.");
                }
            }catch(Exception){/* Detection is only a hint; the next step reports real errors. */}
            finally{detecting=false;}
            if(advance&&page==4){
                await PreparePairing();
                // The step could not be opened (its error is in the status line): leave the manual way visible.
                if(page==4)extensionDetected.Text+=" [다음]을 누르세요.";
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
        void ShowAdvanced(){
            // Snapshot current values so Cancel/Esc/X discards accidental edits.
            string snapPackage=package.Text,snapStartupPath=startupPath.Text,snapDistro=distribution.Text,snapConfig=config.Text;
            decimal snapPort=port.Value;bool snapStart=start.Checked,snapRegister=register.Checked;int snapKind=kind.SelectedIndex;
            var snapSelected=selected.ToList();var snapRegItems=registrations.Items.Cast<object>().ToList();
            // This panel has already scaled with the main form. Do not scale it again
            // when it moves into a dialog, or text and fields overlap at large fonts.
            // Font.Size is in points and ignores the display DPI; lay out from the real pixel height
            // of the font (17 px at the 10 pt, 96 DPI design size) and the measured button text.
            float scale=Font.Height/17F;var closeText=TextRenderer.MeasureText("확인",Font);var cancelText=TextRenderer.MeasureText("취소",Font);
            int margin=(int)Math.Ceiling(20*scale),gap=(int)Math.Ceiling(10*scale),buttonHeight=Math.Max((int)Math.Ceiling(32*scale),Math.Max(closeText.Height,cancelText.Height)+12),buttonWidth=Math.Max(5*margin,Math.Max(closeText.Width,cancelText.Width)+32);
            using(var dialog=new Form{Text="AgentBrowser 고급 설정",Font=Font,AutoScaleMode=AutoScaleMode.None,BackColor=Color.White,FormBorderStyle=FormBorderStyle.Sizable,MaximizeBox=true,MinimizeBox=false,StartPosition=FormStartPosition.CenterParent}){
                int footerHeight=buttonHeight+2*margin;
                int dlgWidth=advanced.Width+2*margin;
                dialog.ClientSize=new Size(dlgWidth,advanced.Height+2*margin+footerHeight);
                var content=new Panel{Dock=DockStyle.Fill,AutoScroll=true,BackColor=Color.White,Size=new Size(dlgWidth,advanced.Height+2*margin)};
                var dlgFooter=new Panel{Dock=DockStyle.Bottom,Size=new Size(dlgWidth,footerHeight),BackColor=Color.FromArgb(246,247,249)};
                var dlgLine=new Panel{Dock=DockStyle.Top,Height=1,BackColor=Border};
                dlgFooter.Controls.Add(dlgLine);
                advanced.Parent=content;advanced.Location=new Point(margin,margin);advancedStatus.Clear();SyncAdvancedCli();advanced.Visible=true;
                content.AutoScrollMinSize=new Size(advanced.Right+margin,advanced.Bottom+margin);
                int okLeft=Math.Max(margin+buttonWidth+gap,dlgWidth-margin-buttonWidth);
                var cancelBtn=new Button{Text="취소",DialogResult=DialogResult.Cancel};Position(dlgFooter,cancelBtn,"CancelAdvanced",okLeft-gap-buttonWidth,margin,buttonWidth,buttonHeight);cancelBtn.Anchor=AnchorStyles.Top|AnchorStyles.Right;
                var close=new Button{Text="확인",DialogResult=DialogResult.OK};Position(dlgFooter,close,"CloseAdvanced",okLeft,margin,buttonWidth,buttonHeight);StyleButton(close,true);close.Anchor=AnchorStyles.Top|AnchorStyles.Right;
                dialog.Controls.Add(content);dialog.Controls.Add(dlgFooter);
                dialog.AcceptButton=close;dialog.CancelButton=cancelBtn;
                dialog.Shown+=delegate{var area=Screen.FromControl(dialog).WorkingArea;if(dialog.Height>area.Height||dialog.Width>area.Width){dialog.Size=new Size(Math.Min(dialog.Width,area.Width),Math.Min(dialog.Height,area.Height));dialog.Location=area.Location;}dialog.Refresh();};
                DialogResult result=DialogResult.Cancel;
                try{result=dialog.ShowDialog(this);}finally{advanced.Visible=false;advanced.Parent=input;}
                if(result!=DialogResult.OK){
                    package.Text=snapPackage;port.Value=snapPort;start.Checked=snapStart;startupPath.Text=snapStartupPath;
                    register.Checked=snapRegister;kind.SelectedIndex=snapKind;distribution.Text=snapDistro;config.Text=snapConfig;
                    selected.Clear();selected.AddRange(snapSelected);
                    registrations.Items.Clear();foreach(var item in snapRegItems)registrations.Items.Add(item);
                    SyncAdvancedCli();
                }
            }
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

