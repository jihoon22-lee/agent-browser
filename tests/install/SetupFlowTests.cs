using System;
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
  static void Uninstall(string root){if(InstallerEngine.State(root)!=null)InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{Operation="uninstall",InstallDir=root}),CancellationToken.None,s=>{});}
  [STAThread] public static int Main(string[] args){
   string fixture=args[0],package=args[1];InstallerEngine.PrivateDirectory(fixture);
   Case("new folder guides installation before maintenance",()=>{using(var form=new SetupForm(new[]{"--no-discover","--install-dir",Path.Combine(fixture,"new")})){form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Application.DoEvents();Assert(!form.Controls.Find("StartInstalledBridge",true).Any(c=>c.Visible),"Bridge start is exposed before installation");Assert(!form.Controls.Find("Pairing",true).Any(c=>c.Visible),"pairing is exposed before installation");Assert(!Field<Button>(form,"ManagedProfiles").Enabled,"profiles are enabled before installation");Assert(Field<Button>(form,"Preview").Text.Contains("다음"),"primary action has no next-step label");Assert(!Field<TextBox>(form,"PackageFolder").Visible,"advanced package path is exposed by default");Assert(Field<Panel>(form,"WelcomePanel").Visible,"welcome page is missing");Field<Button>(form,"Preview").PerformClick();Assert(Field<Panel>(form,"SettingsPanel").Visible,"Next did not open location page");Assert(!Field<TextBox>(form,"PackageFolder").Visible,"location page exposes advanced fields");Field<Button>(form,"Back").PerformClick();Assert(Field<Panel>(form,"WelcomePanel").Visible,"Back did not return to welcome");form.Close();}});
   Case("changing installed folder clears stale maintenance state",()=>{string root=Path.Combine(fixture,"existing");try{InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false}),CancellationToken.None,s=>{});using(var form=new SetupForm(new[]{"--no-discover","--install-dir",root})){Assert(Field<Button>(form,"ManageConnection").Enabled,"installed Bridge action disabled");Field<TextBox>(form,"InstallFolder").Text=Path.Combine(fixture,"different");Assert(!Field<Button>(form,"ManageConnection").Enabled,"folder edit retained old installation controls");Invoke(form,"LoadState");Assert(Field<ComboBox>(form,"Operation").SelectedIndex==0,"new folder retained Update mode");}}finally{Uninstall(root);}});
   Case("Chrome pairing and runtime setup occupy separate sequential pages",()=>{
    string root=Path.Combine(fixture,"complete");var listener=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,0);listener.Start();string port=((System.Net.IPEndPoint)listener.LocalEndpoint).Port.ToString();listener.Stop();
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-start","--no-startup","--install-dir",root,"--package-dir",package,"--port",port})){
     form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Field<Button>(form,"Preview").PerformClick();Invoke(form,"Prepare");Invoke(form,"Apply");
     Assert(InstallerEngine.State(root)!=null,"installation did not finish");Assert(Field<Panel>(form,"ConnectionPanel").Visible,"Chrome step is missing");
     Assert(!Field<Button>(form,"ManagedProfiles").Visible,"runtime setup is shown on the Chrome step");
     Assert(!form.Controls.Find("Pairing",true).Any(c=>c.Visible),"pairing is shown on the Chrome step");
     Assert(Field<TextBox>(form,"ExtensionFolder").Text==Path.Combine(root,"extension"),"extension folder is missing");
     Invoke(form,"PreparePairing");Assert(Field<Panel>(form,"PairingPanel").Visible&&!Field<Panel>(form,"ConnectionPanel").Visible,"pairing is not its own step");
     Assert(Field<TextBox>(form,"PairingToken").UseSystemPasswordChar,"pairing token is not masked");Assert(!Field<Button>(form,"ManagedProfiles").Visible,"runtime setup is shown on the pairing step");
     Field<Button>(form,"Back").PerformClick();Assert(Field<Panel>(form,"ConnectionPanel").Visible,"Back did not return to Chrome step");Invoke(form,"PreparePairing");
     Field<Button>(form,"Preview").PerformClick();Assert(Field<Panel>(form,"RuntimePanel").Visible&&Field<Button>(form,"ManagedProfiles").Visible&&!Field<Panel>(form,"PairingPanel").Visible,"runtime setup is not its own step");
     Field<Button>(form,"Preview").PerformClick();Assert(Field<Panel>(form,"DonePanel").Visible&&!Field<Button>(form,"ManagedProfiles").Visible&&Field<Button>(form,"Cancel").Text=="마침","completion still contains setup actions");form.Close();
    }}finally{Uninstall(root);}
   });
   Case("uninstall preview names each registered settings file",()=>{
    string root=Path.Combine(fixture,"preview-uninstall"),settings=Path.Combine(fixture,"preview-settings.json");File.WriteAllText(settings,"{}");
    var options=new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false};options.Registrations.Add(new McpRecord{Kind="windows",Path=settings});
    try{InstallerEngine.Apply(InstallerEngine.Prepare(options),CancellationToken.None,m=>{});using(var form=new SetupForm(new[]{"--no-discover","--install-dir",root})){Field<ComboBox>(form,"Operation").SelectedIndex=2;Invoke(form,"Prepare");Assert(Field<TextBox>(form,"ChangePreview").Text.Contains(settings),"uninstall preview omitted the registered settings target");}}
    finally{Uninstall(root);File.Delete(settings);}
   });
   Case("permission rejection identifies the affected directory and recovery",()=>{string root=Path.Combine(fixture,"shared");InstallerEngine.PrivateDirectory(root);var acl=Directory.GetAccessControl(root);byte[] saved=acl.GetSecurityDescriptorBinaryForm();acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"),FileSystemRights.Modify,AccessControlType.Allow));Directory.SetAccessControl(root,acl);try{string message="";try{InstallerEngine.Root(root);}catch(IOException error){message=error.Message;}Assert(message.Contains(root)&&message.Contains("기본 위치로 되돌리기"),"permission error omits path or recovery");}finally{var restore=new DirectorySecurity();restore.SetSecurityDescriptorBinaryForm(saved,AccessControlSections.Access);Directory.SetAccessControl(root,restore);}});
   Case("volume root exception retains replacement and owner protection",()=>{
    var acl=new DirectorySecurity();acl.SetOwner(WindowsIdentity.GetCurrent().User);var everyone=new SecurityIdentifier("S-1-1-0");
    acl.AddAccessRule(new FileSystemAccessRule(everyone,FileSystemRights.Delete,AccessControlType.Allow));
    InstallerEngine.RequireDirectorySecurity(acl,false,true);
    bool rejected=false;try{InstallerEngine.RequireDirectorySecurity(acl,false);}catch(IOException){rejected=true;}Assert(rejected,"ordinary ancestor DELETE was accepted");
    acl.AddAccessRule(new FileSystemAccessRule(everyone,FileSystemRights.DeleteSubdirectoriesAndFiles,AccessControlType.Allow));
    rejected=false;try{InstallerEngine.RequireDirectorySecurity(acl,false,true);}catch(IOException){rejected=true;}Assert(rejected,"volume child-delete was accepted");
    acl=new DirectorySecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-21-1-2-3-1001"));
    rejected=false;try{InstallerEngine.RequireDirectorySecurity(acl,false,true);}catch(IOException){rejected=true;}Assert(rejected,"foreign volume owner was accepted");
   });
   if(args.Length>2)Case("local data drive supports a new private installation",()=>{string root=Path.Combine(args[2],"AgentBrowser-Test-"+Guid.NewGuid().ToString("N").Substring(0,8));try{InstallerEngine.Root(root);InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{PackageDir=package,InstallDir=root,Start=false,Startup=false}),CancellationToken.None,s=>{});Assert(InstallerEngine.State(root)!=null,"data drive install failed");InstallerEngine.RequireDirectorySecurity(Directory.GetAccessControl(root),true);}finally{Uninstall(root);if(Directory.Exists(root))Directory.Delete(root,true);}});
   Console.WriteLine("TOTAL "+passed+" PASS / "+failed+" FAIL");return failed==0?0:1;
  }
 }
}
