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
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,System.Text.StringBuilder text,int max);
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
        if(useUia){var control=Find(name);var handle=new IntPtr(control.Current.NativeWindowHandle);uint pid;GetWindowThreadProcessId(handle,out pid);if(pid!=process.Id)throw new Exception("Action target is not the owned GUI");if(!PostMessage(handle,0xf5,IntPtr.Zero,IntPtr.Zero))throw new Exception("Cannot post owned GUI action");if(doubleApply&&(name=="Apply"||name=="SaveRuntime"))PostMessage(handle,0xf5,IntPtr.Zero,IntPtr.Zero);Thread.Sleep(150);return;}
        var element=Find(name);ShowWindow(process.MainWindowHandle,9);SetForegroundWindow(process.MainWindowHandle);Thread.Sleep(100);
        if(GetForegroundWindow()!=process.MainWindowHandle) {uint pid;uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out pid),thread=GetCurrentThreadId();bool attached=AttachThreadInput(thread,foregroundThread,true);try{SetForegroundWindow(process.MainWindowHandle);}finally{if(attached)AttachThreadInput(thread,foregroundThread,false);}Thread.Sleep(100);}
        var rect=element.Current.BoundingRectangle;
        if(rect.IsEmpty||element.Current.IsOffscreen)throw new Exception("Control is not visible: "+name);
        int x=(int)(rect.Left+rect.Width/2),y=(int)(rect.Top+rect.Height/2);uint targetPid;
        GetWindowThreadProcessId(WindowFromPoint(new Point(x,y)),out targetPid);
        if(targetPid!=process.Id) {SetWindowPos(process.MainWindowHandle,new IntPtr(-1),0,0,0,0,0x43);Thread.Sleep(100);GetWindowThreadProcessId(WindowFromPoint(new Point(x,y)),out targetPid);}
        try {if(targetPid!=process.Id)throw new Exception("The visible click target is not the owned GUI; no mouse input was sent. Target PID="+targetPid);
            SetCursorPos(x,y);mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);if(doubleApply&&(name=="Apply"||name=="SaveRuntime")){Thread.Sleep(15);mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);}Thread.Sleep(150);
        } finally {SetWindowPos(process.MainWindowHandle,new IntPtr(-2),0,0,0,0,0x13);}
    }
    static void Set(string name,string value){((ValuePattern)Find(name).GetCurrentPattern(ValuePattern.Pattern)).SetValue(value);}
    static string Get(string name){var element=Find(name);object pattern;if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))return ((ValuePattern)pattern).Current.Value;if(element.TryGetCurrentPattern(TextPattern.Pattern,out pattern))return ((TextPattern)pattern).DocumentRange.GetText(-1);var handle=new IntPtr(element.Current.NativeWindowHandle);if(handle!=IntPtr.Zero){var text=new System.Text.StringBuilder(4096);GetWindowText(handle,text,text.Capacity);return text.ToString();}throw new Exception("Readable control pattern missing: "+name);}
    static void Wait(Func<bool> predicate,string message,int ms=40000){var timer=Stopwatch.StartNew();string last="";while(timer.ElapsedMilliseconds<ms){try{if(predicate())return;}catch(ElementNotAvailableException error){last=error.Message;}catch(Exception error){if(!error.Message.StartsWith("Control missing:"))throw;last=error.Message;}Thread.Sleep(150);}throw new Exception(message+" "+last);}
    static void Launch(string exe,string arguments){
        process=Process.Start(new ProcessStartInfo(exe,arguments){UseShellExecute=false});
        int launched=process.Id;string digest;using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(exe))).Replace("-","").ToLowerInvariant();
        string expected=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AgentBrowser-Setup",digest,"AgentBrowser-Setup.exe");bool handedOff=false;
        var timer=Stopwatch.StartNew();while(timer.ElapsedMilliseconds<15000){
            process.Refresh();IntPtr handle=IntPtr.Zero;try{if(!process.HasExited)handle=process.MainWindowHandle;}catch(InvalidOperationException){if(!process.HasExited)throw;}if(handle!=IntPtr.Zero){window=AutomationElement.FromHandle(handle);return;}
            if(!handedOff&&process.HasExited)using(var query=new ManagementObjectSearcher("SELECT ProcessId,ExecutablePath FROM Win32_Process WHERE ParentProcessId="+launched))foreach(ManagementObject child in query.Get()) {
                if(!String.Equals(child["ExecutablePath"] as string,expected,StringComparison.OrdinalIgnoreCase))continue;
                process.Dispose();process=Process.GetProcessById(Convert.ToInt32(child["ProcessId"]));handedOff=true;Console.WriteLine("PASS verified installed GUI handoff to exact-hash per-user maintenance executable");break;
            }
            Thread.Sleep(100);
        }throw new Exception("GUI did not open.");
    }
    static AutomationElement EnterDialog(string title){var parent=window;Wait(()=>{var match=new PropertyCondition(AutomationElement.NameProperty,title);var dialog=parent.FindFirst(TreeScope.Descendants,match)??AutomationElement.RootElement.FindFirst(TreeScope.Children,new AndCondition(new PropertyCondition(AutomationElement.ProcessIdProperty,process.Id),match));if(dialog==null)return false;window=dialog;return true;},"dialog missing: "+title);return parent;}
    static void PairingStep(){Click("Preview");Wait(()=>{try{return Find("PairingToken").Current.IsPassword;}catch{return false;}},"pairing step did not open");}
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
        string previousVersion="";string expectedVersion=(string)new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(package,"package-manifest.json")))["Version"];
        if(resume) {string existingState=File.ReadAllText(Path.Combine(install,".agent-browser-install.json"));previousVersion=(string)new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(existingState)["Version"];port=Int32.Parse(System.Text.RegularExpressions.Regex.Match(existingState,"\"Port\"\\s*:\\s*([0-9]+)").Groups[1].Value);}
        if(args.Contains("--upgrade")&&(!resume||previousVersion==expectedVersion))throw new Exception("Cross-version upgrade requires different previous and candidate versions.");
        string common="--no-discover --package-dir "+Quote(package)+" --install-dir "+Quote(install)+" --startup-dir "+Quote(startup)+" --port "+port;
        string exe=Path.Combine(package,"AgentBrowser-Setup.exe");string original=File.ReadAllText(settings);
        try {
            if(!resume) {
            if(args.Contains("--discovery")) {
                Launch(exe,common.Replace("--no-discover ",""));Wait(()=>Find("ExistingInstallations").Current.IsEnabled,"installation discovery did not complete",90000);Screenshot(Path.Combine(root,"automatic-discovery.png"));
                Choose("ExistingInstallations",0);Choose("Operation",0);Click("Preview");if(!File.Exists(Path.Combine(Get("InstallFolder"),".agent-browser-install.json")))throw new Exception("discovered installation selection missing");
                Set("InstallFolder",install);Click("AdvancedSettings");var advancedParent=EnterDialog("AgentBrowser 고급 설정");Click("Discover");Set("OpenCodeConfig",settings);Wait(()=>Find("Discover").Current.IsEnabled,"discovery did not finish",90000);
                if(Get("OpenCodeConfig")!=settings)throw new Exception("late discovery overwrote manual config");Click("CloseAdvanced");window=advancedParent;Close();Console.WriteLine("PASS actual GUI automatic discovery, existing-install selection and manual-input freshness");
            }
            Launch(exe,common);Click("Preview");Click("Preview");Wait(()=>Get("Status").Contains("준비가 완료"),"preview failed");Screenshot(Path.Combine(root,"preview-cancel.png"));Click("Back");Click("Preview");Wait(()=>Get("Status").Contains("준비가 완료"),"second preview failed");Close();
            if(File.Exists(Path.Combine(install,".agent-browser-install.json")))throw new Exception("Cancel installed product");
            Console.WriteLine("PASS actual GUI preview/back/cancel without installation");
            Launch(exe,common);Click("Preview");Click("AdvancedSettings");var advancedWindow=EnterDialog("AgentBrowser 고급 설정");Click("RegisterMcp");Choose("OpenCodeKind",1);Set("Distribution","Ubuntu");Set("OpenCodeConfig",settings);Click("AddRegistration");Click("CloseAdvanced");window=advancedWindow;Click("Preview");Wait(()=>Get("Status").Contains("준비가 완료"),"WSL preview failed");Screenshot(Path.Combine(root,"wsl-preview.png"));
            if(args.Contains("--failure")) {var blocker=new TcpListener(IPAddress.Loopback,port);try{blocker.Start();Click("Apply");Wait(()=>Get("Status").Contains("다시 시도"),"expected startup failure missing",50000);Screenshot(Path.Combine(root,"startup-failure.png"));if(File.Exists(Path.Combine(install,".agent-browser-install.json"))||File.ReadAllText(settings)!=original)throw new Exception("failed install did not roll back files/config");}finally{blocker.Stop();}Click("Back");Click("Preview");Wait(()=>Get("Status").Contains("준비가 완료"),"retry preview failed");Console.WriteLine("PASS actual GUI startup failure rollback and retry preview");}
            Click("Apply");Wait(()=>Get("Status").StartsWith("설치 완료"),"GUI install failed");Screenshot(Path.Combine(root,"install-complete.png"));Close();
            Console.WriteLine("PASS actual GUI install and WSL missing-mcp registration");
            if(args.Contains("--profiles")) {
                // A freshly installed GUI saves a managed profile on the runtime page
                // itself via the real Bridge CLI, without starting OpenCode or a model.
                string executable="/home/jihoon/.opencode/bin/opencode";
                Launch(exe,common+" --no-runtime-start");Click("ManageConnection");PairingStep();Click("Preview");
                Choose("RuntimeKind",1);Set("RuntimeDistribution","Ubuntu");Set("RuntimeExecutable",executable);Set("RuntimeDirectory",Path.GetDirectoryName(settings.Substring(settings.IndexOf("\\tmp\\",StringComparison.Ordinal))).Replace('\\','/'));
                Click("SaveRuntime");if(args.Contains("--async-profile"))Click("SaveRuntime");
                Wait(()=>Get("RuntimeResult").Contains("저장했습니다")&&Find("SaveRuntime").Current.IsEnabled,"profile save failed",60000);Screenshot(Path.Combine(root,"managed-profile-saved.png"));
                Close();
                var listed=new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(install,"data","runtime.json")));
                int saved=((System.Collections.Generic.Dictionary<string,object>)listed["profiles"]).Values.OfType<System.Collections.Generic.Dictionary<string,object>>().Count(p=>(string)p["executable"]==executable);
                if(saved!=1)throw new Exception("expected exactly one saved profile, found "+saved);
                if(args.Contains("--async-profile"))Console.WriteLine("PASS actual GUI double save creates one profile");
                Console.WriteLine("PASS actual GUI managed WSL profile validation/save without runtime/model start");
                Launch(exe,common);Click("ManageConnection");string pidBefore=File.ReadAllText(Path.Combine(install,"data","serve.pid"));PairingStep();
                if(File.ReadAllText(Path.Combine(install,"data","serve.pid"))!=pidBefore)throw new Exception("pairing preparation replaced the running owned Bridge");
                if(!Find("PairingToken").Current.IsPassword||Get("PairingUrl")!="ws://127.0.0.1:"+port+"/extension")throw new Exception("pairing step must mask token and show current port");
                Screenshot(Path.Combine(root,"pairing-masked.png"));Click("Back");if(!Get("ExtensionFolder").EndsWith("extension"))throw new Exception("Back did not return to Chrome extension step");
                PairingStep();Click("Preview");Screenshot(Path.Combine(root,"runtime-step.png"));Click("Preview");Screenshot(Path.Combine(root,"wizard-complete.png"));
                if(Find("Cancel").Current.Name!="Cancel")throw new Exception("Finish action missing");Close();Console.WriteLine("PASS sequential Chrome/pairing/runtime/completion and masked token; token not read or copied by test");
            }
            string first=File.ReadAllText(settings);if(!first.Contains("\"browser\"")||!first.Contains("// preserve"))throw new Exception("WSL settings or comment missing");
            File.WriteAllText(Path.Combine(install,"data","gui-preserve.json"),"{\"synthetic\":true}");
            File.WriteAllText(settings,first.Replace("test/model","test/user-edited"),new System.Text.UTF8Encoding(false));
            }
            Launch(exe,common);Choose("Operation",1);Click("Preview");Click("Preview");Wait(()=>Get("Status").Contains("준비가 완료"),"update preview failed");Click("Apply");Wait(()=>Get("Status").StartsWith("설치 완료"),"GUI update failed");Screenshot(Path.Combine(root,"update-complete.png"));Close();
            string updated=File.ReadAllText(settings);if(!updated.Contains("test/user-edited")||System.Text.RegularExpressions.Regex.Matches(updated,"\"browser\"").Count!=1)throw new Exception("update duplicated MCP or lost model");
            if(args.Contains("--upgrade")) {var state=new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(install,".agent-browser-install.json")));if((string)state["Version"]!=expectedVersion||(string)state["InstallId"]!=File.ReadAllText(Path.Combine(root,"old-identity.txt")))throw new Exception("cross-version update lost version/identity");using(var sha=System.Security.Cryptography.SHA256.Create()){string hash=BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(Path.Combine(install,"data","config.json")))).Replace("-","").ToLowerInvariant();if(hash!=File.ReadAllText(Path.Combine(root,"old-config-sha.txt")))throw new Exception("upgrade changed pairing data");}Console.WriteLine("PASS actual GUI published "+previousVersion+" Bridge installation upgraded to "+expectedVersion+"; identity/pairing preserved");}
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
            Launch(exe,common);Choose("Operation",2);Click("Preview");Click("Preview");Wait(()=>Get("Status").Contains("준비가 완료"),"uninstall preview failed");if(!Get("ChangePreview").Contains(install))throw new Exception("uninstall preview missing target");Screenshot(Path.Combine(root,"uninstall-preview.png"));Click("Apply");Wait(()=>Get("Status").StartsWith("제거 완료"),"GUI uninstall failed");Screenshot(Path.Combine(root,"uninstall-complete.png"));Close();
            if(File.Exists(Path.Combine(install,".agent-browser-install.json"))||!File.Exists(Path.Combine(install,"data","gui-preserve.json")))throw new Exception("uninstall data ownership failure");
            string final=File.ReadAllText(settings);if(final.Contains("\"browser\"")||!final.Contains("test/user-edited")||!final.Contains("// preserve")||(original.Contains("\"other\"")?!final.Contains("\"other\""):final.Contains("\"mcp\"")))throw new Exception("uninstall did not preserve the original MCP state");
            Console.WriteLine("PASS actual GUI uninstall target confirmation, no-mcp restoration and data preservation");
            Console.WriteLine("GUI_ROOT "+root);return 0;
        }catch(Exception error){Console.Error.WriteLine(error);if(process!=null&&!process.HasExited) {Console.Error.WriteLine("GUI_PID "+process.Id);try{Screenshot(Path.Combine(root,"failure.png"));}catch{}}return 1;}
    }
}

