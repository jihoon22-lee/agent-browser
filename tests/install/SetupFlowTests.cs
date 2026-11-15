using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace AgentBrowser.Installer {
 internal static class SetupFlowTests {
  static int failed,passed;
  static void Assert(bool value,string reason){if(!value)throw new Exception(reason);}
  static void Case(string name,Action test){try{test();passed++;Console.WriteLine("PASS "+name);}catch(Exception error){failed++;Console.WriteLine("FAIL "+name+": "+error.GetBaseException().Message);}}
  static T Field<T>(Form form,string name) where T:Control {return (T)form.Controls.Find(name,true).Single();}
  static void Invoke(Form form,string method){SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());var result=typeof(SetupForm).GetMethod(method,BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,null) as Task;if(result==null)return;var end=DateTime.UtcNow.AddSeconds(30);while(!result.IsCompleted&&DateTime.UtcNow<end){Application.DoEvents();Thread.Sleep(10);}Assert(result.IsCompleted,"UI operation timed out");result.GetAwaiter().GetResult();}
  // Application.DoEvents() restores the console context when it returns. A click made after that would
  // start its async work without the WinForms context and continue on a pool thread, off the UI thread.
  static void Click(Form form,string name){SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Field<Button>(form,name).PerformClick();}
  static string FreePort(){var listener=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,0);listener.Start();string port=((System.Net.IPEndPoint)listener.LocalEndpoint).Port.ToString();listener.Stop();return port;}
  static System.Collections.Generic.Dictionary<string,object> Json(string text){return NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(text);}
  const string ExtensionId="icgmjjcpnaenpfjfoggnaodeaidbnihl";
  static void Until(Func<bool> done,int seconds,string reason){var end=DateTime.UtcNow.AddSeconds(seconds);while(!done()&&DateTime.UtcNow<end){Application.DoEvents();Thread.Sleep(10);}Assert(done(),reason);}
  static void Uninstall(string root){if(InstallerEngine.State(root)!=null)InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{Operation="uninstall",InstallDir=root}),CancellationToken.None,s=>{});}
  [STAThread] public static int Main(string[] args){
   // An exception on the UI thread must fail its case, not wait in a dialog nobody will click.
   Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
   string fixture=args[0],package=args[1];InstallerEngine.PrivateDirectory(fixture);
   Case("installer errors are shown in Korean with the next action",()=>{
    var text=Friendly.Message(new IOException("Installation ownership marker is invalid."));
    Assert(text.Contains("설치 기록")&&text.Contains("다른 폴더"),text);
    Assert(text.Contains("원문: Installation ownership marker is invalid."),text);
    Assert(Friendly.Message(new IOException("Package checksum mismatch: browser-bridge.exe")).Contains("다시 받아"),"checksum");
    Assert(Friendly.Message(new IOException("Pair the Chrome extension first")).Contains("Chrome 연결"),"pairing");
    Assert(Friendly.Message(new IOException("이미 한국어인 안내"))=="이미 한국어인 안내","Korean text must stay as is");
   });
   Case("pairing helpers identify the fixed extension and a connected browser",()=>{
    string manifest=Path.Combine(package,"extension","manifest.json");
    Assert(Pairing.ExtensionId(manifest)=="icgmjjcpnaenpfjfoggnaodeaidbnihl","extension id");
    var connected=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"pairedExtensionId\":\"icgmjjcpnaenpfjfoggnaodeaidbnihl\",\"extensionSeen\":null,\"browsers\":[{\"clientId\":\"cli-1\",\"connected\":true,\"selected\":true}]}");
    Assert(Pairing.Connected(connected,"icgmjjcpnaenpfjfoggnaodeaidbnihl"),"connected browser");
    var seen=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"pairedExtensionId\":null,\"extensionSeen\":\"icgmjjcpnaenpfjfoggnaodeaidbnihl\",\"browsers\":[]}");
    Assert(!Pairing.Connected(seen,"icgmjjcpnaenpfjfoggnaodeaidbnihl")&&Pairing.Seen(seen,"icgmjjcpnaenpfjfoggnaodeaidbnihl"),"seen but unpaired");
   });
   Case("the pairing page shows a one-time code with a manual token fallback",()=>{
    string root=Path.Combine(fixture,"pairing-page");
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-browser-launch","--no-startup","--install-dir",root,"--package-dir",package,"--port",FreePort()})){
     form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Click(form,"Preview");Invoke(form,"Prepare");Invoke(form,"Apply");
     Assert(Field<Button>(form,"OpenExtensions").Visible,"no way to open the Chrome extensions page");
     // The 1.5 s detection timer must not verify (hash) the whole installation on every tick.
     var detectionStarted=typeof(SetupForm).GetField("detectionBridgeStarted",BindingFlags.Instance|BindingFlags.NonPublic);
     var detectionEnd=DateTime.UtcNow.AddSeconds(30);while(!(bool)detectionStarted.GetValue(form)&&DateTime.UtcNow<detectionEnd){Invoke(form,"DetectExtension");Application.DoEvents();Thread.Sleep(20);}
     Assert((bool)detectionStarted.GetValue(form),"extension detection did not start");
     int verifications=InstallerEngine.OwnedVerifications;for(int tick=0;tick<3;tick++)Invoke(form,"DetectExtension");
     Assert(InstallerEngine.OwnedVerifications==verifications,"each detection tick verified every installed file again");
     Invoke(form,"PreparePairing");
     Assert(Field<Button>(form,"ConnectChrome").Visible&&Field<Button>(form,"CopyPairingToken").Visible,"pairing page lacks code or manual connection");
     // Opening the page issues the code; nobody has to press a button first.
     Until(()=>Field<Label>(form,"PairingCode").Text!="",30,"opening the pairing page did not issue a code");
     var code=Field<Label>(form,"PairingCode").Text;
     Assert(System.Text.RegularExpressions.Regex.IsMatch(code,@"^\d{3} \d{3}$"),"pairing code not shown: "+code);
     form.Close();
    }}finally{Uninstall(root);}
   });
   Case("saved runtime appears in the Bridge profile list and on the page",()=>{
    string root=Path.Combine(fixture,"inline-runtime"),fake=Path.Combine(fixture,"fake-opencode");Directory.CreateDirectory(fake);
    string cmd=Path.Combine(fake,"opencode.cmd");File.WriteAllText(cmd,"@echo off\r\necho 1.18.29\r\n");
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-startup","--no-runtime-start","--no-browser-launch","--install-dir",root,"--package-dir",package,"--port",FreePort()})){
     form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Click(form,"Preview");Invoke(form,"Prepare");Invoke(form,"Apply");
     Invoke(form,"PreparePairing");Click(form,"Preview");
     Assert(Field<Panel>(form,"RuntimePanel").Visible,"runtime page missing");
     Assert(!form.Controls.Find("ManagedProfiles",true).Any(),"the separate profile dialog must be gone");
     Field<ComboBox>(form,"RuntimeKind").SelectedIndex=0;Field<TextBox>(form,"RuntimeExecutable").Text=cmd;Field<TextBox>(form,"RuntimeDirectory").Text=fixture;
     Invoke(form,"SaveRuntime");
     var state=InstallerEngine.State(root);
     var listed=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"profile","list","--json"}));
     var profiles=((System.Collections.IEnumerable)listed["profiles"]).OfType<System.Collections.Generic.Dictionary<string,object>>().ToList();
     Assert(profiles.Count==1&&(string)profiles[0]["executable"]==cmd,"the Bridge does not report the saved profile");
     Assert((string)listed["defaultProfileId"]==(string)profiles[0]["id"],"the saved profile is not the default");
     Assert(Field<ListBox>(form,"SavedProfiles").Items.Count==1,"the page does not show what the Bridge saved");
     Assert(Field<TextBox>(form,"RuntimeResult").Text.Contains("저장했습니다"),Field<TextBox>(form,"RuntimeResult").Text);
     // A short result shows no empty scroll bar; a long one scrolls.
     Assert(Field<TextBox>(form,"RuntimeResult").ScrollBars==ScrollBars.None&&Field<TextBox>(form,"RuntimeResult").ReadOnly,"a one-line result shows an empty scroll bar");
     Field<Notice>(form,"RuntimeResult").Fail(String.Join(" ",Enumerable.Repeat("OpenCode HTTP and browser MCP did not become ready within 60 seconds.",4)));
     Assert(Field<TextBox>(form,"RuntimeResult").ScrollBars==ScrollBars.Vertical,"long runtime results must stay readable");
     Field<TextBox>(form,"RuntimeResult").Text="";
     Field<TextBox>(form,"RuntimeExecutable").Text=cmd;Invoke(form,"SaveRuntime");
     listed=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"profile","list","--json"}));
     Assert(((System.Collections.IEnumerable)listed["profiles"]).OfType<object>().Count()==1,"saving again on the page created a duplicate profile");
     form.Close();
    }
    // Running the wizard again for the same OpenCode reuses the saved profile.
    using(var again=new SetupForm(new[]{"--no-discover","--no-startup","--no-runtime-start","--install-dir",root,"--package-dir",package})){
     again.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
     Field<ComboBox>(again,"RuntimeKind").SelectedIndex=0;Field<TextBox>(again,"RuntimeExecutable").Text=cmd;Field<TextBox>(again,"RuntimeDirectory").Text=fixture;
     Invoke(again,"SaveRuntime");
     var state=InstallerEngine.State(root);
     var listed=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"profile","list","--json"}));
     var profiles=((System.Collections.IEnumerable)listed["profiles"]).OfType<System.Collections.Generic.Dictionary<string,object>>().ToList();
     Assert(profiles.Count==1,"a second wizard run added another profile for the same OpenCode: "+profiles.Count);
     Assert((string)listed["defaultProfileId"]==(string)profiles[0]["id"]&&Field<TextBox>(again,"RuntimeResult").Text.Contains("저장했습니다"),"the reused profile is not reported as saved: "+Field<TextBox>(again,"RuntimeResult").Text);
     again.Close();
    }
    var summary=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"profiles\":[{\"id\":\"mine\",\"name\":\"Mine\",\"kind\":\"wsl\",\"distribution\":\"Ubuntu\",\"executable\":\"/opt/opencode\",\"directory\":\"/srv/work\",\"envKeys\":[\"HTTPS_PROXY\"]}]}");
    var wslCandidate=new OpenCodeCandidate{Kind="wsl",Distribution="ubuntu",Executable="/opt/opencode"};
    var match=ManagedProfile.FindSame(summary,wslCandidate,"/srv/work");
    Assert(match!=null&&(string)match["id"]=="mine"&&!ManagedProfile.WizardCanRewrite(match),"a profile with settings the wizard cannot show must be reused without rewriting it");
    Assert(ManagedProfile.FindSame(summary,wslCandidate,"/srv/other")==null&&ManagedProfile.FindSame(summary,new OpenCodeCandidate{Kind="wsl",Distribution="Debian",Executable="/opt/opencode"},"/srv/work")==null,"a different work folder or distribution was treated as the same profile");
    }finally{Uninstall(root);}
   });
   Case("the final page reports real connection checks with next actions",()=>{
    var status=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"pairedExtensionId\":\"icgmjjcpnaenpfjfoggnaodeaidbnihl\",\"browsers\":[{\"clientId\":\"c\",\"connected\":true,\"selected\":true}]}");
    var doctor=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"checks\":[{\"id\":\"opencode\",\"status\":\"warning\",\"message\":\"stopped\",\"profileId\":\"p\"},{\"id\":\"mcp\",\"status\":\"warning\",\"message\":\"MCP was not checked\",\"profileId\":\"p\"}]}");
    var lines=DoneChecks.Lines(status,doctor,"icgmjjcpnaenpfjfoggnaodeaidbnihl");
    Assert(lines.Any(l=>l.StartsWith("✓")&&l.Contains("Chrome")),"chrome check");
    Assert(lines.Any(l=>l.Contains("실행 환경")&&l.Contains("처음 보낼 때")),"stopped runtime explained");
    var none=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"pairedExtensionId\":null,\"browsers\":[]}");
    Assert(DoneChecks.Lines(none,NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"checks\":[]}"),"icgmjjcpnaenpfjfoggnaodeaidbnihl").Any(l=>l.StartsWith("✗")&&l.Contains("Chrome")&&l.Contains("연결")),"missing chrome connection");
   });
   Case("waiting for Chrome does not lock the wizard and starting unpaired explains the pairing step",()=>{
    string root=Path.Combine(fixture,"pair-wait"),fake=Path.Combine(fixture,"fake-opencode-2");Directory.CreateDirectory(fake);
    string cmd=Path.Combine(fake,"opencode.cmd");File.WriteAllText(cmd,"@echo off\r\necho 1.18.29\r\n");
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-startup","--no-browser-launch","--install-dir",root,"--package-dir",package,"--port",FreePort()})){
     form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Click(form,"Preview");Invoke(form,"Prepare");Invoke(form,"Apply");
     Invoke(form,"PreparePairing");
     var waiting=(Task)typeof(SetupForm).GetMethod("ConnectChrome",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,null);
     var end=DateTime.UtcNow.AddSeconds(30);while(Field<Label>(form,"PairingCode").Text==""&&DateTime.UtcNow<end){Application.DoEvents();Thread.Sleep(10);}
     Assert(Field<Label>(form,"PairingCode").Text!="","pairing code did not appear");
     Click(form,"Preview");Application.DoEvents();
     end=DateTime.UtcNow.AddSeconds(5);while(!waiting.IsCompleted&&DateTime.UtcNow<end){Application.DoEvents();Thread.Sleep(10);}
     Assert(waiting.IsCompleted,"leaving the pairing page did not stop waiting for Chrome");
     Assert(Field<Panel>(form,"RuntimePanel").Visible,"the wizard did not stay on the runtime page");
     Field<ComboBox>(form,"RuntimeKind").SelectedIndex=0;Field<TextBox>(form,"RuntimeExecutable").Text=cmd;Field<TextBox>(form,"RuntimeDirectory").Text=fixture;
     Invoke(form,"SaveRuntime");
     Assert(Field<TextBox>(form,"RuntimeResult").Text.Contains("Chrome 연결 단계"),"unpaired start must point at the pairing step: "+Field<TextBox>(form,"RuntimeResult").Text);
     Click(form,"Preview");Application.DoEvents();
     Assert(Field<Panel>(form,"DonePanel").Visible&&Field<Button>(form,"Back").Visible,"the final page offers [뒤로] but hides it");
     Click(form,"Back");Assert(Field<Panel>(form,"RuntimePanel").Visible,"Back from the final page must return to the runtime page");
     // The failed check leads straight to its step instead of asking for [뒤로] several times.
     Click(form,"Preview");
     Until(()=>Field<Button>(form,"FixChrome").Visible,90,"the final page offers no way to the Chrome step that failed");
     Assert(Field<Button>(form,"Recheck").Visible,"the final page cannot repeat its checks");
     Click(form,"FixChrome");
     Assert(Field<Panel>(form,"ConnectionPanel").Visible&&Field<TextBox>(form,"ExtensionFolder").Text==Path.Combine(root,"extension"),"the Chrome step did not open from the final page");
     form.Close();
    }}finally{Uninstall(root);}
   });
   Case("setup resumes at the first step that still needs the user",()=>{
    var unpaired=Json("{\"pairedExtensionId\":null,\"extensionSeen\":null,\"browsers\":[]}");
    var paired=Json("{\"pairedExtensionId\":\""+ExtensionId+"\",\"browsers\":[]}");
    var none=Json("{\"profiles\":[]}");
    var saved=Json("{\"defaultProfileId\":\"managed-1\",\"profiles\":[{\"id\":\"managed-1\",\"name\":\"OpenCode\",\"kind\":\"windows\"}]}");
    var stale=Json("{\"defaultProfileId\":\"gone\",\"profiles\":[{\"id\":\"managed-1\",\"name\":\"OpenCode\",\"kind\":\"windows\"}]}");
    Assert(SetupForm.ResumePage(unpaired,saved,ExtensionId)==4,"an unpaired extension must start at the Chrome extension step");
    Assert(SetupForm.ResumePage(Json("{\"pairedExtensionId\":\"another\",\"browsers\":[]}"),saved,ExtensionId)==4,"another extension's pairing must not skip the Chrome steps");
    Assert(SetupForm.ResumePage(paired,none,ExtensionId)==6&&SetupForm.ResumePage(paired,stale,ExtensionId)==6,"a paired extension without a saved default runtime must open the OpenCode step");
    Assert(SetupForm.ResumePage(paired,saved,ExtensionId)==7,"a paired extension with a default runtime has nothing left to set up");
   });
   Case("reopening a finished setup opens the final checks and Back still reaches every step",()=>{
    string root=Path.Combine(fixture,"resume"),fake=Path.Combine(fixture,"fake-opencode-3");Directory.CreateDirectory(fake);
    string cmd=Path.Combine(fake,"opencode.cmd");File.WriteAllText(cmd,"@echo off\r\necho 1.18.29\r\n");
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-startup","--no-runtime-start","--no-browser-launch","--install-dir",root,"--package-dir",package,"--port",FreePort()})){
     form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Click(form,"Preview");Invoke(form,"Prepare");Invoke(form,"Apply");
     Assert(Field<Panel>(form,"ConnectionPanel").Visible,"a new installation must start at the Chrome extension step");
     Invoke(form,"PreparePairing");Click(form,"Preview");
     Field<ComboBox>(form,"RuntimeKind").SelectedIndex=0;Field<TextBox>(form,"RuntimeExecutable").Text=cmd;Field<TextBox>(form,"RuntimeDirectory").Text=fixture;
     Invoke(form,"SaveRuntime");form.Close();
    }
    using(var again=new SetupForm(new[]{"--no-discover","--no-browser-launch","--install-dir",root})){
     again.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
     again.BridgeStatus=state=>Json("{\"pairedExtensionId\":\""+ExtensionId+"\",\"extensionSeen\":null,\"browsers\":[{\"clientId\":\"c\",\"connected\":true,\"selected\":true}]}");
     Invoke(again,"OpenSetup");
     Assert(Field<Panel>(again,"DonePanel").Visible,"a paired installation with a saved runtime was walked through the setup steps again");
     Assert(again.Controls.Find("StepBar",true).Single().AccessibleName.Contains("완료"),"the step bar does not show the final step");
     Until(()=>Field<ListBox>(again,"DoneChecks").Items.Cast<object>().Any(i=>i.ToString().StartsWith("✓")&&i.ToString().Contains("Chrome")),90,"the final checks did not run after skipping");
     Assert(!Field<Button>(again,"FixChrome").Visible,"a connected Chrome is offered the Chrome step again");
     Click(again,"Back");Assert(Field<Panel>(again,"RuntimePanel").Visible,"Back from the final page did not open the OpenCode step");
     Until(()=>Field<ListBox>(again,"SavedProfiles").Items.Cast<object>().Any(i=>i.ToString().Contains("OpenCode (Windows)")),30,"the skipped OpenCode step does not list the saved runtime");
     Click(again,"Back");Assert(Field<Panel>(again,"PairingPanel").Visible,"Back did not open the pairing step");
     Assert(Field<TextBox>(again,"PairingToken").Text.Length==64,"the skipped pairing step has no manual connection values");
     Assert(Field<Label>(again,"PairingCode").Text=="","going back issued a pairing code nobody asked for");
     again.Close();
    }}finally{Uninstall(root);}
   });
   Case("a detected extension moves on to pairing by itself, except after Back",()=>{
    string root=Path.Combine(fixture,"auto-advance");
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-startup","--no-browser-launch","--install-dir",root,"--package-dir",package,"--port",FreePort()})){
     form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Click(form,"Preview");Invoke(form,"Prepare");Invoke(form,"Apply");
     Assert(Field<Panel>(form,"ConnectionPanel").Visible,"Chrome step is missing");
     Invoke(form,"DetectExtension");Assert(Field<Panel>(form,"ConnectionPanel").Visible,"the wizard left the Chrome step before the extension was added");
     form.BridgeStatus=state=>Json("{\"pairedExtensionId\":null,\"extensionSeen\":\""+ExtensionId+"\",\"browsers\":[]}");
     Invoke(form,"DetectExtension");
     Assert(Field<Panel>(form,"PairingPanel").Visible,"the detected extension still waits for [다음]");
     Until(()=>Field<Label>(form,"PairingCode").Text!="",30,"the pairing code was not issued after the automatic step");
     Click(form,"Back");Assert(Field<Panel>(form,"ConnectionPanel").Visible,"Back did not return to the Chrome step");
     Invoke(form,"DetectExtension");
     Assert(Field<Panel>(form,"ConnectionPanel").Visible,"Back to the Chrome step was undone by the automatic step");
     Assert(Field<Label>(form,"ExtensionDetected").Text.Contains("✓")&&Field<Label>(form,"ExtensionDetected").Text.Contains("[다음]"),"the detected extension is not reported after Back: "+Field<Label>(form,"ExtensionDetected").Text);
     form.Close();
    }}finally{Uninstall(root);}
   });
   Case("the step bar shows where the user is",()=>{
    Assert(SetupForm.StepOf(0,false)==0&&SetupForm.StepOf(3,false)==0&&SetupForm.StepOf(4,false)==1&&SetupForm.StepOf(5,false)==2&&SetupForm.StepOf(6,false)==3&&SetupForm.StepOf(7,false)==4,"install pages map to the wrong steps");
    Assert(SetupForm.StepOf(2,true)==0&&SetupForm.StepOf(7,true)==1,"removal pages map to the wrong steps");
    using(var form=new SetupForm(new[]{"--no-discover","--install-dir",Path.Combine(fixture,"step-bar")})){
     var bar=form.Controls.Find("StepBar",true).Single();
     Assert(bar.AccessibleName=="5단계 중 1단계: 설치","first step: "+bar.AccessibleName);
     typeof(SetupForm).GetMethod("SetPage",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{5});
     Assert(bar.AccessibleName=="5단계 중 3단계: Chrome 연결","pairing step: "+bar.AccessibleName);
     var labels=bar.Controls.OfType<Label>().Select(l=>l.Text).ToList();
     Assert(labels.Contains("✓ 설치")&&labels.Contains("✓ 확장 추가")&&labels.Contains("3 Chrome 연결")&&labels.Contains("4 OpenCode")&&labels.Contains("5 완료"),"step labels: "+String.Join(" | ",labels));
     typeof(SetupForm).GetMethod("SetPage",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{0});
     Field<ComboBox>(form,"Operation").SelectedIndex=2;
     Assert(bar.AccessibleName=="2단계 중 1단계: 제거","removal steps: "+bar.AccessibleName);
    }
   });
   Case("errors are marked apart from routine messages",()=>{
    using(var form=new SetupForm(new[]{"--no-discover","--install-dir",Path.Combine(fixture,"notice")})){
     var status=Field<TextBox>(form,"Status");int routine=status.ForeColor.ToArgb();
     Invoke(form,"OpenSetup");
     Assert(status.Text.StartsWith("⚠ ")&&status.Text.Contains("설치되지"),"the error is not marked: "+status.Text);
     Assert(status.ForeColor.ToArgb()!=routine&&status.BackColor.ToArgb()!=Color.White.ToArgb(),"an error looks like a routine message");
     Invoke(form,"LoadState");
     Assert(status.Text==""&&status.ForeColor.ToArgb()==routine&&status.BackColor.ToArgb()==Color.White.ToArgb(),"the error mark stayed after the message was cleared");
     status.Text="✓ 완료";Assert(status.ForeColor.ToArgb()!=routine&&status.BackColor.ToArgb()==Color.White.ToArgb(),"a success line is not marked");
     Assert(Field<TextBox>(form,"PairingState") is Notice&&Field<TextBox>(form,"RuntimeResult") is Notice,"step results cannot mark errors");
    }
   });
   Case("the final checks say which step to reopen",()=>{
    var doctor=Json("{\"checks\":[{\"id\":\"opencode\",\"status\":\"ok\",\"profileId\":\"p\"}]}");
    var connected=DoneChecks.Report(Json("{\"pairedExtensionId\":\""+ExtensionId+"\",\"browsers\":[{\"clientId\":\"c\",\"connected\":true}]}"),doctor,ExtensionId);
    Assert(connected.ChromeConnected&&!connected.NeedsChrome&&!connected.NeedsRuntime&&!connected.Lines.Any(l=>l.StartsWith("✗")),"a finished setup reports work to do");
    var closed=DoneChecks.Report(Json("{\"pairedExtensionId\":\""+ExtensionId+"\",\"browsers\":[]}"),doctor,ExtensionId);
    Assert(!closed.ChromeConnected&&closed.NeedsChrome&&!closed.Lines.Any(l=>l.StartsWith("✗"))&&closed.Lines.Any(l=>l.Contains("Chrome을 열면")),"a paired Chrome that is not open is reported as a failure: "+String.Join(" | ",closed.Lines));
    var unpaired=DoneChecks.Report(Json("{\"pairedExtensionId\":null,\"browsers\":[]}"),Json("{\"checks\":[]}"),ExtensionId);
    Assert(unpaired.NeedsChrome&&unpaired.NeedsRuntime&&unpaired.Lines.Count(l=>l.StartsWith("✗"))==2,"an unfinished setup does not name both steps: "+String.Join(" | ",unpaired.Lines));
    var broken=DoneChecks.Report(Json("{\"pairedExtensionId\":\""+ExtensionId+"\",\"browsers\":[{\"clientId\":\"c\",\"connected\":true}]}"),Json("{\"checks\":[{\"id\":\"opencode\",\"status\":\"error\",\"message\":\"missing\"}]}"),ExtensionId);
    Assert(broken.NeedsRuntime&&!broken.NeedsChrome,"a failing runtime does not point at the OpenCode step");
   });
   Case("Bridge start errors are explained and not retried on every detection tick",()=>{
    Assert(Friendly.Message(new IOException("Bridge PID does not belong to this startup.")).Contains("포트"),"an unverified Bridge is not explained");
    Assert(Friendly.Message(new IOException("Owned Bridge startup failed (1).")).Contains("포트"),"a failed start is not explained");
    string root=Path.Combine(fixture,"start-once");int port=Int32.Parse(FreePort());
    try{InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false,Port=port}),CancellationToken.None,m=>{});
     var blocker=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,port);blocker.Start();
     try{using(var form=new SetupForm(new[]{"--no-discover","--no-browser-launch","--install-dir",root})){
      form.Show();Invoke(form,"OpenSetup");
      Assert(Field<Panel>(form,"ConnectionPanel").Visible,"the Chrome step did not open after a failed Bridge start");
      int before=BridgeControl.Starts;for(int tick=0;tick<3;tick++)Invoke(form,"DetectExtension");
      Assert(BridgeControl.Starts==before+1,"each detection tick started the Bridge again: "+(BridgeControl.Starts-before));
      form.Close();
     }}finally{blocker.Stop();}
    }finally{Uninstall(root);}
   });
   Case("choosing another OpenCode follows its home unless the user chose a work folder",()=>{
    using(var form=new SetupForm(new[]{"--no-discover","--install-dir",Path.Combine(fixture,"candidate-home")})){
     form.Show();Application.DoEvents();
     var list=Field<ComboBox>(form,"RuntimeCandidates");var directory=Field<TextBox>(form,"RuntimeDirectory");
     list.Items.Add(new OpenCodeCandidate{Kind="windows",Home=@"C:\Users\synthetic",Executable=@"C:\Users\synthetic\opencode.exe"});
     list.Items.Add(new OpenCodeCandidate{Kind="wsl",Distribution="Ubuntu",User="synthetic",Home="/home/synthetic",Executable="/home/synthetic/.opencode/bin/opencode"});
     list.SelectedIndex=0;Assert(directory.Text==@"C:\Users\synthetic","the first candidate did not suggest its home: "+directory.Text);
     list.SelectedIndex=1;Assert(directory.Text=="/home/synthetic","a Windows work folder stayed after choosing a WSL candidate: "+directory.Text);
     directory.Text="/srv/project";list.SelectedIndex=0;Assert(directory.Text=="/srv/project","a work folder the user typed was replaced");
     form.Close();
    }
    var wsl=new OpenCodeCandidate{Kind="wsl",Distribution="Ubuntu",User="synthetic",Executable="/opt/opencode"};
    Assert(SetupForm.RuntimeUser(wsl,"wsl","Ubuntu","/opt/opencode")=="synthetic","the same distribution must keep the discovered user");
    Assert(SetupForm.RuntimeUser(wsl,"wsl","Debian","/opt/opencode")==null,"another distribution must not reuse the discovered user");
    Assert(SetupForm.RuntimeUser(wsl,"wsl","Ubuntu","/usr/bin/opencode")==null&&SetupForm.RuntimeUser(wsl,"windows","Ubuntu","/opt/opencode")==null&&SetupForm.RuntimeUser(null,"wsl","Ubuntu","/opt/opencode")==null,"a user was reused without a matching candidate");
   });
   Case("long result and check lines stay readable",()=>{
    using(var form=new SetupForm(new[]{"--no-discover","--install-dir",Path.Combine(fixture,"read-lines")})){
     Assert(Field<ListBox>(form,"DoneChecks").HorizontalScrollbar,"final checks cannot scroll sideways");
     var state=Field<Notice>(form,"PairingState");state.Text="코드를 확인했습니다.";Assert(state.Multiline&&state.ReadOnly&&state.ScrollBars==ScrollBars.None,"a short pairing result shows an empty scroll bar");
     state.Fail(String.Join("\r\n",Enumerable.Repeat("페어링 코드가 만료됐습니다. [코드 다시 받기]를 누르세요.",3)));Assert(state.ScrollBars==ScrollBars.Vertical,"pairing errors are clipped");
     var status=Field<Notice>(form,"Status");status.Text=String.Join(" ",Enumerable.Repeat("설치 파일을 적용하는 중입니다.",14));Assert(status.ScrollBars==ScrollBars.Vertical,"a long wrapped status line is clipped");
     status.Text="준비가 완료되었습니다.";Assert(status.ScrollBars==ScrollBars.None,"a short status shows an empty scroll bar");
    }
   });
   Case("discovery uses the found distribution and always shows its notices",()=>{
    Assert(SetupForm.DistributionToStart("",new[]{"Ubuntu","Debian"},new[]{"Debian"})=="Debian","empty field must start the stopped distribution, not restart a running one");
    Assert(SetupForm.DistributionToStart("",new[]{"Ubuntu"},new string[0])==null,"nothing is stopped, so nothing is restarted");
    Assert(SetupForm.DistributionToStart(" Debian ",new[]{"Ubuntu"},new string[0])=="Debian","typed name wins");
    Assert(SetupForm.DistributionToStart("",new string[0],new string[0])==null,"no distribution to start");
    var stopped=new DiscoveryResult();Assert(stopped.Stopped.Count==0,"discovery lists stopped distributions");
    Assert(SetupForm.DiscoveryMessage(2,new[]{"Debian is stopped"}).Contains("Debian is stopped"),"notices hidden behind candidates");
    Assert(SetupForm.DiscoveryMessage(0,new string[0]).Contains("직접 입력"),"no candidates explains the manual path");
   });
   Case("new folder guides installation before maintenance",()=>{using(var form=new SetupForm(new[]{"--no-discover","--install-dir",Path.Combine(fixture,"new")})){form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Application.DoEvents();Assert(!form.Controls.Find("StartInstalledBridge",true).Any(c=>c.Visible),"Bridge start is exposed before installation");Assert(!form.Controls.Find("Pairing",true).Any(c=>c.Visible),"pairing is exposed before installation");Assert(!Field<Button>(form,"ManageConnection").Enabled,"maintenance is enabled before installation");Assert(Field<Button>(form,"Preview").Text.Contains("다음"),"primary action has no next-step label");Assert(!Field<TextBox>(form,"PackageFolder").Visible,"advanced package path is exposed by default");Assert(Field<Panel>(form,"WelcomePanel").Visible,"welcome page is missing");Click(form,"Preview");Assert(Field<Panel>(form,"SettingsPanel").Visible,"Next did not open location page");Assert(!Field<TextBox>(form,"PackageFolder").Visible,"location page exposes advanced fields");Click(form,"Back");Assert(Field<Panel>(form,"WelcomePanel").Visible,"Back did not return to welcome");form.Close();}});
   Case("changing installed folder clears stale maintenance state",()=>{string root=Path.Combine(fixture,"existing");try{InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false}),CancellationToken.None,s=>{});using(var form=new SetupForm(new[]{"--no-discover","--install-dir",root})){Assert(Field<Button>(form,"ManageConnection").Enabled,"installed Bridge action disabled");Field<TextBox>(form,"InstallFolder").Text=Path.Combine(fixture,"different");Assert(!Field<Button>(form,"ManageConnection").Enabled,"folder edit retained old installation controls");Invoke(form,"LoadState");Assert(Field<ComboBox>(form,"Operation").SelectedIndex==0,"new folder retained Update mode");}}finally{Uninstall(root);}});
   Case("Chrome pairing and runtime setup occupy separate sequential pages",()=>{
    string root=Path.Combine(fixture,"complete");var listener=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,0);listener.Start();string port=((System.Net.IPEndPoint)listener.LocalEndpoint).Port.ToString();listener.Stop();
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-start","--no-startup","--no-browser-launch","--install-dir",root,"--package-dir",package,"--port",port})){
     form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Click(form,"Preview");Invoke(form,"Prepare");Invoke(form,"Apply");
     Assert(InstallerEngine.State(root)!=null,"installation did not finish");Assert(Field<Panel>(form,"ConnectionPanel").Visible,"Chrome step is missing");
     Assert(!Field<Button>(form,"SaveRuntime").Visible,"runtime setup is shown on the Chrome step");
     Assert(!form.Controls.Find("Pairing",true).Any(c=>c.Visible),"pairing is shown on the Chrome step");
     Assert(Field<TextBox>(form,"ExtensionFolder").Text==Path.Combine(root,"extension"),"extension folder is missing");
     Invoke(form,"PreparePairing");Assert(Field<Panel>(form,"PairingPanel").Visible&&!Field<Panel>(form,"ConnectionPanel").Visible,"pairing is not its own step");
     Assert(Field<TextBox>(form,"PairingToken").UseSystemPasswordChar,"pairing token is not masked");Assert(!Field<Button>(form,"SaveRuntime").Visible,"runtime setup is shown on the pairing step");
     Click(form,"Back");Assert(Field<Panel>(form,"ConnectionPanel").Visible,"Back did not return to Chrome step");Invoke(form,"PreparePairing");
     Click(form,"Preview");Assert(Field<Panel>(form,"RuntimePanel").Visible&&Field<Button>(form,"SaveRuntime").Visible&&!Field<Panel>(form,"PairingPanel").Visible,"runtime setup is not its own step");
     Click(form,"Preview");Assert(Field<Panel>(form,"DonePanel").Visible&&!Field<Button>(form,"SaveRuntime").Visible&&Field<Button>(form,"Cancel").Text=="마침","completion still contains setup actions");form.Close();
    }}finally{Uninstall(root);}
   });
   Case("uninstall preview names each registered settings file",()=>{
    string root=Path.Combine(fixture,"preview-uninstall"),settings=Path.Combine(fixture,"preview-settings.json");File.WriteAllText(settings,"{}");
    var options=new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false};options.Registrations.Add(new McpRecord{Kind="windows",Path=settings});
    try{InstallerEngine.Apply(InstallerEngine.Prepare(options),CancellationToken.None,m=>{});using(var form=new SetupForm(new[]{"--no-discover","--install-dir",root})){Field<ComboBox>(form,"Operation").SelectedIndex=2;Invoke(form,"Prepare");Assert(Field<TextBox>(form,"ChangePreview").Text.Contains(settings),"uninstall preview omitted the registered settings target");}}
    finally{Uninstall(root);File.Delete(settings);}
   });
   Case("connection guide rejects modified extension files",()=>{
    string root=Path.Combine(fixture,"changed-extension");byte[] bytes=null;string file=null;
    try{InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false,Port=Int32.Parse(FreePort())}),CancellationToken.None,m=>{});file=Path.Combine(root,"extension","manifest.json");bytes=File.ReadAllBytes(file);File.AppendAllText(file," ");
     using(var form=new SetupForm(new[]{"--no-discover","--install-dir",root})){Invoke(form,"OpenSetup");Assert(Field<TextBox>(form,"ExtensionFolder").Text.Length==0,"modified extension was exposed for Chrome loading");Assert(Field<TextBox>(form,"Status").Text.Contains("modified"),"ownership failure was not shown");}
    }finally{if(bytes!=null)File.WriteAllBytes(file,bytes);Uninstall(root);}
   });
   Case("confirmation includes advanced destinations and version",()=>{
    string root=Path.Combine(fixture,"advanced-preview"),startup=Path.Combine(fixture,"chosen-startup");
    using(var form=new SetupForm(new[]{"--no-discover","--no-start","--install-dir",root,"--package-dir",package,"--startup-dir",startup,"--port","49527"})){Invoke(form,"Prepare");string text=Field<TextBox>(form,"ChangePreview").Text;Assert(text.Contains("49527")&&text.Contains(Path.Combine(startup,"AgentBrowser.lnk"))&&text.Contains(InstallerEngine.Read<PackageManifest>(Path.Combine(package,"package-manifest.json")).Version),"advanced confirmation omitted version, port or Startup destination");}
   });
   Case("remove cannot enter connection-only wizard",()=>{
    string root=Path.Combine(fixture,"remove-connection");try{InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false,Port=Int32.Parse(FreePort())}),CancellationToken.None,m=>{});using(var form=new SetupForm(new[]{"--no-discover","--install-dir",root})){Field<ComboBox>(form,"Operation").SelectedIndex=2;Assert(!Field<Button>(form,"ManageConnection").Enabled,"connection-only action is available during removal");Invoke(form,"OpenSetup");Assert(Field<TextBox>(form,"ExtensionFolder").Text.Length==0,"removal entered connection-only flow");Assert(InstallerEngine.State(root)!=null,"test removed the installation");}}finally{Uninstall(root);}
   });
   Case("installation discovery retains malformed-marker diagnostics",()=>{
    string root=Path.Combine(fixture,"broken-marker"),key=@"Software\AgentBrowser\Installations\"+Guid.NewGuid().ToString("N");Directory.CreateDirectory(root);File.WriteAllText(Path.Combine(root,InstallerEngine.StateName),"not JSON");
    try{using(var registry=Microsoft.Win32.Registry.CurrentUser.CreateSubKey(key))registry.SetValue("Path",root);object result=typeof(Discovery).GetMethod("InstalledPaths").Invoke(null,null);var discovery=result as DiscoveryResult;Assert(discovery!=null&&discovery.Notices.Any(n=>n.Contains(root)),"installation-discovery notices were discarded");}
    finally{Microsoft.Win32.Registry.CurrentUser.DeleteSubKey(key,false);Directory.Delete(root,true);}
   });
   Case("slow installation discovery does not block the welcome window",()=>{
    var constructor=typeof(SetupForm).GetConstructor(new[]{typeof(string[]),typeof(Func<DiscoveryResult>)});Assert(constructor!=null,"installer discovery cannot be isolated from the UI constructor");
    using(var entered=new ManualResetEventSlim())using(var release=new ManualResetEventSlim()){
     var result=new DiscoveryResult();result.Notices.Add("Synthetic unreadable installation notice");Func<DiscoveryResult> scan=()=>{entered.Set();release.Wait(5000);return result;};
     var timer=System.Diagnostics.Stopwatch.StartNew();using(var form=(SetupForm)constructor.Invoke(new object[]{new[]{"--install-dir",Path.Combine(fixture,"slow-discovery")},scan})){
      Assert(!entered.IsSet,"constructor started filesystem discovery");form.Show();Assert(timer.ElapsedMilliseconds<1500,"welcome window was delayed by discovery");
      var timeout=DateTime.UtcNow.AddSeconds(5);while(!entered.IsSet&&DateTime.UtcNow<timeout){Application.DoEvents();Thread.Sleep(10);}Assert(entered.IsSet,"Shown did not start discovery");Assert(Field<Button>(form,"Preview").Enabled,"slow discovery blocked navigation");release.Set();
      timeout=DateTime.UtcNow.AddSeconds(5);while(!Field<TextBox>(form,"Status").Text.Contains("Synthetic")&&DateTime.UtcNow<timeout){Application.DoEvents();Thread.Sleep(10);}Assert(Field<TextBox>(form,"Status").Text.Contains("Synthetic"),"welcome discovery notices were not shown");form.Close();
     }
    }
   });
   Case("post-install verification failure remains visible and recoverable",()=>{
    string root=Path.Combine(fixture,"post-install-change"),file=Path.Combine(root,"extension","manifest.json");byte[] original=null;
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-start","--no-startup","--install-dir",root,"--package-dir",package})){
     form.Show();Invoke(form,"Prepare");SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
     var task=(Task)typeof(SetupForm).GetMethod("Apply",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,null);
     // Progress reports and the step after the installation reach the window through separate queues.
     // A message queued on the context before the first report makes that step run ahead of the reports
     // still waiting, so every report arrives late: none of them may replace the result.
     SynchronizationContext.Current.Post(delegate{},null);
     var timeout=DateTime.UtcNow.AddSeconds(20);while(!File.Exists(Path.Combine(root,InstallerEngine.StateName))&&DateTime.UtcNow<timeout)Thread.Sleep(10);
     Assert(File.Exists(Path.Combine(root,InstallerEngine.StateName)),"installation did not commit");original=File.ReadAllBytes(file);File.AppendAllText(file," ");
     // Registering the installation is the engine's last action; give its completion a moment to be queued.
     string record=@"Software\AgentBrowser\Installations\"+InstallerEngine.State(root).InstallId;
     timeout=DateTime.UtcNow.AddSeconds(10);while(DateTime.UtcNow<timeout){using(var key=Microsoft.Win32.Registry.CurrentUser.OpenSubKey(record))if(key!=null)break;Thread.Sleep(10);}
     Thread.Sleep(200);
     timeout=DateTime.UtcNow.AddSeconds(20);while(!task.IsCompleted&&DateTime.UtcNow<timeout){Application.DoEvents();Thread.Sleep(10);}Assert(task.IsCompleted,"post-install UI did not finish");task.GetAwaiter().GetResult();
     Assert(Field<TextBox>(form,"Status").Text.Contains("modified"),"post-install ownership failure was overwritten by success: "+Field<TextBox>(form,"Status").Text+" | page title: "+Field<Label>(form,"PageTitle").Text);
     Assert(!Field<ProgressBar>(form,"InstallProgress").Visible&&Field<Panel>(form,"WelcomePanel").Visible&&Field<Button>(form,"ManageConnection").Enabled,"verification failure left an unrecoverable progress page");form.Close();
    }}finally{if(original!=null)File.WriteAllBytes(file,original);Uninstall(root);}
   });
   Case("same-version upgrade fixture rejects before installing",()=>{
    string root=Path.Combine(fixture,"windows-setup-ui","same-"+Guid.NewGuid().ToString("N")),zip=root+".zip";Directory.CreateDirectory(Path.GetDirectoryName(root));
    try{System.IO.Compression.ZipFile.CreateFromDirectory(package,zip);string error="";try{typeof(UpgradeFixture).GetMethod("Main",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{new[]{package,zip,root,Path.Combine(root,"settings.json")}});}catch(TargetInvocationException failure){error=failure.GetBaseException().Message;}
     Assert(error.Contains("different previous and candidate versions"),"same-version fixture was not rejected");Assert(!File.Exists(Path.Combine(root,"GUI 설치 & space",InstallerEngine.StateName)),"same-version fixture installed before rejecting");
    }finally{Uninstall(Path.Combine(root,"GUI 설치 & space"));if(File.Exists(zip))File.Delete(zip);if(Directory.Exists(root))Directory.Delete(root,true);}
   });
   foreach(string relative in new[]{"extension/manifest.json","extension/background.js"})Case("missing extension file requires repair: "+relative,()=>{
    string root=Path.Combine(fixture,"missing-extension-"+Path.GetFileNameWithoutExtension(relative));var options=new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false,Port=Int32.Parse(FreePort())};
    try{InstallerEngine.Apply(InstallerEngine.Prepare(options),CancellationToken.None,m=>{});string file=NativeIO.SafePath(root,relative);Assert(File.Exists(file),"fixture extension file is absent");File.Delete(file);
     using(var form=new SetupForm(new[]{"--no-discover","--install-dir",root})){Invoke(form,"OpenSetup");Assert(Field<TextBox>(form,"ExtensionFolder").Text.Length==0&&Field<TextBox>(form,"Status").Text.Contains("업데이트"),"missing extension was offered for Chrome loading");
      options.Operation="update";InstallerEngine.Apply(InstallerEngine.Prepare(options),CancellationToken.None,m=>{});Invoke(form,"OpenSetup");Assert(File.Exists(file)&&Field<TextBox>(form,"ExtensionFolder").Text==Path.Combine(root,"extension"),"update did not repair the extension guide");
     }
    }finally{Uninstall(root);}
   });
   Case("managed upgrade rejects a same-version package pair",()=>{
    string root=Path.Combine(fixture,"managed-same-"+Guid.NewGuid().ToString("N"));
    int result;var diagnostic=new StringWriter();var previousError=Console.Error;
    try{Console.SetError(diagnostic);result=ManagedRuntimeUpgradeTests.Main(new[]{package,package,root,"/unused-same-version-fixture"});}finally{Console.SetError(previousError);}
    Assert(result!=0&&!Directory.Exists(root)&&diagnostic.ToString().Contains("different previous and candidate versions"),"same-version managed upgrade did not stop before installation");
   });
   Case("managed directory permissions do not block the selected installation",()=>{string root=Path.Combine(fixture,"managed");Directory.CreateDirectory(root);var acl=Directory.GetAccessControl(root);acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"),FileSystemRights.Modify,AccessControlType.Allow));Directory.SetAccessControl(root,acl);string before=Directory.GetAccessControl(root).GetSecurityDescriptorSddlForm(AccessControlSections.Access);InstallerEngine.Root(root);Assert(before==Directory.GetAccessControl(root).GetSecurityDescriptorSddlForm(AccessControlSections.Access),"path check changed the directory ACL");});
   if(args.Length>2)Case("local data drive supports a new private installation",()=>{string root=Path.Combine(args[2],"AgentBrowser-Test-"+Guid.NewGuid().ToString("N").Substring(0,8));try{InstallerEngine.Root(root);InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false}),CancellationToken.None,s=>{});Assert(InstallerEngine.State(root)!=null,"data drive install failed");Assert(Directory.Exists(Path.Combine(root,"extension")),"extension was not installed");}finally{Uninstall(root);if(Directory.Exists(root))Directory.Delete(root,true);}});
   Console.WriteLine("TOTAL "+passed+" PASS / "+failed+" FAIL");return failed==0?0:1;
  }
 }
}
