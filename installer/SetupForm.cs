using System;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

namespace AgentBrowser.Installer {
    internal sealed partial class SetupForm : Form {
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
            doneActions.FlowDirection=FlowDirection.LeftToRight;doneActions.WrapContents=false;doneActions.Margin=Padding.Empty;doneActions.Padding=Padding.Empty;Position(done,doneActions,"DoneActions",76,242,446,40);doneActions.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;
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
            foreach(var panel in panels){panel.Location=new Point(32,20);panel.MinimumSize=new Size(656,0);body.Controls.Add(panel);panel.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right;panel.SizeChanged+=delegate{FitViewport();};}
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
    }
}
