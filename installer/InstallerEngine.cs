using System.Runtime.InteropServices;
using System.Text;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace AgentBrowser.Installer {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal class ShellLink {}
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetHotkey(out short value);
        void SetHotkey(short value);
        void GetShowCmd(out int value);
        void SetShowCmd(int value);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }


    public sealed class OwnedFile { public string Path {get;set;} public string Sha256 {get;set;} }
    public sealed class PackageManifest { public string Product {get;set;} public string Platform {get;set;} public string Version {get;set;} public OwnedFile[] Files {get;set;} }
    public sealed class StartupRecord { public string Path {get;set;} public string Sha256 {get;set;} }
    public sealed class McpRecord {
        public string Path {get;set;} public string Kind {get;set;} public string Distribution {get;set;} public string User {get;set;}
        public string EntryHash {get;set;} public bool CreatedMcp {get;set;} public bool CreatedFile {get;set;} public string[] Backups {get;set;}
    }
    public sealed class InstallState {
        public string Product {get;set;} public int SchemaVersion {get;set;} public string InstallId {get;set;} public string InstallDir {get;set;}
        public string DataDir {get;set;} public string Version {get;set;} public string CurrentExe {get;set;} public int Port {get;set;}
        public string InstalledAt {get;set;} public string UpdatedAt {get;set;} public StartupRecord Startup {get;set;}
        public McpRecord Mcp {get;set;} public McpRecord[] Mcps {get;set;} public OwnedFile[] OwnedFiles {get;set;} public string SetupExe {get;set;}
    }
    internal sealed class SetupOptions {
        public string Operation="install",PackageDir,InstallDir,StartupDir;
        public int Port=4317;public bool Start=true,Startup=true;
        public readonly List<McpRecord> Registrations=new List<McpRecord>();
    }
    internal sealed class Change { public string Path,Expected,User;public byte[] Bytes; }
    internal sealed class InstallPlan {
        public SetupOptions Options;public InstallState Old,Next;public string StateHash,OldStartupHash,NextStartupHash;
        public readonly List<Change> Changes=new List<Change>();
        public readonly List<string> Summary=new List<string>();
        public string Preview {get{return String.Join(Environment.NewLine,Summary);}}
    }
    internal static class InstallerEngine {
        public const string Product="agent-browser.user-install.v1",StateName=".agent-browser-install.json";
        public static string HashOrMissing(string path) {return File.Exists(path)?NativeIO.FileHash(path):"missing";}
        public static bool Same(string a,string b) {return String.Equals(a,b,StringComparison.OrdinalIgnoreCase);}
        public static string Full(string path) {return Path.GetFullPath(path).TrimEnd('\\','/');}
        public static string Root(string path) {
            if(String.IsNullOrWhiteSpace(path)||!Path.IsPathRooted(path)) throw new IOException("Choose an absolute dedicated installation folder.");
            string full=Full(path);if(full==Path.GetPathRoot(full).TrimEnd('\\')) throw new IOException("A drive root cannot be an installation folder.");
            foreach(var item in new [] {Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),Environment.GetFolderPath(Environment.SpecialFolder.Windows)}) if(Same(full,Full(item))) throw new IOException("Choose a dedicated subfolder.");
            if(full.StartsWith(@"\\",StringComparison.Ordinal)) throw new IOException("Bridge installation must be on a Windows local disk. WSL settings can use a WSL path.");
            NativeIO.PlainPath(full);return full;
        }
        public static T Read<T>(string path) {NativeIO.PlainPath(path);return NativeIO.Json.Deserialize<T>(File.ReadAllText(path,NativeIO.Utf8));}
        public static InstallState State(string root) {
            string path=Path.Combine(root,StateName);if(!File.Exists(path)) return null;
            var s=Read<InstallState>(path);
            if(s==null||s.Product!=Product||!Same(Full(s.InstallDir),Full(root))||!Same(Full(s.DataDir),Full(Path.Combine(root,"data")))||!Regex.IsMatch(s.InstallId??"","^[a-fA-F0-9]{32}$")||s.OwnedFiles==null) throw new IOException("Installation ownership marker is invalid.");
            return s;
        }
        public static void Owned(InstallState state) {
            if(state==null) return;var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach(var f in state.OwnedFiles) {
                if(!seen.Add(f.Path)||!Regex.IsMatch(f.Sha256??"","^[a-fA-F0-9]{64}$")) throw new IOException("Invalid installed file ownership record.");
                string path=NativeIO.SafePath(state.InstallDir,f.Path);
                if(Directory.Exists(path)||(File.Exists(path)&&!Same(NativeIO.FileHash(path),f.Sha256))) throw new IOException("An installed file was modified; it was preserved: "+path);
            }
            if(state.Startup!=null) {
                NativeIO.PlainPath(state.Startup.Path);
                if(File.Exists(state.Startup.Path)&&!Same(NativeIO.FileHash(state.Startup.Path),state.Startup.Sha256)) throw new IOException("The Startup shortcut changed; it was preserved.");
            }
        }
        static PackageManifest Package(string root) {
            NativeIO.PlainPath(root);var m=Read<PackageManifest>(Path.Combine(root,"package-manifest.json"));
            if(m.Product!="agent-browser"||m.Platform!="windows-x64"||!Regex.IsMatch(m.Version??"",@"^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$")||m.Files==null) throw new IOException("Invalid Windows package manifest.");
            var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach(var f in m.Files) {
                if(!seen.Add(f.Path)||!Regex.IsMatch(f.Sha256??"","^[a-fA-F0-9]{64}$")) throw new IOException("Invalid package file entry.");
                string relative=f.Path.Replace('\\','/');
                if(relative.StartsWith("data/",StringComparison.OrdinalIgnoreCase)||relative.StartsWith(".",StringComparison.Ordinal)||Same(relative,StateName)||relative.StartsWith("app/",StringComparison.OrdinalIgnoreCase)) throw new IOException("Reserved install path in package.");
                string path=NativeIO.SafePath(root,f.Path);if(!File.Exists(path)||!Same(NativeIO.FileHash(path),f.Sha256)) throw new IOException("Package checksum mismatch: "+f.Path);
            }
            foreach(var required in new [] {"browser-bridge.exe","extension/manifest.json","AgentBrowser-Setup.exe","README-install.md","LICENSE"}) if(!seen.Contains(required)) throw new IOException("Extract the complete GUI package; missing "+required+".");
            var bytes=File.ReadAllBytes(Path.Combine(root,"browser-bridge.exe"));int offset=bytes.Length>=64?BitConverter.ToInt32(bytes,60):-1;
            if(bytes.Length<128||bytes[0]!=77||bytes[1]!=90||offset<0||offset>bytes.Length-6||BitConverter.ToUInt32(bytes,offset)!=17744||BitConverter.ToUInt16(bytes,offset+4)!=34404) throw new IOException("Bridge is not a Windows x64 executable.");
            return m;
        }
        static void Add(InstallPlan p,string path,byte[] bytes,string user=null) {
            if(p.Changes.Any(c=>Same(c.Path,path))) throw new IOException("Two planned changes target the same file: "+path);
            NativeIO.PlainPath(path);if(Directory.Exists(path)) throw new IOException("A directory blocks a file: "+path);
            var expected=HashOrMissing(path);if(bytes!=null&&NativeIO.Hash(bytes)==expected) return;
            if(bytes==null&&expected=="missing") return;
            p.Changes.Add(new Change{Path=path,Expected=expected,Bytes=bytes,User=user});
        }
        static List<McpRecord> Registrations(InstallState state) {
            var list=new List<McpRecord>();if(state==null) return list;
            if(state.Mcps!=null) list.AddRange(state.Mcps);if(state.Mcp!=null&&!list.Any(x=>Same(x.Path,state.Mcp.Path))) list.Add(state.Mcp);return list;
        }
        static string BackupSettings(InstallPlan plan,string data,string source,byte[] bytes) {
            string backup=Path.Combine(data,"settings-backups",Guid.NewGuid().ToString("N")+".bak");
            Add(plan,backup,bytes);
            Add(plan,backup+".json",NativeIO.Utf8.GetBytes(NativeIO.Json.Serialize(new {Path=source,Sha256=NativeIO.Hash(bytes)})));
            return backup;
        }
        static object Entry(InstallState state,McpRecord registration) {
            string exe=state.CurrentExe;
            var environment=new Dictionary<string,string>{{"AGENT_BROWSER_HOME",state.DataDir},{"AGENT_BROWSER_PORT",state.Port.ToString()}};
            if(registration.Kind=="wsl") {
                if(String.IsNullOrWhiteSpace(registration.Distribution)) throw new IOException("Select a WSL distribution.");
                exe=NativeIO.RunChecked(NativeIO.WslExe,new [] {"--distribution",registration.Distribution,"--exec","wslpath","-u",exe});
                if(!exe.StartsWith("/")) throw new IOException("WSL executable path conversion failed.");
                environment.Add("WSLENV","AGENT_BROWSER_HOME/w:AGENT_BROWSER_PORT/w");
            } else if(registration.Kind!="windows") throw new IOException("Select Windows or WSL.");
            return new Dictionary<string,object>{{"type","local"},{"command",new [] {exe,"mcp"}},{"enabled",true},{"environment",environment}};
        }
        public static InstallPlan Prepare(SetupOptions options) {
            string root=Root(options.InstallDir);options.InstallDir=root;
            var p=new InstallPlan{Options=options,Old=State(root),StateHash=HashOrMissing(Path.Combine(root,StateName))};Owned(p.Old);
            if(p.Old!=null&&p.Old.Startup!=null)p.OldStartupHash=HashOrMissing(p.Old.Startup.Path);
            bool uninstall=options.Operation=="uninstall";
            if((options.Operation=="update"||uninstall)&&p.Old==null) throw new IOException("No owned installation was found in the selected folder.");
            if(uninstall) {
                p.Summary.Add("제거 대상: "+root+"\r\n버전: "+p.Old.Version+"\r\n페어링·프로필·사용자 데이터는 보존합니다.");
                foreach(var record in Registrations(p.Old)) if(File.Exists(record.Path)) {
                    byte[] original=File.ReadAllBytes(record.Path);var edit=Jsonc.Edit(NativeIO.Utf8.GetString(original),null,record.EntryHash,true,record.CreatedMcp);
                    // Comments are user content too: only remove a whitespace-only empty object.
                    if(edit.Changed) {
                        BackupSettings(p,p.Old.DataDir,record.Path,original);
                        Add(p,record.Path,record.CreatedFile&&Regex.IsMatch(edit.Text,@"^\s*\{\s*\}\s*$")?null:NativeIO.Utf8.GetBytes(edit.Text),record.User);
                        if(HashOrMissing(record.Path)!=NativeIO.Hash(original))throw new IOException("Settings changed during preview. Preview it again.");
                    }
                    p.Summary.Add("소유한 browser MCP 등록 제거: "+record.Path);
                }
                foreach(var file in p.Old.OwnedFiles) Add(p,NativeIO.SafePath(root,file.Path),null);
                if(p.Old.Startup!=null) Add(p,p.Old.Startup.Path,null);
                Add(p,Path.Combine(root,StateName),null);return p;
            }
            if(options.Operation!="install"&&options.Operation!="update") throw new IOException("Unknown operation.");
            if(options.Port<1||options.Port>65535) throw new IOException("Port must be between 1 and 65535.");
            string package=Full(options.PackageDir);if(Same(package,root)||package.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)) throw new IOException("Extract the package outside the destination installation.");
            var manifest=Package(package);string id=p.Old==null?Guid.NewGuid().ToString("N"):p.Old.InstallId,data=Path.Combine(root,"data"),ownerPath=Path.Combine(data,".agent-browser-data-owner.json");
            if(Directory.Exists(data)&&p.Old==null) {
                if(File.Exists(ownerPath)) {var owner=Read<Dictionary<string,string>>(ownerPath);if(owner["Product"]!=Product||!Regex.IsMatch(owner["InstallId"],"^[a-fA-F0-9]{32}$")) throw new IOException("Existing data ownership is invalid.");id=owner["InstallId"];}
                else if(Directory.GetFileSystemEntries(data).Length>0) throw new IOException("Existing unowned data will not be changed.");
            }
            string tag=manifest.Version+"-"+manifest.Files.First(f=>f.Path=="browser-bridge.exe").Sha256.Substring(0,12);
            var next=new InstallState{Product=Product,SchemaVersion=1,InstallId=id,InstallDir=root,DataDir=data,Version=manifest.Version,CurrentExe=NativeIO.SafePath(root,"app/"+tag+"/browser-bridge.exe"),SetupExe=NativeIO.SafePath(root,"app/"+tag+"/AgentBrowser-Setup.exe"),Port=options.Port,InstalledAt=p.Old==null?DateTime.UtcNow.ToString("o"):p.Old.InstalledAt,UpdatedAt=DateTime.UtcNow.ToString("o")};p.Next=next;
            var owned=p.Old==null?new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase):p.Old.OwnedFiles.ToDictionary(x=>x.Path,x=>x.Sha256,StringComparer.OrdinalIgnoreCase);
            foreach(var file in manifest.Files) {
                string relative=file.Path;if(relative=="browser-bridge.exe"||relative=="AgentBrowser-Setup.exe") relative="app/"+tag+"/"+relative;
                string dest=NativeIO.SafePath(root,relative);
                if(File.Exists(dest)&&!owned.ContainsKey(relative)) throw new IOException("An unowned file blocks installation: "+dest);
                Add(p,dest,File.ReadAllBytes(NativeIO.SafePath(package,file.Path)));owned[relative]=file.Sha256.ToLowerInvariant();
            }
            var oldRecords=Registrations(p.Old);var requested=new List<McpRecord>(oldRecords);
            foreach(var r in options.Registrations) {r.Path=Full(r.Path);if(!requested.Any(x=>Same(x.Path,r.Path))) requested.Add(r);}
            var records=new List<McpRecord>();
            foreach(var record in requested) {
                var wslTarget=NativeIO.MapWsl(record.Path);
                if(wslTarget!=null&&(record.Kind!="wsl"||!Same(wslTarget.Distribution,record.Distribution)))throw new IOException("The selected WSL settings path and distribution do not match.");
                var previous=oldRecords.FirstOrDefault(x=>Same(x.Path,record.Path));
                bool existed=File.Exists(record.Path);byte[] originalBytes=existed?File.ReadAllBytes(record.Path):NativeIO.Utf8.GetBytes("{}");string original=NativeIO.Utf8.GetString(originalBytes);
                var edit=Jsonc.Edit(original,Entry(next,record),previous==null?null:previous.EntryHash);
                var updated=new McpRecord{Path=record.Path,Kind=record.Kind,Distribution=record.Distribution,User=record.User,EntryHash=edit.EntryHash,CreatedMcp=edit.CreatedMcp||(previous!=null&&previous.CreatedMcp),CreatedFile=!existed||(previous!=null&&previous.CreatedFile),Backups=previous==null?new string[0]:previous.Backups};
                records.Add(updated);if(edit.Changed) {
                    if(existed) {
                        // Durable backups inherit the private data directory ACL and survive uninstall.
                        string backup=BackupSettings(p,data,record.Path,originalBytes);
                        updated.Backups=(updated.Backups??new string[0]).Concat(new[]{backup}).ToArray();
                    }
                    Add(p,record.Path,NativeIO.Utf8.GetBytes(edit.Text),record.User);
                    if(HashOrMissing(record.Path)!=(existed?NativeIO.Hash(originalBytes):"missing"))throw new IOException("Settings changed during preview. Preview it again.");
                }
                p.Summary.Add("일반 CLI용 browser MCP "+(previous==null?"등록: ":"갱신: ")+record.Path);
            }
            next.Mcps=records.ToArray();next.Mcp=records.Count==1?records[0]:null;
            next.OwnedFiles=owned.Select(x=>new OwnedFile{Path=x.Key,Sha256=x.Value}).ToArray();
            if(options.Startup) {
                if(String.IsNullOrEmpty(options.StartupDir)) throw new IOException("Select a Startup folder.");
                string shortcut=Path.Combine(Full(options.StartupDir),"AgentBrowser.lnk");NativeIO.PlainPath(shortcut);
                if(File.Exists(shortcut)&&(p.Old==null||p.Old.Startup==null||!Same(p.Old.Startup.Path,shortcut))) throw new IOException("An unowned Startup shortcut already exists.");
                next.Startup=new StartupRecord{Path=shortcut};p.NextStartupHash=HashOrMissing(shortcut);p.Summary.Add("로그인 시 Bridge 시작: "+shortcut);
            }
            p.Summary.Insert(0,(p.Old==null?"설치: ":"업데이트: ")+manifest.Version+"\r\n대상: "+root+"\r\n데이터: "+data+"\r\nBridge 포트: "+next.Port);
            p.Summary.Add(options.Start?"적용 후 Bridge를 시작합니다.":"파일 설치 후 Bridge 시작은 보류합니다.");
            p.Summary.Add("관리 OpenCode 서버는 Chrome 페어링과 프로필 설정 후 시작합니다. 일반 CLI MCP 등록과 별도입니다.");
            return p;
        }
        public static void PrivateDirectory(string path) {
            NativeIO.PlainPath(path);Directory.CreateDirectory(path);
            var acl=Directory.GetAccessControl(path,AccessControlSections.Access);acl.SetAccessRuleProtection(true,false);
            foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,false,typeof(SecurityIdentifier))) acl.RemoveAccessRuleAll(rule);
            foreach(var sid in new [] {WindowsIdentity.GetCurrent().User,new SecurityIdentifier("S-1-5-18"),new SecurityIdentifier("S-1-5-32-544")}) acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
            Directory.SetAccessControl(path,acl);
        }
        static byte[] Shortcut(string stage,string target,string root) {
            string path=Path.Combine(stage,"startup.lnk");object shortcut=new ShellLink();
            try {
                var link=(IShellLinkW)shortcut;link.SetPath(target);link.SetArguments("--start "+NativeIO.Quote(root));link.SetWorkingDirectory(root);link.SetShowCmd(7);
                ((System.Runtime.InteropServices.ComTypes.IPersistFile)shortcut).Save(path,true);return File.ReadAllBytes(path);
            } finally {System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut);if(File.Exists(path)) File.Delete(path);}
        }
        public static string Apply(InstallPlan p,CancellationToken cancel,Action<string> progress) {
            string root=p.Options.InstallDir,lockPath=Path.Combine(root,".agent-browser-install.lock");Directory.CreateDirectory(root);
            bool restartOld=false,newStarted=false;var stoppedProfiles=new List<string>();FileTransaction transaction=null;bool complete=false;
            using(var fileLock=new FileStream(lockPath,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
                try {
                    if(HashOrMissing(Path.Combine(root,StateName))!=p.StateHash) throw new IOException("Installation changed after preview. Preview it again.");
                    Owned(p.Old);
                    if(p.Old!=null) {var ownerRecord=Read<Dictionary<string,string>>(Path.Combine(p.Old.DataDir,".agent-browser-data-owner.json"));if(ownerRecord["Product"]!=Product||ownerRecord["InstallId"]!=p.Old.InstallId)throw new IOException("Existing data ownership changed. No process or data was changed.");}
                    foreach(var change in p.Changes) if(HashOrMissing(change.Path)!=change.Expected) throw new IOException("A file changed after preview: "+change.Path);
                    cancel.ThrowIfCancellationRequested();transaction=new FileTransaction(root);
                    if(p.Old!=null) {
                        if(p.Next==null) BridgeControl.StopRuntimes(p.Old,stoppedProfiles);
                        restartOld=BridgeControl.Stop(p.Old);
                    }
                    if(p.Next!=null) {
                        string existingOwner=Path.Combine(p.Next.DataDir,".agent-browser-data-owner.json");
                        if(File.Exists(existingOwner)) {var ownerRecord=Read<Dictionary<string,string>>(existingOwner);if(ownerRecord["Product"]!=Product||ownerRecord["InstallId"]!=p.Next.InstallId)throw new IOException("Existing data ownership changed. No data permissions were changed.");}
                        else if(Directory.Exists(p.Next.DataDir)&&Directory.GetFileSystemEntries(p.Next.DataDir).Length>0)throw new IOException("Existing data has no verified ownership marker.");
                        PrivateDirectory(p.Next.DataDir);
                        string owner=Path.Combine(p.Next.DataDir,".agent-browser-data-owner.json");
                        // Startup can create pairing data before it fails. Keep
                        // its ownership marker so a retry can reuse that data.
                        if(!File.Exists(owner)) NativeIO.WriteText(owner,NativeIO.Json.Serialize(new {Product=Product,InstallId=p.Next.InstallId}),"missing");
                    }
                    int n=0;foreach(var change in p.Changes) {cancel.ThrowIfCancellationRequested();progress("파일 적용 "+(++n)+" / "+p.Changes.Count);transaction.Write(change);}
                    if(p.Next!=null) {
                        if(p.Old!=null&&p.Old.Startup!=null&&(p.Next.Startup==null||!Same(p.Old.Startup.Path,p.Next.Startup.Path))) transaction.Write(new Change{Path=p.Old.Startup.Path,Expected=p.OldStartupHash});
                        if(p.Next.Startup!=null) {var bytes=Shortcut(transaction.Stage,p.Next.SetupExe,root);transaction.Write(new Change{Path=p.Next.Startup.Path,Expected=p.NextStartupHash,Bytes=bytes});p.Next.Startup.Sha256=NativeIO.Hash(bytes);}
                        cancel.ThrowIfCancellationRequested();
                        transaction.Write(new Change{Path=Path.Combine(root,StateName),Expected=p.StateHash,Bytes=NativeIO.Utf8.GetBytes(NativeIO.Json.Serialize(p.Next))});
                        if(p.Options.Start) {progress("Bridge 시작 확인 중");BridgeControl.Start(p.Next);newStarted=true;}
                    } else transaction.Write(new Change{Path=Path.Combine(p.Old.DataDir,".installer-bridge-process.json"),Expected=HashOrMissing(Path.Combine(p.Old.DataDir,".installer-bridge-process.json"))});
                    cancel.ThrowIfCancellationRequested();
                    complete=true;string warning="";
                    try {transaction.Cleanup();}catch(Exception) {warning="\r\n경고: 설치 변경은 완료됐지만 임시 복구 파일 정리는 실패했습니다. 보존된 경로: "+transaction.Stage;progress(warning);}
                    try {using(var registry=Registry.CurrentUser.CreateSubKey(@"Software\AgentBrowser\Installations")) {if(p.Next==null) registry.DeleteSubKey(p.Old.InstallId,false);else using(var item=registry.CreateSubKey(p.Next.InstallId)) item.SetValue("Path",root);}} catch(Exception) {progress("설치는 완료됐지만 다음 실행의 설치 위치 자동 등록은 실패했습니다. 폴더를 직접 선택할 수 있습니다.");}
                    return (p.Next==null?"제거 완료. 페어링·프로필 데이터와 OpenCode 설정의 다른 항목을 보존했습니다.":"설치 완료: "+p.Next.Version+"\r\nChrome 확장 폴더: "+Path.Combine(root,"extension")+"\r\nChrome에서 확장을 로드 또는 새로고침하고 페어링하세요.")+warning;
                } catch(Exception error) {
                    if(transaction!=null&&!complete) {
                        try {if(newStarted) BridgeControl.Stop(p.Next);transaction.Rollback();if(restartOld) BridgeControl.Start(p.Old);foreach(var id in stoppedProfiles) BridgeControl.Invoke(p.Old,new [] {"runtime","start","--profile",id},60000);transaction.Cleanup();}
                        catch(Exception rollback) {throw new IOException(error.Message+"\r\n일부 복구가 필요합니다. 복구 파일: "+transaction.Stage+"\r\n"+rollback.Message,error);}
                    }
                    throw;
                }
            }
        }
    }
    internal sealed class FileTransaction {
        internal sealed class Saved { public string Path,Backup,Written,User;public bool Existed; }
        public readonly string Stage;readonly List<Saved> saved=new List<Saved>();
        public FileTransaction(string root) {Stage=Path.Combine(root,".transaction-"+Guid.NewGuid().ToString("N"));InstallerEngine.PrivateDirectory(Stage);}
        public void Write(Change change) {
            NativeIO.PlainPath(change.Path);if(InstallerEngine.HashOrMissing(change.Path)!=change.Expected) throw new IOException("A file changed before applying: "+change.Path);
            var entry=new Saved{Path=change.Path,Existed=File.Exists(change.Path),Backup=Path.Combine(Stage,saved.Count+".backup"),User=change.User};
            if(entry.Existed) File.Copy(change.Path,entry.Backup,false);
            if(change.Bytes==null) {if(File.Exists(change.Path)) File.Delete(change.Path);}else NativeIO.WriteAtomic(change.Path,change.Bytes,change.Expected,change.User);
            entry.Written=change.Bytes==null?"missing":NativeIO.Hash(change.Bytes);saved.Add(entry);
            File.WriteAllText(Path.Combine(Stage,"journal.json"),NativeIO.Json.Serialize(saved),NativeIO.Utf8);
        }
        public void Rollback() {
            for(int i=saved.Count-1;i>=0;i--) {
                var e=saved[i];NativeIO.PlainPath(e.Path);
                if(InstallerEngine.HashOrMissing(e.Path)!=e.Written) throw new IOException("A concurrently changed file was preserved: "+e.Path);
                if(e.Existed) NativeIO.WriteAtomic(e.Path,File.ReadAllBytes(e.Backup),e.Written,e.User);else if(File.Exists(e.Path)) File.Delete(e.Path);
            }
        }
        public void Cleanup() {NativeIO.PlainPath(Stage);foreach(var file in Directory.GetFiles(Stage)) {NativeIO.PlainPath(file);File.Delete(file);}Directory.Delete(Stage);}
    }
    internal static class BridgeControl {
        public static string Invoke(InstallState state,string[] args,int timeout=20000) {return NativeIO.RunChecked(state.CurrentExe,args,state.InstallDir,new Dictionary<string,string>{{"AGENT_BROWSER_HOME",state.DataDir},{"AGENT_BROWSER_PORT",state.Port.ToString()}},timeout);}
        static Dictionary<string,object> Marker(InstallState state) {string path=Path.Combine(state.DataDir,".installer-bridge-process.json");return File.Exists(path)?InstallerEngine.Read<Dictionary<string,object>>(path):null;}
        static ManagementObject Verify(InstallState state,Dictionary<string,object> marker) {
            if(marker==null) return null;
            if((string)marker["Product"]!=InstallerEngine.Product||(string)marker["InstallId"]!=state.InstallId) throw new IOException("Bridge process ownership marker mismatch.");
            int pid=Convert.ToInt32(marker["Pid"]);if(pid<=0) throw new IOException("Invalid owned PID.");
            string expected=InstallerEngine.Full((string)marker["Executable"]);
            if(!state.OwnedFiles.Any(f=>InstallerEngine.Same(NativeIO.SafePath(state.InstallDir,f.Path),expected)&&InstallerEngine.Same(NativeIO.FileHash(expected),f.Sha256))) throw new IOException("Recorded Bridge executable is not owned.");
            using(var query=new ManagementObjectSearcher("SELECT ExecutablePath, CommandLine, CreationDate FROM Win32_Process WHERE ProcessId="+pid)) {
                foreach(ManagementObject process in query.Get()) {
                    DateTime created=ManagementDateTimeConverter.ToDateTime((string)process["CreationDate"]).ToUniversalTime();
                    var expectedCreated=DateTime.Parse((string)marker["CreatedAt"],null,System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
                    if(!InstallerEngine.Same(InstallerEngine.Full((string)process["ExecutablePath"]),expected)||!Regex.IsMatch((string)process["CommandLine"],@"(?:^|\s)serve\s+--port\s+"+Convert.ToInt32(marker["Port"])+@"(?:\s|$)")||created!=expectedCreated) {process.Dispose();throw new IOException("Recorded PID identity changed. No process was stopped.");}
                    return process;
                }
            }return null;
        }
        public static bool Stop(InstallState state) {
            var marker=Marker(state);using(var process=Verify(state,marker)) {if(process==null) return false;}
            using(var again=Verify(state,marker)) {if(again==null) return false;using(var p=Process.GetProcessById(Convert.ToInt32(marker["Pid"]))) {p.Kill();if(!p.WaitForExit(5000)) throw new IOException("Owned Bridge did not stop.");}}
            return true;
        }
        public static void Start(InstallState state) {
            InstallerEngine.Owned(state);
            var existing=Marker(state);
            using(var verified=Verify(state,existing)) {if(verified!=null&&InstallerEngine.Same((string)existing["Executable"],state.CurrentExe)&&Convert.ToInt32(existing["Port"])==state.Port)return;}
            using(var startup=new BridgeStartJob(state.CurrentExe,state.InstallDir,new Dictionary<string,string>{{"AGENT_BROWSER_HOME",state.DataDir},{"AGENT_BROWSER_PORT",state.Port.ToString()}},state.Port)) {
            startup.Wait();
            int pid;string pidPath=Path.Combine(state.DataDir,"serve.pid");
            if(!File.Exists(pidPath)||!Int32.TryParse(File.ReadAllText(pidPath).Trim(),out pid)||pid<=0)throw new IOException("Bridge PID publication failed.");
            startup.RequireChild(pid);
            using(var query=new ManagementObjectSearcher("SELECT ExecutablePath, CommandLine, CreationDate FROM Win32_Process WHERE ProcessId="+pid)) {
                foreach(ManagementObject process in query.Get()) using(process) {
                    if(!InstallerEngine.Same(InstallerEngine.Full((string)process["ExecutablePath"]),state.CurrentExe)||!Regex.IsMatch((string)process["CommandLine"],@"(?:^|\s)serve\s+--port\s+"+state.Port+@"(?:\s|$)")) throw new IOException("Bridge process identity could not be verified.");
                    var marker=new Dictionary<string,object>{{"Product",InstallerEngine.Product},{"InstallId",state.InstallId},{"Pid",pid},{"Executable",state.CurrentExe},{"Port",state.Port},{"CreatedAt",ManagementDateTimeConverter.ToDateTime((string)process["CreationDate"]).ToUniversalTime().ToString("o")}};
                    NativeIO.WriteText(Path.Combine(state.DataDir,".installer-bridge-process.json"),NativeIO.Json.Serialize(marker));
                    startup.Commit();
                    return;
                }
            }throw new IOException("Bridge process disappeared during startup.");
            }
        }
        public static List<string> StopRuntimes(InstallState state,List<string> stopped=null) {
            var ids=stopped??new List<string>();if(!File.Exists(Path.Combine(state.DataDir,"runtime.json"))) return ids;
            var result=NativeIO.Run(state.CurrentExe,new [] {"runtime","stop-all","--json"},state.InstallDir,new Dictionary<string,string>{{"AGENT_BROWSER_HOME",state.DataDir},{"AGENT_BROWSER_PORT",state.Port.ToString()}},120000);
            if(String.IsNullOrWhiteSpace(result.Output))throw new IOException("Managed runtime cleanup did not return a report; installation was retained.");
            var report=NativeIO.Json.Deserialize<Dictionary<string,object>>(result.Output);
            foreach(var id in (System.Collections.IEnumerable)report["stoppedProfiles"])ids.Add((string)id);
            var errors=(System.Collections.IEnumerable)report["errors"];foreach(var error in errors)throw new IOException("A managed runtime could not be stopped; installation was retained.");
            if(result.ExitCode!=0)throw new IOException("Managed runtime cleanup failed; installation was retained.");return ids;
        }
    }
}

