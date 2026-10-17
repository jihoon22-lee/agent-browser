using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Microsoft.Win32;

namespace AgentBrowser.Installer {
    internal sealed class OpenCodeCandidate {
        public string Kind, Distribution, User, Home, Executable, Version;public string Error=null;
        public readonly List<string> Settings = new List<string>();
        public override string ToString() { return (Kind=="wsl" ? "WSL · "+Distribution+" · "+User : "Windows")+" · "+Executable; }
    }
    internal sealed class DiscoveryResult {
        public readonly List<string> Installs = new List<string>();
        public readonly List<string> Distributions = new List<string>();
        public readonly List<OpenCodeCandidate> OpenCode = new List<OpenCodeCandidate>();
        public readonly List<string> Notices = new List<string>();
    }
    internal static class Discovery {
        static bool Same(string a,string b) { return String.Equals(a,b,StringComparison.OrdinalIgnoreCase); }
        public static bool IsLocalCandidatePath(string path) {
            if(String.IsNullOrWhiteSpace(path)||path.StartsWith(@"\\")||path.StartsWith("//"))return false;
            try {string root=Path.GetPathRoot(path);if(root==null||root.Length!=3||root[1]!=':'||root[2]!='\\')return false;var type=new DriveInfo(root).DriveType;return type==DriveType.Fixed||type==DriveType.Removable||type==DriveType.CDRom||type==DriveType.Ram;}
            catch(ArgumentException){return false;}catch(IOException){return false;}
        }
        public static bool IsPlainLocalPath(string path,bool directory) {
            if(!IsLocalCandidatePath(path))return false;
            try {
                string full=Path.GetFullPath(path),current=Path.GetPathRoot(full);var attributes=File.GetAttributes(current);
                // Inspect each component before touching descendants: GetFileAttributes
                // reports the link itself, so a local junction cannot redirect a probe to SMB.
                foreach(string part in full.Substring(current.Length).Split(new[]{Path.DirectorySeparatorChar},StringSplitOptions.RemoveEmptyEntries)) {
                    if((attributes&FileAttributes.ReparsePoint)!=0)return false;
                    current=Path.Combine(current,part);attributes=File.GetAttributes(current);
                }
                return (attributes&FileAttributes.ReparsePoint)==0&&((attributes&FileAttributes.Directory)!=0)==directory;
            } catch(ArgumentException){return false;}catch(IOException){return false;}catch(UnauthorizedAccessException){return false;}catch(NotSupportedException){return false;}
        }
        public static void AddInstall(DiscoveryResult result,string path) {
            try {
                if(String.IsNullOrEmpty(path)) return;
                path=Path.GetFullPath(path).TrimEnd('\\');
                NativeIO.PlainPath(path);
                var marker=Path.Combine(path,".agent-browser-install.json");
                if(!File.Exists(marker)) return;
                var state=NativeIO.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(marker));
                if((string)state["Product"]!="agent-browser.user-install.v1"||!Same(Path.GetFullPath((string)state["InstallDir"]).TrimEnd('\\'),path)) return;
                if(!result.Installs.Any(p=>Same(p,path))) result.Installs.Add(path);
            } catch(Exception error) { result.Notices.Add("설치 상태를 확인하지 못했습니다: "+path+" · "+error.Message); }
        }
        public static DiscoveryResult InstalledPaths() {
            var result=new DiscoveryResult();
            AddInstall(result,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AgentBrowser"));
            // These product-owned registry entries only identify install roots.
            // Never enumerate Chrome profiles or arbitrary home directories.
            using(var root=Registry.CurrentUser.OpenSubKey(@"Software\AgentBrowser\Installations")) {
                if(root!=null) foreach(var id in root.GetSubKeyNames()) using(var key=root.OpenSubKey(id)) AddInstall(result,key==null?null:key.GetValue("Path") as string);
            }
            return result;
        }
        public static DiscoveryResult Find() {
            var result=InstalledPaths();
            var candidates=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var home=Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            candidates.Add(Path.Combine(home,@".opencode\bin\opencode.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),@"Programs\opencode\opencode.exe"));
            foreach(var directory in (Environment.GetEnvironmentVariable("PATH")??"").Split(';')) {
                if(String.IsNullOrWhiteSpace(directory)) continue;
                try { foreach(var name in new [] {"opencode.exe","opencode.cmd"}) candidates.Add(Path.Combine(directory.Trim('"'),name)); } catch(ArgumentException) { }
            }
            foreach(var executable in candidates) if(IsPlainLocalPath(executable,false)) {
                var candidate=new OpenCodeCandidate { Kind="windows",Home=home,Executable=Path.GetFullPath(executable) };
                AddConfigFiles(candidate,Path.Combine(home,@".config\opencode"));
                // Enumeration must not execute an unselected PATH candidate.
                // ManagedProfile.Prepare probes only after the user's Confirm action.
                result.OpenCode.Add(candidate);
            }
            if(!File.Exists(NativeIO.WslExe)) { result.Notices.Add("WSL을 찾지 못했습니다. Windows 설치만 진행하거나 WSL 설정을 나중에 추가할 수 있습니다."); return result; }
            try {
                // wsl --list emits UTF-16LE on native Windows, unlike Linux --exec output.
                var listing=NativeIO.Run(NativeIO.WslExe,new [] {"--list","--quiet"},null,null,15000,Encoding.Unicode);
                if(listing.ExitCode!=0) { result.Notices.Add("WSL 배포판을 확인하지 못했습니다. WSL 또는 회사 정책 상태를 확인하세요."); return result; }
                var runningResult=NativeIO.Run(NativeIO.WslExe,new [] {"--list","--running","--quiet"},null,null,15000,Encoding.Unicode);
                var running=new HashSet<string>((runningResult.ExitCode==0?runningResult.Output:"").Split(new [] {'\r','\n'},StringSplitOptions.RemoveEmptyEntries).Select(s=>s.Trim('\0',' ','\t')),StringComparer.OrdinalIgnoreCase);
                foreach(var value in listing.Output.Split(new [] {'\r','\n'},StringSplitOptions.RemoveEmptyEntries)) {
                    var distribution=value.Trim('\0',' ','\t');if(distribution.Length==0) continue;
                    if(distribution.StartsWith("docker-desktop",StringComparison.OrdinalIgnoreCase)) continue;
                    result.Distributions.Add(distribution);
                    if(!running.Contains(distribution)) {result.Notices.Add(distribution+": 중지된 배포판은 자동 시작하지 않았습니다. 사용할 배포판과 경로를 직접 선택하면 확인할 수 있습니다.");continue;}
                    try { result.OpenCode.AddRange(FindWsl(distribution,null)); }
                    catch(Exception error) { result.Notices.Add(distribution+": "+error.Message); }
                }
                if(result.Distributions.Count==0) result.Notices.Add("등록된 WSL 배포판이 없습니다. WSL 설치를 자동으로 실행하지 않습니다.");
            } catch(Exception error) { result.Notices.Add("WSL 검색을 완료하지 못했습니다: "+error.Message); }
            return result;
        }
        static void AddConfigFiles(OpenCodeCandidate candidate,string directory) {
            foreach(var name in new [] {"opencode.json","opencode.jsonc"}) {var path=Path.Combine(directory,name);if(File.Exists(path)) candidate.Settings.Add(path);}
        }
        public static string Version(OpenCodeCandidate candidate) {
            string version;
            if(candidate.Kind=="wsl") {
                var args=new List<string>{"--distribution",candidate.Distribution};
                if(!String.IsNullOrEmpty(candidate.User)) args.AddRange(new [] {"--user",candidate.User});
                args.AddRange(new [] {"--exec",candidate.Executable,"--version"});
                version=NativeIO.RunChecked(NativeIO.WslExe,args,timeout:15000);
            } else if(candidate.Executable.EndsWith(".cmd",StringComparison.OrdinalIgnoreCase)) {
                // A fixed shell command uses an environment variable, never interpolates
                // a user path into shell syntax, and disables delayed expansion.
                version=NativeIO.CmdVersion(candidate.Executable);
            } else version=NativeIO.RunChecked(candidate.Executable,new [] {"--version"});
            if(!System.Text.RegularExpressions.Regex.IsMatch(version,@"^1\.[0-9A-Za-z.+-]+$")) throw new IOException("OpenCode v1 실행파일인지 확인하지 못했습니다. nvm·npm으로 설치한 OpenCode라면 로그인 셸 없이 실행할 수 없을 수 있습니다. ~/.opencode/bin/opencode 같은 독립 실행 파일 경로를 사용하세요.");
            candidate.Version=version;return version;
        }
        // Runs in the selected distribution without a login shell, so also check common user-level
        // install locations and ask a login shell, where nvm/bun usually extend PATH.
        internal const string WslProbe=@"set -eu
printf 'USER\t%s\n' ""$(id -un)""
printf 'HOME\t%s\n' ""$HOME""
p=$(command -v opencode || true); [ -z ""$p"" ] || printf 'EXE\t%s\n' ""$p""
for p in ""$HOME/.opencode/bin/opencode"" ""$HOME/.local/bin/opencode"" ""$HOME/.bun/bin/opencode"" ""$HOME/.npm-global/bin/opencode"" /usr/local/bin/opencode ""$HOME""/.nvm/versions/node/*/bin/opencode; do [ ! -x ""$p"" ] || printf 'EXE\t%s\n' ""$p""; done
if command -v bash >/dev/null 2>&1; then p=$(bash -lc 'command -v opencode' 2>/dev/null || true); [ -z ""$p"" ] || printf 'EXE\t%s\n' ""$p""; fi
c=${XDG_CONFIG_HOME:-$HOME/.config}/opencode
for p in ""$c/opencode.json"" ""$c/opencode.jsonc""; do [ ! -f ""$p"" ] || printf 'CFG\t%s\n' ""$p""; done
";
        public static List<OpenCodeCandidate> FindWsl(string distribution,string user) { return FindWsl(distribution,user,15000); }
        public static List<OpenCodeCandidate> FindWsl(string distribution,string user,int timeout) {
            var args=new List<string>{"--distribution",distribution};if(!String.IsNullOrEmpty(user)) args.AddRange(new [] {"--user",user});args.AddRange(new [] {"--exec","/bin/sh","-c",WslProbe.Replace("\r\n","\n")});
            var text=NativeIO.RunChecked(NativeIO.WslExe,args,timeout:timeout);
            var executables=new HashSet<string>();var configs=new List<string>();string actualUser=null,home=null;
            foreach(var line in text.Split('\n')) {var parts=line.TrimEnd('\r').Split(new [] {'\t'},2);if(parts.Length!=2) continue;switch(parts[0]) {case "USER":actualUser=parts[1];break;case "HOME":home=parts[1];break;case "EXE":executables.Add(parts[1]);break;case "CFG":configs.Add(parts[1]);break;}}
            if(String.IsNullOrEmpty(actualUser)||String.IsNullOrEmpty(home)||!home.StartsWith("/")) throw new IOException("WSL 사용자와 홈 경로를 확인하지 못했습니다.");
            var found=new List<OpenCodeCandidate>();
            foreach(var exe in executables) {
                var item=new OpenCodeCandidate { Kind="wsl",Distribution=distribution,User=actualUser,Home=home,Executable=exe };
                foreach(var path in configs) item.Settings.Add(@"\\wsl.localhost\"+distribution+path.Replace('/','\\'));
                found.Add(item);
            }
            return found;
        }
    }
}
