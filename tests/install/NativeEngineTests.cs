using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Threading;
using System.IO.Compression;

namespace AgentBrowser.Installer {
    internal static class NativeEngineTests {
        static void Assert(bool ok,string reason){if(!ok)throw new Exception(reason);}
        static void Throws(Action action,string reason){bool failed=false;try{action();}catch{failed=true;}Assert(failed,reason);}
        static int count;
        static void Case(string name,Action action){action();count++;Console.WriteLine("PASS "+name);}
        static void CopyPackage(string source,string destination,string gui,string version){
            Directory.CreateDirectory(destination);var manifest=InstallerEngine.Read<PackageManifest>(Path.Combine(source,"package-manifest.json"));
            var files=manifest.Files.Where(f=>f.Path!="AgentBrowser-Setup.exe").ToList();files.Add(new OwnedFile{Path="AgentBrowser-Setup.exe",Sha256=NativeIO.FileHash(gui)});
            foreach(var f in files){string from=f.Path=="AgentBrowser-Setup.exe"?gui:NativeIO.SafePath(source,f.Path),target=NativeIO.SafePath(destination,f.Path);Directory.CreateDirectory(Path.GetDirectoryName(target));File.Copy(from,target);}
            manifest.Files=files.ToArray();manifest.Version=version;NativeIO.WriteText(Path.Combine(destination,"package-manifest.json"),NativeIO.Json.Serialize(manifest));
        }
        [STAThread] public static int Main(string[] args){
            if(args.Length==2&&args[0]=="--cleanup") {if(!args[1].Contains("\\windows-setup-ui\\isolated-native-"))throw new Exception("Not an owned test path");if(InstallerEngine.State(args[1])!=null)InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{Operation="uninstall",InstallDir=args[1]}),CancellationToken.None,s=>{});return 0;}
            string root=args[2];Directory.CreateDirectory(root);string package1=Path.Combine(root,"package-1"),package2=Path.Combine(root,"package-2"),install=Path.Combine(root,"설치 & space"),startup=Path.Combine(root,"Synthetic Startup"),settings=Path.Combine(root,"설정.jsonc");
            try {
                CopyPackage(args[0],package1,args[1],"0.1.4-gui-test1");CopyPackage(args[0],package2,args[1],"0.1.4-gui-test2");
                ZipFile.CreateFromDirectory(package1,Path.Combine(root,"agent-browser-gui-test1-windows-x64.zip"));
                var entry=new Dictionary<string,object>{{"type","local"},{"command",new []{"synthetic.exe","mcp"}}};
                string original="{ // preserve 한글\r\n\"model\":\"test/model\",\"mcp\":{\"other\":{\"type\":\"local\",\"command\":[\"other.exe\"]},},}";
                Case("JSONC owned update/removal and unowned collision",()=>{
                    var a=Jsonc.Edit(original,entry);Assert(a.Text.Contains("// preserve 한글")&&a.Text.Contains("\"other\""),"unrelated text changed");Throws(()=>Jsonc.Edit(a.Text,entry),"unowned browser replaced");
                    var b=Jsonc.Edit(a.Text,null,a.EntryHash,true);Assert(b.Text.Contains("\"other\"")&&b.Text.Contains("\"model\":\"test/model\""),"uninstall damaged settings");
                    Throws(()=>Jsonc.Edit("{\"mcp\":{},\"mcp\":{}}",entry),"duplicate MCP accepted");
                });
                NativeIO.WriteText(settings,original);
                var options=new SetupOptions{PackageDir=package1,InstallDir=install,StartupDir=startup,Start=false,Startup=true,Port=49431};
                options.Registrations.Add(new McpRecord{Path=settings,Kind="windows"});
                Case("preview and pre-cancel do not install",()=>{var plan=InstallerEngine.Prepare(options);Assert(!Directory.Exists(install),"preview changed destination");var cancel=new CancellationTokenSource();cancel.Cancel();Throws(()=>InstallerEngine.Apply(plan,cancel.Token,s=>{}),"pre-cancel ignored");Assert(!File.Exists(Path.Combine(install,InstallerEngine.StateName)),"cancel installed app");Assert(File.ReadAllText(settings)==original,"cancel changed settings");});
                Case("native install with preserved JSONC and Startup",()=>{InstallerEngine.Apply(InstallerEngine.Prepare(options),CancellationToken.None,s=>{});var state=InstallerEngine.State(install);Assert(state.Version=="0.1.4-gui-test1","version missing");Assert(File.Exists(Path.Combine(startup,"AgentBrowser.lnk")),"shortcut missing");Assert(File.ReadAllText(settings).Contains("// preserve 한글"),"comment lost");});
                var before=InstallerEngine.State(install);NativeIO.WriteText(Path.Combine(before.DataDir,"preserved-test.json"),"{\"synthetic\":true}");
                string userEdit=File.ReadAllText(settings).Replace("test/model","test/user-changed");NativeIO.WriteText(settings,userEdit);
                options.Operation="update";options.PackageDir=package2;options.Registrations.Clear();
                Case("preview concurrency conflict preserves all existing files",()=>{var plan=InstallerEngine.Prepare(options);NativeIO.WriteText(settings,userEdit+"\r\n");Throws(()=>InstallerEngine.Apply(plan,CancellationToken.None,s=>{}),"concurrent edit ignored");Assert(InstallerEngine.State(install).Version==before.Version,"failed update changed version");});
                Case("native update preserves identity/data/user model/other MCP",()=>{InstallerEngine.Apply(InstallerEngine.Prepare(options),CancellationToken.None,s=>{});var state=InstallerEngine.State(install);Assert(state.Version=="0.1.4-gui-test2"&&state.InstallId==before.InstallId,"identity/version mismatch");Assert(File.Exists(Path.Combine(state.DataDir,"preserved-test.json")),"data lost");Assert(File.ReadAllText(settings).Contains("test/user-changed")&&File.ReadAllText(settings).Contains("\"other\""),"settings lost");});
                Case("modified installed file blocks uninstall",()=>{string path=Path.Combine(install,"LICENSE"),bytes=File.ReadAllText(path);File.AppendAllText(path,"modified");Throws(()=>InstallerEngine.Prepare(new SetupOptions{Operation="uninstall",InstallDir=install}),"modified file removed");File.WriteAllText(path,bytes,NativeIO.Utf8);});
                Case("native uninstall only removes owned files and MCP",()=>{InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{Operation="uninstall",InstallDir=install}),CancellationToken.None,s=>{});Assert(!File.Exists(Path.Combine(install,InstallerEngine.StateName)),"marker left");Assert(File.Exists(Path.Combine(install,"data","preserved-test.json")),"data removed");string result=File.ReadAllText(settings);Assert(result.Contains("test/user-changed")&&result.Contains("\"other\"")&&!result.Contains("\"browser\""),"bad settings removal");Assert(!File.Exists(Path.Combine(startup,"AgentBrowser.lnk")),"Startup not removed");});
                Case("mid-transaction cancellation rolls back",()=>{options.Operation="install";options.PackageDir=package1;options.InstallDir=Path.Combine(root,"cancelled-install");options.Registrations.Clear();var cancel=new CancellationTokenSource();int updates=0;Throws(()=>InstallerEngine.Apply(InstallerEngine.Prepare(options),cancel.Token,s=>{if(++updates==3)cancel.Cancel();}),"mid-install cancellation ignored");Assert(!File.Exists(Path.Combine(options.InstallDir,InstallerEngine.StateName)),"cancel committed");Assert(!File.Exists(Path.Combine(options.InstallDir,"LICENSE")),"cancel did not undo files");});
                Case("failed startup stops its child and leaves data retryable",()=>{
                    string retryRoot=Path.Combine(root,"startup-retry");var tcp=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,0);tcp.Start();int freePort=((System.Net.IPEndPoint)tcp.LocalEndpoint).Port;tcp.Stop();
                    var retry=new SetupOptions{PackageDir=package1,InstallDir=retryRoot,Startup=false,Start=true,Port=freePort};string marker=Path.Combine(retryRoot,"data",".installer-bridge-process.json");
                    Throws(()=>InstallerEngine.Apply(InstallerEngine.Prepare(retry),CancellationToken.None,s=>{if(s.StartsWith("Bridge "))Directory.CreateDirectory(marker);}),"marker failure was ignored");
                    Assert(!File.Exists(Path.Combine(retryRoot,InstallerEngine.StateName)),"failed install committed");int failedPid=Int32.Parse(File.ReadAllText(Path.Combine(retryRoot,"data","serve.pid")));bool live=false;try{using(var child=System.Diagnostics.Process.GetProcessById(failedPid))live=!child.HasExited;}catch(ArgumentException){}Assert(!live,"startup failure left a live Bridge");
                    Directory.Delete(marker);InstallerEngine.Apply(InstallerEngine.Prepare(retry),CancellationToken.None,s=>{});InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{Operation="uninstall",InstallDir=retryRoot}),CancellationToken.None,s=>{});
                });
                if(args.Length>=5) {
                    string wslConfig=args[3],beforeText=File.ReadAllText(wslConfig),wslInstall=Path.Combine(root,"WSL native installation"),linuxRoot=Path.GetDirectoryName(NativeIO.MapWsl(wslConfig).Path).Replace('\\','/');
                    var tcp=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,0);tcp.Start();int freePort=((System.Net.IPEndPoint)tcp.LocalEndpoint).Port;tcp.Stop();
                    var wslOptions=new SetupOptions{PackageDir=package1,InstallDir=wslInstall,Startup=false,Start=true,Port=freePort};wslOptions.Registrations.Add(new McpRecord{Path=wslConfig,Kind="wsl",Distribution="Ubuntu"});
                    var statArgs=new [] {"-d","Ubuntu","--exec","stat","-c","%u:%g:%a",NativeIO.MapWsl(wslConfig).Path};string permissions=NativeIO.RunChecked(NativeIO.WslExe,statArgs);
                    string windowsBefore=NativeIO.Json.Serialize(NativeIO.Json.DeserializeObject(Jsonc.Minify(File.ReadAllText(settings))));
                    try {
                        Case("actual WSL existing JSONC without mcp adds browser and preserves fields/mode",()=>{Assert(!beforeText.Contains("\"mcp\""),"fixture already has MCP");InstallerEngine.Apply(InstallerEngine.Prepare(wslOptions),CancellationToken.None,s=>{});string text=File.ReadAllText(wslConfig);Assert(text.Contains("\"browser\"")&&text.Contains("\"provider\"")&&text.Contains("\"server\"")&&text.Contains("// preserve"),"unrelated WSL fields lost");Assert(NativeIO.RunChecked(NativeIO.WslExe,statArgs)==permissions,"WSL owner/group/mode changed");});
                        Case("actual OpenCode CLI plus WSL Bridge authenticated round trip",()=>{string result=NativeIO.RunChecked(@"C:\Program Files\nodejs\node.exe",new [] {args[4],wslInstall,wslConfig,linuxRoot},timeout:60000);Console.WriteLine(result);});
                        Case("one installation owns simultaneous Windows and WSL MCP registrations",()=>{wslOptions.Registrations.Add(new McpRecord{Path=settings,Kind="windows"});InstallerEngine.Apply(InstallerEngine.Prepare(wslOptions),CancellationToken.None,s=>{});var both=InstallerEngine.State(wslInstall);Assert(both.Mcps.Length==2&&both.Mcp==null,"multi-registration state lost a target");Assert(File.ReadAllText(settings).Contains("\"browser\"")&&File.ReadAllText(wslConfig).Contains("\"browser\""),"one registration was lost");});
                        Case("actual WSL repeat registration is byte-stable and singular",()=>{string hash=NativeIO.FileHash(wslConfig);InstallerEngine.Apply(InstallerEngine.Prepare(wslOptions),CancellationToken.None,s=>{});Assert(NativeIO.FileHash(wslConfig)==hash,"repeat changed WSL config");});
                        Case("actual WSL uninstall restores no-mcp state and preserves other fields/mode",()=>{var beforeRemoval=NativeIO.Json.Deserialize<Dictionary<string,object>>(Jsonc.Minify(File.ReadAllText(wslConfig)));beforeRemoval.Remove("mcp");InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions{Operation="uninstall",InstallDir=wslInstall}),CancellationToken.None,s=>{});string text=File.ReadAllText(wslConfig);var afterRemoval=NativeIO.Json.Deserialize<Dictionary<string,object>>(Jsonc.Minify(text));Assert(!afterRemoval.ContainsKey("mcp")&&NativeIO.Json.Serialize(afterRemoval)==NativeIO.Json.Serialize(beforeRemoval)&&text.Contains("// preserve"),"no-mcp state or intervening OpenCode edits were not preserved");Assert(NativeIO.RunChecked(NativeIO.WslExe,statArgs)==permissions,"uninstall changed WSL permissions");});
                        Assert(NativeIO.Json.Serialize(NativeIO.Json.DeserializeObject(Jsonc.Minify(File.ReadAllText(settings))))==windowsBefore,"multi-target uninstall changed unrelated Windows settings");
                    } finally {var installed=InstallerEngine.State(wslInstall);if(installed!=null) {BridgeControl.StopRuntimes(installed);BridgeControl.Stop(installed);}}
                }
                Console.WriteLine("TOTAL "+count+" PASS");Console.WriteLine("ARTIFACTS "+root);return 0;
            } catch(Exception error){Console.Error.WriteLine(error);return 1;}
        }
    }
}

