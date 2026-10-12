using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace AgentBrowser.Installer {
    internal sealed class CommandResult {
        public int ExitCode; public string Output; public string Error;
    }
    internal sealed class WslTarget {
        public string Distribution; public string Path;
    }
    internal static class NativeIO {
        public static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        public static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 100 };
        public static string WslExe { get { return System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wsl.exe"); } }
        public static string Hash(byte[] bytes) { using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
        public static string FileHash(string path) { return Hash(File.ReadAllBytes(path)); }
        public static string TextHash(string text) { return Hash(Utf8.GetBytes(text)); }
        public static string Quote(string text) {
            if (!String.IsNullOrEmpty(text) && !Regex.IsMatch(text, "[\\s\"]")) return text;
            return "\"" + Regex.Replace(Regex.Replace(text ?? "", "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\"";
        }
        public static CommandResult Run(string executable, IEnumerable<string> arguments, string directory, IDictionary<string,string> environment, int timeout, Encoding encoding=null) {
            var args=new List<string>(); foreach(var argument in arguments) args.Add(Quote(argument));
            return RunRaw(executable,String.Join(" ",args),directory,environment,timeout,encoding);
        }
        public static string CmdVersion(string executable) {
            var env=new Dictionary<string,string>{{"AGENT_BROWSER_SELECTED_EXECUTABLE",executable}};
            // cmd.exe uses its own quote parser, not the CRT argument parser.
            // The command is constant; the selected path is an environment value.
            var result=RunRaw(System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe"),
                "/d /v:off /s /c \"\"%AGENT_BROWSER_SELECTED_EXECUTABLE%\" --version\"",null,env,15000,Encoding.Default);
            if(result.ExitCode!=0) throw new IOException("OpenCode version command failed ("+result.ExitCode+"): "+result.Error);
            return result.Output;
        }
        static CommandResult RunRaw(string executable,string arguments,string directory,IDictionary<string,string> environment,int timeout,Encoding encoding) {
            var info=new ProcessStartInfo(executable, arguments) { UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true, StandardOutputEncoding=encoding??Utf8, StandardErrorEncoding=encoding??Utf8, WorkingDirectory=directory ?? System.IO.Path.GetTempPath() };
            if(environment!=null) foreach(var pair in environment) info.EnvironmentVariables[pair.Key]=pair.Value;
            using(var process=new Process { StartInfo=info }) {
                process.Start(); process.StandardInput.Close();
                Task<string> output=process.StandardOutput.ReadToEndAsync(), error=process.StandardError.ReadToEndAsync();
                if(!process.WaitForExit(timeout)) { process.Kill(); process.WaitForExit(); throw new IOException("The selected command did not finish. No unrelated process was stopped."); }
                return new CommandResult { ExitCode=process.ExitCode, Output=output.Result.Trim(), Error=error.Result.Trim() };
            }
        }
        public static string RunChecked(string executable, IEnumerable<string> arguments, string directory=null, IDictionary<string,string> environment=null, int timeout=15000) {
            var result=Run(executable,arguments,directory,environment,timeout);
            if(result.ExitCode!=0) throw new IOException("Command failed ("+result.ExitCode+"): "+result.Error);
            return result.Output;
        }
        public static WslTarget MapWsl(string path) {
            var m=Regex.Match(path,@"^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.+)$",RegexOptions.IgnoreCase);
            return m.Success ? new WslTarget { Distribution=m.Groups[1].Value, Path="/"+m.Groups[2].Value.Replace('\\','/') } : null;
        }
        public static void PlainPath(string path) {
            for(var current=System.IO.Path.GetFullPath(path); !String.IsNullOrEmpty(current); current=System.IO.Path.GetDirectoryName(current)) {
                if((File.Exists(current)||Directory.Exists(current)) && (File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) throw new IOException("A symbolic link or junction is not supported: "+current);
            }
        }
        public static string SafePath(string root,string relative) {
            if(String.IsNullOrEmpty(relative)||System.IO.Path.IsPathRooted(relative)||Regex.IsMatch(relative,@"[:*?\r\n]")||Array.IndexOf(relative.Replace('\\','/').Split('/'),"..")>=0) throw new IOException("Invalid package-relative path.");
            var path=System.IO.Path.GetFullPath(System.IO.Path.Combine(root,relative));
            if(!path.StartsWith(System.IO.Path.GetFullPath(root).TrimEnd('\\','/')+"\\",StringComparison.OrdinalIgnoreCase)) throw new IOException("A package path escapes its installation folder.");
            PlainPath(path);return path;
        }
        // Runs on the selected WSL filesystem. No PowerShell policy changes,
        // destination truncation, host IP guessing or dependency installation.
        const string WslWrite=@"set -eu
target=$1
temporary=$2
expected=$3
[ ! -L ""$target"" ] && [ ! -L ""$temporary"" ] || { echo 'Settings symlink changed; no settings were overwritten.' >&2; exit 41; }
if [ ""$expected"" = missing ]; then
    [ ! -e ""$target"" ] || { echo 'Settings appeared while preparing; no settings were overwritten.' >&2; exit 42; }
else
    [ -f ""$target"" ] || { echo 'Settings disappeared while preparing; no settings were overwritten.' >&2; exit 43; }
    actual=$(sha256sum -- ""$target"")
    actual=${actual%% *}
    [ ""$actual"" = ""$expected"" ] || { echo 'Settings changed while preparing; no settings were overwritten.' >&2; exit 44; }
    chown --reference=""$target"" -- ""$temporary""
    chmod --reference=""$target"" -- ""$temporary""
fi
mv -fT -- ""$temporary"" ""$target""
";
        public static void WriteAtomic(string path,byte[] bytes,string expected=null,string wslUser=null) {
            PlainPath(path); Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path));
            if(expected==null) expected=File.Exists(path)?FileHash(path):"missing";
            if(expected!="missing"&&!Regex.IsMatch(expected,"^[a-f0-9]{64}$")) throw new IOException("Invalid settings concurrency hash.");
            var temp=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(path),".agent-browser-"+Guid.NewGuid().ToString("N")+".tmp");
            try {
                File.WriteAllBytes(temp,bytes);
                var target=MapWsl(path);
                if(target!=null) {
                    var args=new List<string> { "--distribution",target.Distribution };
                    if(!String.IsNullOrEmpty(wslUser)) { args.Add("--user"); args.Add(wslUser); }
                    args.AddRange(new [] { "--exec","/bin/sh","-c",WslWrite.Replace("\r\n","\n"),"agent-browser-write",target.Path,MapWsl(temp).Path,expected });
                    RunChecked(WslExe,args);
                } else {
                    if((File.Exists(path)?FileHash(path):"missing")!=expected) throw new IOException("Settings changed while preparing; no settings were overwritten.");
                    if(expected=="missing") File.Move(temp,path); else File.Replace(temp,path,null);
                }
            } finally { if(File.Exists(temp)) File.Delete(temp); }
        }
        public static void WriteText(string path,string text,string expected=null,string wslUser=null) { WriteAtomic(path,Utf8.GetBytes(text),expected,wslUser); }
    }
}
