using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Net;
using System.Text;
using System.Threading;

namespace AgentBrowser.Installer {
 internal static class ManagedRuntimeUpgradeTests {
  static void Assert(bool value,string message){if(!value)throw new Exception(message);}
  static Dictionary<string,object> Record(InstallState state) {
   var config=InstallerEngine.Read<Dictionary<string,object>>(Path.Combine(state.DataDir,"runtime.json"));
   return (Dictionary<string,object>)((Dictionary<string,object>)config["runtimes"])["upgrade-fixture"];
  }
  static object Api(Dictionary<string,object> record,string path,string body=null) {
   var request=(HttpWebRequest)WebRequest.Create((string)record["baseUrl"]+path);
   request.Proxy=null;request.Timeout=15000;request.ReadWriteTimeout=15000;
   request.Headers["Authorization"]="Basic "+Convert.ToBase64String(Encoding.UTF8.GetBytes((string)record["username"]+":"+(string)record["password"]));
   if(body!=null){request.Method="POST";request.ContentType="application/json";byte[] bytes=Encoding.UTF8.GetBytes(body);request.ContentLength=bytes.Length;using(var stream=request.GetRequestStream())stream.Write(bytes,0,bytes.Length);}
   using(var response=request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream()))return NativeIO.Json.DeserializeObject(reader.ReadToEnd());
  }
  [STAThread] public static int Main(string[] args) {
   if(args.Length!=4){Console.Error.WriteLine("old-package new-package new-private-fixture-root existing-isolated-linux-directory");return 2;}
   string install=Path.GetFullPath(args[2]);if(Directory.Exists(install)){Console.Error.WriteLine("Use a fresh fixture directory");return 2;}
   var listener=new System.Net.Sockets.TcpListener(IPAddress.Loopback,0);listener.Start();int port=((IPEndPoint)listener.LocalEndpoint).Port;listener.Stop();
   var options=new SetupOptions{PackageDir=Path.GetFullPath(args[0]),InstallDir=install,Startup=false,Start=true,Port=port};
   try {
    string previousVersion=InstallerEngine.Read<PackageManifest>(Path.Combine(options.PackageDir,"package-manifest.json")).Version;
    string candidateVersion=InstallerEngine.Read<PackageManifest>(Path.Combine(Path.GetFullPath(args[1]),"package-manifest.json")).Version;
    if(previousVersion==candidateVersion)throw new Exception("Managed upgrade requires different previous and candidate versions.");
    InstallerEngine.Apply(InstallerEngine.Prepare(options),CancellationToken.None,s=>{});
    var before=InstallerEngine.State(install);BridgeControl.Invoke(before,new[]{"pair"});
    // Synthetic pairing only in this new private fixture; no Chrome/profile access.
    BridgeControl.Stop(before);
    string pairingPath=Path.Combine(before.DataDir,"config.json");var pairing=InstallerEngine.Read<Dictionary<string,object>>(pairingPath);
    pairing["pairedExtensionId"]="abcdefghijklmnopabcdefghijklmnop";NativeIO.WriteText(pairingPath,NativeIO.Json.Serialize(pairing));BridgeControl.Start(before);
    var env=new Dictionary<string,string>{{"XDG_CONFIG_HOME",args[3]+"/config"},{"XDG_DATA_HOME",args[3]+"/data"},{"XDG_STATE_HOME",args[3]+"/state"},{"XDG_CACHE_HOME",args[3]+"/cache"},{"OPENCODE_CONFIG",args[3]+"/opencode.json"},{"OPENCODE_DISABLE_AUTOUPDATE","true"},{"OPENCODE_DISABLE_MODELS_FETCH","true"},{"OPENCODE_DISABLE_DEFAULT_PLUGINS","true"}};
    var profile=new Dictionary<string,object>{{"id","upgrade-fixture"},{"name","Isolated upgrade fixture"},{"kind","wsl"},{"distribution","Ubuntu"},{"user","jihoon"},{"directory",args[3]},{"executable","/home/jihoon/.opencode/bin/opencode"},{"env",env}};
    ManagedProfile.Save(before,profile);
    BridgeControl.Invoke(before,new[]{"runtime","start","--profile","upgrade-fixture"},60000);
    var old=Record(before);Assert((string)old["bridgeExecutable"]==before.CurrentExe,"old MCP path mismatch");
    var session=(Dictionary<string,object>)Api(old,"/session",NativeIO.Json.Serialize(new {title="AgentBrowser isolated upgrade regression"}));
    string id=(string)session["id"],configHash=NativeIO.FileHash(Path.Combine(before.DataDir,"config.json"));
    string profiles=NativeIO.Json.Serialize(InstallerEngine.Read<Dictionary<string,object>>(Path.Combine(before.DataDir,"runtime.json"))["profiles"]);
    options.Operation="update";options.PackageDir=Path.GetFullPath(args[1]);
    string result=InstallerEngine.Apply(InstallerEngine.Prepare(options),CancellationToken.None,s=>{});
    Assert(!result.Contains("경고"),"update returned a recovery warning");
    var after=InstallerEngine.State(install);var current=Record(after);
    Assert(after.Version==candidateVersion&&before.Version==previousVersion,"unexpected version pair");
    Assert(after.InstallId==before.InstallId&&NativeIO.FileHash(Path.Combine(after.DataDir,"config.json"))==configHash,"identity/pairing changed");
    Assert(NativeIO.Json.Serialize(InstallerEngine.Read<Dictionary<string,object>>(Path.Combine(after.DataDir,"runtime.json"))["profiles"])==profiles,"profiles changed");
    Assert((string)current["instance"]!=(string)old["instance"]&&(string)current["bridgeExecutable"]==after.CurrentExe,"managed runtime retained old MCP");
    var mcp=(Dictionary<string,object>)Api(current,"/mcp");Assert((string)((Dictionary<string,object>)mcp["browser"])["status"]=="connected","new browser MCP not connected");
    var restored=(Dictionary<string,object>)Api(current,"/session/"+id);Assert((string)restored["id"]==id,"session lost");
    Console.WriteLine("PASS actual Windows/WSL "+previousVersion+" -> "+candidateVersion+": new runtime and MCP path, browser MCP connected, identity/pairing/profiles/session preserved");
    return 0;
   }catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}
   finally {var state=InstallerEngine.State(install);if(state!=null)InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{Operation="uninstall",InstallDir=install}),CancellationToken.None,s=>{});}
  }
 }
}
