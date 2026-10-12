using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;

namespace AgentBrowser.Installer {
    // Assign the suspended launcher before it can spawn serve. The job disallows
    // breakaway, so Bridge's existing detached fallback stays in this owned tree.
    // Failed startup can terminate that tree even when PID publication or WMI fails.
    internal sealed class BridgeStartJob : IDisposable {
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
            public int Size;public string Reserved,Desktop,Title;public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags;public ushort Show,ReservedSize;public IntPtr ReservedBytes,Input,Output,Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct Created {public IntPtr Process,Thread;public uint Pid,Tid;}
        [StructLayout(LayoutKind.Sequential)] struct Accounting {public long User,Kernel,PeriodUser,PeriodKernel;public uint Faults,Total,Active,Terminated;}
        [StructLayout(LayoutKind.Sequential)] struct Limits {public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinimumWorkingSet,MaximumWorkingSet;public uint ActiveProcesses;public UIntPtr Affinity;public uint Priority,Scheduling;}
        [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong Reads,Writes,Other,ReadBytes,WriteBytes,OtherBytes;}
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {public Limits Basic;public IoCounters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,string environment,string directory,ref Startup startup,out Created created);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting data,int length,IntPtr returned);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits data,int length);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        IntPtr job,launcher;bool committed;
        static IOException Error(string operation){return new IOException(operation+": "+new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);}
        public BridgeStartJob(string executable,string directory,IDictionary<string,string> environment,int port) {
            job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Error("Cannot create owned Bridge startup job");
            Created child=new Created();bool assigned=false;
            try {
                StartupLimit(true);
                var values=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
                foreach(System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())values[(string)entry.Key]=(string)entry.Value;
                foreach(var entry in environment)values[entry.Key]=entry.Value;
                var block=new StringBuilder();foreach(var entry in values)block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');block.Append('\0');
                var startup=new Startup{Size=Marshal.SizeOf(typeof(Startup))};
                if(!CreateProcess(executable,new StringBuilder(NativeIO.Quote(executable)+" start --port "+port),IntPtr.Zero,IntPtr.Zero,false,0x08000404,block.ToString(),directory,ref startup,out child))throw Error("Cannot create Bridge launcher");
                launcher=child.Process;
                if(!AssignProcessToJobObject(job,launcher))throw Error("Cannot own Bridge launcher");assigned=true;
                if(ResumeThread(child.Thread)==UInt32.MaxValue)throw Error("Cannot resume Bridge launcher");
            } catch {
                if(child.Process!=IntPtr.Zero&&!assigned){TerminateProcess(child.Process,1);WaitForSingleObject(child.Process,5000);}
                Dispose();throw;
            } finally {if(child.Thread!=IntPtr.Zero)CloseHandle(child.Thread);}
        }
        public void Wait() {
            if(WaitForSingleObject(launcher,20000)!=0)throw new IOException("Owned Bridge startup did not finish.");
            uint code;if(!GetExitCodeProcess(launcher,out code))throw Error("Cannot read Bridge startup result");
            if(code!=0)throw new IOException("Owned Bridge startup failed ("+code+").");
        }
        public void RequireChild(int pid) {
            using(var process=Process.GetProcessById(pid)) {bool inside;if(!IsProcessInJob(process.Handle,job,out inside))throw Error("Cannot verify startup child ownership");if(!inside||process.HasExited)throw new IOException("Bridge PID does not belong to this startup.");}
        }
        void StartupLimit(bool killOnClose) {
            // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE remains set until the owner marker is saved.
            var limits=new ExtendedLimits{Basic=new Limits{Flags=killOnClose?0x2000u:0u}};
            if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimits))))throw Error("Cannot configure owned startup lifetime");
        }
        public void Commit(){StartupLimit(false);committed=true;}
        public void Dispose() {
            try {
                if(job!=IntPtr.Zero&&!committed) {
                    if(!TerminateJobObject(job,1))throw Error("Cannot stop owned startup processes");
                    var timer=Stopwatch.StartNew();for(;;){Accounting data;if(!QueryInformationJobObject(job,1,out data,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw Error("Cannot verify startup cleanup");if(data.Active==0)break;if(timer.ElapsedMilliseconds>5000)throw new IOException("Owned startup cleanup did not finish.");System.Threading.Thread.Sleep(25);}
                }
            } finally {if(launcher!=IntPtr.Zero){CloseHandle(launcher);launcher=IntPtr.Zero;}if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}}
        }
    }
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
        [StructLayout(LayoutKind.Sequential)] struct Disposition { public byte DeleteFile; }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle file,int kind,ref Disposition information,int size);
        public static void DeleteExpected(string path,string expected,string wslUser=null) {
            PlainPath(path);
            if(expected!="missing"&&!Regex.IsMatch(expected??"","^[a-f0-9]{64}$"))throw new IOException("Invalid settings concurrency hash.");
            var target=MapWsl(path);
            if(target!=null) {
                var args=new List<string>{"--distribution",target.Distribution};
                if(!String.IsNullOrEmpty(wslUser)){args.Add("--user");args.Add(wslUser);}
                const string script=@"set -eu
target=$1
expected=$2
[ ! -L ""$target"" ] || { echo 'Settings symlink changed; no settings were removed.' >&2; exit 41; }
if [ ""$expected"" = missing ]; then
    [ ! -e ""$target"" ] || { echo 'Settings appeared; no settings were removed.' >&2; exit 42; }
else
    [ -f ""$target"" ] || { echo 'Settings disappeared; no settings were removed.' >&2; exit 43; }
    actual=$(sha256sum -- ""$target"")
    actual=${actual%% *}
    [ ""$actual"" = ""$expected"" ] || { echo 'Settings changed; no settings were removed.' >&2; exit 44; }
    rm -- ""$target""
fi
";
                args.AddRange(new[]{"--exec","/bin/sh","-c",script.Replace("\r\n","\n"),"agent-browser-delete",target.Path,expected});RunChecked(WslExe,args);return;
            }
            // Keep writers and replacers excluded from the hash through deletion.
            // DELETE + GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING, OPEN_REPARSE_POINT.
            using(var handle=CreateFile(path,0x80010000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
                if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();if(expected=="missing"&&(error==2||error==3))return;throw new IOException("Cannot safely remove file: "+path,new System.ComponentModel.Win32Exception(error));}
                using(var stream=new FileStream(handle,FileAccess.Read))using(var hash=SHA256.Create()) {
                    string actual=BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
                    if(actual!=expected)throw new IOException("A concurrently changed file was preserved: "+path);
                    var disposition=new Disposition{DeleteFile=1};
                    if(!SetFileInformationByHandle(handle,4,ref disposition,Marshal.SizeOf(typeof(Disposition))))throw new IOException("Cannot remove verified file: "+path,new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
                }
            }
        }
        public static void WriteText(string path,string text,string expected=null,string wslUser=null) { WriteAtomic(path,Utf8.GetBytes(text),expected,wslUser); }
    }
}
