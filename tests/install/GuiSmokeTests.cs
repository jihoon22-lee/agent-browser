using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Drawing;
using System.Web.Script.Serialization;
using System.Management;
using System.Security.Cryptography;

internal static class GuiSmokeTests {
    [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
    [DllImport("user32.dll")]static extern bool PostMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
    [DllImport("user32.dll")]static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")]static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]static extern bool AttachThreadInput(uint a,uint b,bool attach);
    [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr h,int command);
    [StructLayout(LayoutKind.Sequential)]struct Point {public int X,Y;public Point(int x,int y){X=x;Y=y;}}
    [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll",SetLastError=true)]static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
    [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")]static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
    static AutomationElement window;static Process process;static bool doubleApply,useUia;
    static AutomationElement Find(string name){var e=window.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,name));if(e==null)throw new Exception("Control missing: "+name);return e;}
    static void Click(string name){
        Console.WriteLine("CLICK requested "+name+" gui="+process.Id+" hwnd="+process.MainWindowHandle);
        if(useUia){var control=Find(name);var handle=new IntPtr(control.Current.NativeWindowHandle);uint pid;GetWindowThreadProcessId(handle,out pid);if(pid!=process.Id)throw new Exception("Action target is not the owned GUI");if(!PostMessage(handle,0xf5,IntPtr.Zero,IntPtr.Zero))throw new Exception("Cannot post owned GUI action");if(doubleApply&&(name=="Apply"||name=="SaveProfile"))PostMessage(handle,0xf5,IntPtr.Zero,IntPtr.Zero);Thread.Sleep(150);return;}
        var element=Find(name);ShowWindow(process.MainWindowHandle,9);SetForegroundWindow(process.MainWindowHandle);Thread.Sleep(100);
        if(GetForegroundWindow()!=process.MainWindowHandle) {uint pid;uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out pid),thread=GetCurrentThreadId();bool attached=AttachThreadInput(thread,foregroundThread,true);try{SetForegroundWindow(process.MainWindowHandle);}finally{if(attached)AttachThreadInput(thread,foregroundThread,false);}Thread.Sleep(100);}
        var rect=element.Current.BoundingRectangle;
        if(rect.IsEmpty||element.Current.IsOffscreen)throw new Exception("Control is not visible: "+name);
        int x=(int)(rect.Left+rect.Width/2),y=(int)(rect.Top+rect.Height/2);uint targetPid;
        GetWindowThreadProcessId(WindowFromPoint(new Point(x,y)),out targetPid);
        if(targetPid!=process.Id) {SetWindowPos(process.MainWindowHandle,new IntPtr(-1),0,0,0,0,0x43);Thread.Sleep(100);GetWindowThreadProcessId(WindowFromPoint(new Point(x,y)),out targetPid);}
        try {if(targetPid!=process.Id)throw new Exception("The visible click target is not the owned GUI; no mouse input was sent. Target PID="+targetPid);
            SetCursorPos(x,y);mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);if(doubleApply&&(name=="Apply"||name=="SaveProfile")){Thread.Sleep(15);mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);}Thread.Sleep(150);
        } finally {SetWindowPos(process.MainWindowHandle,new IntPtr(-2),0,0,0,0,0x13);}
    }
    static void Set(string name,string value){((ValuePattern)Find(name).GetCurrentPattern(ValuePattern.Pattern)).SetValue(value);}
    static string Get(string name){var element=Find(name);object pattern;if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))return ((ValuePattern)pattern).Current.Value;if(element.TryGetCurrentPattern(TextPattern.Pattern,out pattern))return ((TextPattern)pattern).DocumentRange.GetText(-1);throw new Exception("Readable control pattern missing: "+name);}
    static void Wait(Func<bool> predicate,string message,int ms=40000){var timer=Stopwatch.StartNew();string last="";while(timer.ElapsedMilliseconds<ms){try{if(predicate())return;}catch(ElementNotAvailableException error){last=error.Message;}catch(Exception error){if(!error.Message.StartsWith("Control missing:"))throw;last=error.Message;}Thread.Sleep(150);}throw new Exception(message+" "+last);}
    static void Launch(string exe,string arguments){
        process=Process.Start(new ProcessStartInfo(exe,arguments){UseShellExecute=false});
        int launched=process.Id;string digest;using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(exe))).Replace("-","").ToLowerInvariant();
        string expected=Path.Combine(Path.GetTempPath(),"AgentBrowser-Setup",digest,"AgentBrowser-Setup.exe");bool handedOff=false;
        var timer=Stopwatch.StartNew();while(timer.ElapsedMilliseconds<15000){
            process.Refresh();if(!process.HasExited&&process.MainWindowHandle!=IntPtr.Zero){window=AutomationElement.FromHandle(process.MainWindowHandle);return;}
            if(!handedOff&&process.HasExited)using(var query=new ManagementObjectSearcher("SELECT ProcessId,ExecutablePath FROM Win32_Process WHERE ParentProcessId="+launched))foreach(ManagementObject child in query.Get()) {
                if(!String.Equals(child["ExecutablePath"] as string,expected,StringComparison.OrdinalIgnoreCase))continue;
                process.Dispose();process=Process.GetProcessById(Convert.ToInt32(child["ProcessId"]));handedOff=true;Console.WriteLine("PASS verified installed GUI handoff to exact-hash temporary executable");break;
            }
            Thread.Sleep(100);
        }throw new Exception("GUI did not open.");
    }
    static void Close(){if(process==null)return;if(!process.HasExited){Click("Cancel");if(!process.WaitForExit(10000))throw new Exception("Owned test GUI did not close.");}process.Dispose();process=null;}
    static void Screenshot(string path){var r=window.Current.BoundingRectangle;using(var b=new Bitmap((int)r.Width,(int)r.Height))using(var g=Graphics.FromImage(b)){g.CopyFromScreen((int)r.X,(int)r.Y,0,0,b.Size);b.Save(path,System.Drawing.Imaging.ImageFormat.Png);}}
    static void Choose(string name,int index){
        if(useUia){var control=Find(name);var handle=new IntPtr(control.Current.NativeWindowHandle);uint pid;GetWindowThreadProcessId(handle,out pid);if(pid!=process.Id)throw new Exception("Selection target is not the owned GUI");if(SendMessage(handle,0x14e,new IntPtr(index),IntPtr.Zero).ToInt32()!=index)throw new Exception("Selection item missing: "+name);SendMessage(GetParent(handle),0x111,new IntPtr((GetDlgCtrlID(handle)&0xffff)|0x10000),handle);Thread.Sleep(100);return;}
        Click(name);uint foregroundPid;GetWindowThreadProcessId(GetForegroundWindow(),out foregroundPid);if(foregroundPid!=process.Id)throw new Exception("Keyboard target is not the owned GUI; no keys sent");SendKeys.SendWait("{HOME}"+String.Concat(Enumerable.Repeat("{DOWN}",index))+"{ENTER}");Thread.Sleep(100);
    }
    static string Quote(string text){return "\""+text+"\"";}
    [STAThread] public static int Main(string[] args){
        string root=args[1],package=Path.Combine(root,"extracted"),install=Path.Combine(root,"GUI 설치 & space"),startup=Path.Combine(root,"GUI Startup"),settings=args[2];
        doubleApply=args.Contains("--double");useUia=args.Contains("--uia");bool resume=args.Contains("--resume");Directory.CreateDirectory(root);if(!resume)ZipFile.ExtractToDirectory(args[0],package);
        var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();int port=((IPEndPoint)listener.LocalEndpoint).Port;listener.Stop();
        if(resume) {string existingState=File.ReadAllText(Path.Combine(install,".agent-browser-install.json"));port=Int32.Parse(System.Text.RegularExpressions.Regex.Match(existingState,"\"Port\"\\s*:\\s*([0-9]+)").Groups[1].Value);}
        string common="--no-discover --package-dir "+Quote(package)+" --install-dir "+Quote(install)+" --startup-dir "+Quote(startup)+" --port "+port;
        string exe=Path.Combine(package,"AgentBrowser-Setup.exe");string original=File.ReadAllText(settings);
        try {
            if(!resume) {
            if(args.Contains("--discovery")) {
                Launch(exe,common.Replace("--no-discover ",""));Wait(()=>Find("Discover").Current.IsEnabled,"automatic discovery did not complete",90000);Screenshot(Path.Combine(root,"automatic-discovery.png"));
                Choose("ExistingInstallations",0);if(!File.Exists(Path.Combine(Get("InstallFolder"),".agent-browser-install.json")))throw new Exception("discovered installation selection missing");
                Set("InstallFolder",install);Choose("Operation",0);Click("Discover");Set("OpenCodeConfig",settings);Wait(()=>Find("Discover").Current.IsEnabled,"discovery did not finish",90000);
                if(Get("OpenCodeConfig")!=settings)throw new Exception("late discovery overwrote manual config");Close();Console.WriteLine("PASS actual GUI automatic discovery, existing-install selection and manual-input freshness");
            }
            Launch(exe,common);Click("Preview");Wait(()=>Get("Status").Contains("아직 변경"),"preview failed");Screenshot(Path.Combine(root,"preview-cancel.png"));Click("Back");Click("Preview");Wait(()=>Get("Status").Contains("아직 변경"),"second preview failed");Close();
            if(File.Exists(Path.Combine(install,".agent-browser-install.json")))throw new Exception("Cancel installed product");
            Console.WriteLine("PASS actual GUI preview/back/cancel without installation");
            Launch(exe,common);Click("RegisterMcp");Choose("OpenCodeKind",1);Set("Distribution","Ubuntu");Set("OpenCodeConfig",settings);Click("AddRegistration");Click("Preview");Wait(()=>Get("Status").Contains("아직 변경"),"WSL preview failed");Screenshot(Path.Combine(root,"wsl-preview.png"));
            if(args.Contains("--failure")) {var blocker=new TcpListener(IPAddress.Loopback,port);try{blocker.Start();Click("Apply");Wait(()=>Get("Status").Contains("다시 시도"),"expected startup failure missing",50000);Screenshot(Path.Combine(root,"startup-failure.png"));if(File.Exists(Path.Combine(install,".agent-browser-install.json"))||File.ReadAllText(settings)!=original)throw new Exception("failed install did not roll back files/config");}finally{blocker.Stop();}Click("Back");Click("Preview");Wait(()=>Get("Status").Contains("아직 변경"),"retry preview failed");Console.WriteLine("PASS actual GUI startup failure rollback and retry preview");}
            Click("Apply");Wait(()=>Get("Status").StartsWith("설치 완료"),"GUI install failed");Screenshot(Path.Combine(root,"install-complete.png"));Close();
            Console.WriteLine("PASS actual GUI install and WSL missing-mcp registration");
            if(args.Contains("--profiles")) {
                // A freshly installed GUI should save a new managed profile via
                // the real Bridge CLI, without starting OpenCode or a model.
                Launch(exe,common);var parent=window;Click("ManagedProfiles");
                Wait(()=>{var title=new PropertyCondition(AutomationElement.NameProperty,"AgentBrowser 관리 OpenCode 프로필");var dialog=parent.FindFirst(TreeScope.Descendants,title)??AutomationElement.RootElement.FindFirst(TreeScope.Children,new AndCondition(new PropertyCondition(AutomationElement.ProcessIdProperty,process.Id),title));if(dialog==null)return false;window=dialog;return true;},"profile dialog missing");
                Set("ProfileId","gui-profile-test");Set("ProfileName","GUI isolated profile");Choose("ProfileKind",1);Set("ProfileDistribution","Ubuntu");Set("ProfileExecutable","/home/jihoon/.opencode/bin/opencode");Set("ProfileDirectory",Path.GetDirectoryName(settings.Substring(settings.IndexOf("\\tmp\\",StringComparison.Ordinal))).Replace('\\','/'));
                if(args.Contains("--async-profile")) {
                    Click("ValidateProfile");Set("ProfileName","Changed during validation");Wait(()=>Find("ValidateProfile").Current.IsEnabled,"profile validation did not finish");
                    if(Find("SaveProfile").Current.IsEnabled)throw new Exception("REGRESSION: stale profile validation enabled Save after inputs changed");
                    Console.WriteLine("PASS actual GUI stale profile validation discarded");
                }
                Click("ValidateProfile");Wait(()=>Get("ProfilePreview").Contains("추가할 프로필"),"profile validation failed");Click("SaveProfile");Wait(()=>Get("ProfilePreview").Contains("프로필을 저장했습니다"),"profile save failed");Screenshot(Path.Combine(root,"managed-profile-saved.png"));
                if(args.Contains("--async-profile")) {
                    Click("ValidateProfile");Wait(()=>Find("ValidateProfile").Current.IsEnabled,"duplicate profile validation did not finish");if(Find("SaveProfile").Current.IsEnabled||!Get("ProfilePreview").Contains("같은 ID"))throw new Exception("duplicate profile was accepted");
                    Set("ProfileId","cancelled-validation");Click("ValidateProfile");Click("CloseProfile");window=parent;Thread.Sleep(2000);if(process.HasExited||!Find("ManagedProfiles").Current.IsEnabled)throw new Exception("closing pending validation damaged main GUI");Console.WriteLine("PASS actual GUI duplicate profile rejected and pending validation close is safe");
                }else{Click("CloseProfile");window=parent;}
                Close();
                if(!File.ReadAllText(Path.Combine(install,"data","runtime.json")).Contains("gui-profile-test"))throw new Exception("saved profile missing");
                Console.WriteLine("PASS actual GUI managed WSL profile validation/save without runtime/model start");
                Launch(exe,common);parent=window;string pidBefore=File.ReadAllText(Path.Combine(install,"data","serve.pid"));Click("StartInstalledBridge");Wait(()=>Get("Status").Contains("Bridge가 실행 중"),"existing Bridge start failed");if(File.ReadAllText(Path.Combine(install,"data","serve.pid"))!=pidBefore)throw new Exception("Start unnecessarily replaced the running owned Bridge");Click("Pairing");Wait(()=>{var dialog=parent.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,"AgentBrowser 페어링"));if(dialog==null)return false;window=dialog;return true;},"pairing dialog missing");
                if(!Find("PairingToken").Current.IsPassword||Get("PairingUrl")!="ws://127.0.0.1:"+port+"/extension")throw new Exception("pairing dialog must mask token and show current port");Screenshot(Path.Combine(root,"pairing-masked.png"));Click("ClosePairing");window=parent;Close();Console.WriteLine("PASS actual GUI masked pairing dialog; token not read or copied by test");
            }
            string first=File.ReadAllText(settings);if(!first.Contains("\"browser\"")||!first.Contains("// preserve"))throw new Exception("WSL settings or comment missing");
            File.WriteAllText(Path.Combine(install,"data","gui-preserve.json"),"{\"synthetic\":true}");
            File.WriteAllText(settings,first.Replace("test/model","test/user-edited"),new System.Text.UTF8Encoding(false));
            }
            Launch(exe,common);Choose("Operation",1);Click("Preview");Wait(()=>Get("Status").Contains("아직 변경"),"update preview failed");Click("Apply");Wait(()=>Get("Status").StartsWith("설치 완료"),"GUI update failed");Screenshot(Path.Combine(root,"update-complete.png"));Close();
            string updated=File.ReadAllText(settings);if(!updated.Contains("test/user-edited")||System.Text.RegularExpressions.Regex.Matches(updated,"\"browser\"").Count!=1)throw new Exception("update duplicated MCP or lost model");
            if(args.Contains("--upgrade")) {string state=File.ReadAllText(Path.Combine(install,".agent-browser-install.json"));if(!state.Contains("\"Version\":\"0.1.5\"")||!state.Contains(File.ReadAllText(Path.Combine(root,"old-identity.txt"))))throw new Exception("cross-version update lost version/identity");using(var sha=System.Security.Cryptography.SHA256.Create()){string hash=BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(Path.Combine(install,"data","config.json")))).Replace("-","").ToLowerInvariant();if(hash!=File.ReadAllText(Path.Combine(root,"old-config-sha.txt")))throw new Exception("upgrade changed pairing data");}Console.WriteLine("PASS actual GUI published 0.1.4 Bridge installation upgraded to 0.1.5; identity/pairing preserved");}
            Console.WriteLine("PASS actual GUI repeat/update preserves user settings and single registration");
            File.WriteAllText(Path.Combine(root,"installed-test-root.txt"),install);
            if(args.Contains("--installed-uninstall"))exe=(string)new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(install,".agent-browser-install.json")))["SetupExe"];
            if(args.Contains("--legacy-gui")) {
                var json=new JavaScriptSerializer();string marker=Path.Combine(install,".agent-browser-install.json");var state=json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(marker));
                string legacy=Path.Combine(install,"AgentBrowser-Setup.exe");File.Copy((string)state["SetupExe"],legacy);
                string digest;using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(legacy))).Replace("-","").ToLowerInvariant();
                ((System.Collections.ArrayList)state["OwnedFiles"]).Add(new System.Collections.Generic.Dictionary<string,object>{{"Path","AgentBrowser-Setup.exe"},{"Sha256",digest}});
                File.WriteAllText(marker,json.Serialize(state),new System.Text.UTF8Encoding(false));exe=legacy;
            }
            Launch(exe,common);Choose("Operation",2);Click("Preview");Wait(()=>Get("Status").Contains("아직 변경"),"uninstall preview failed");if(!Get("ChangePreview").Contains(install))throw new Exception("uninstall preview missing target");Screenshot(Path.Combine(root,"uninstall-preview.png"));Click("Apply");Wait(()=>Get("Status").StartsWith("제거 완료"),"GUI uninstall failed");Screenshot(Path.Combine(root,"uninstall-complete.png"));Close();
            if(File.Exists(Path.Combine(install,".agent-browser-install.json"))||!File.Exists(Path.Combine(install,"data","gui-preserve.json")))throw new Exception("uninstall data ownership failure");
            string final=File.ReadAllText(settings);if(final.Contains("\"browser\"")||!final.Contains("test/user-edited")||!final.Contains("// preserve")||(original.Contains("\"other\"")?!final.Contains("\"other\""):final.Contains("\"mcp\"")))throw new Exception("uninstall did not preserve the original MCP state");
            Console.WriteLine("PASS actual GUI uninstall target confirmation, no-mcp restoration and data preservation");
            Console.WriteLine("GUI_ROOT "+root);return 0;
        }catch(Exception error){Console.Error.WriteLine(error);if(process!=null&&!process.HasExited) {Console.Error.WriteLine("GUI_PID "+process.Id);try{Screenshot(Path.Combine(root,"failure.png"));}catch{}}return 1;}
    }
}

