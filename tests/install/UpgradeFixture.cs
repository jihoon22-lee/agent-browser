using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Threading;
using System.Net;
using System.Net.Sockets;
namespace AgentBrowser.Installer {
 class UpgradeFixture {
  static int Main(string[] args) {
   string stock=args[0],zip=args[1],root=args[2],settings=args[3];
   if(!root.Contains(@"\windows-setup-ui\"))throw new Exception("Expected an isolated test root");
   Directory.CreateDirectory(root);string next=Path.Combine(root,"extracted"),old=Path.Combine(root,"old-published-package");ZipFile.ExtractToDirectory(zip,next);Directory.CreateDirectory(old);
   var manifest=InstallerEngine.Read<PackageManifest>(Path.Combine(stock,"package-manifest.json"));
   string previousVersion=manifest.Version;
   if(previousVersion==InstallerEngine.Read<PackageManifest>(Path.Combine(next,"package-manifest.json")).Version)throw new Exception("Upgrade fixture requires different previous and candidate versions.");
   foreach(var file in manifest.Files){string target=NativeIO.SafePath(old,file.Path);Directory.CreateDirectory(Path.GetDirectoryName(target));File.Copy(NativeIO.SafePath(stock,file.Path),target);}
   if(!manifest.Files.Any(f=>f.Path=="AgentBrowser-Setup.exe")){
    string gui=Path.Combine(old,"AgentBrowser-Setup.exe");File.Copy(Path.Combine(next,"AgentBrowser-Setup.exe"),gui);
    manifest.Files=manifest.Files.Concat(new []{new OwnedFile{Path="AgentBrowser-Setup.exe",Sha256=NativeIO.FileHash(gui)}}).ToArray();
   }
   NativeIO.WriteText(Path.Combine(old,"package-manifest.json"),NativeIO.Json.Serialize(manifest));
   var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();int port=((IPEndPoint)listener.LocalEndpoint).Port;listener.Stop();
   var options=new SetupOptions{PackageDir=old,InstallDir=Path.Combine(root,"GUI 설치 & space"),Port=port,Start=true,Startup=false};
   options.Registrations.Add(new McpRecord{Path=settings,Kind="wsl",Distribution="Ubuntu"});
   InstallerEngine.Apply(InstallerEngine.Prepare(options),CancellationToken.None,s=>{});
   var state=InstallerEngine.State(options.InstallDir);
   if(NativeIO.RunChecked(state.CurrentExe,new []{"--version"})!="browser-bridge "+previousVersion)throw new Exception("Old actual binary version mismatch");
   if(previousVersion=="0.1.4"){File.Delete(state.SetupExe);state.OwnedFiles=state.OwnedFiles.Where(f=>!f.Path.EndsWith("/AgentBrowser-Setup.exe",StringComparison.OrdinalIgnoreCase)).ToArray();state.SetupExe=null;state.Mcps=null;}
   NativeIO.WriteText(Path.Combine(state.InstallDir,InstallerEngine.StateName),NativeIO.Json.Serialize(state));
   NativeIO.WriteText(Path.Combine(state.DataDir,"gui-preserve.json"),"{\"synthetic\":true}");
   File.WriteAllText(Path.Combine(root,"old-identity.txt"),state.InstallId);
   File.WriteAllText(Path.Combine(root,"old-config-sha.txt"),NativeIO.FileHash(Path.Combine(state.DataDir,"config.json")));
   Console.WriteLine("PASS prepared isolated "+previousVersion+" installation from published binaries; port="+port);return 0;
  }
 }
}

