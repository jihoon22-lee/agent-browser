using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace AgentBrowser.Installer {
    internal static class ManagedProfile {
        internal static void ValidateWslPaths(OpenCodeCandidate candidate,string directory) {
            if(String.IsNullOrEmpty(candidate.Executable)||!candidate.Executable.StartsWith("/")||!directory.StartsWith("/")||String.IsNullOrWhiteSpace(candidate.Distribution))throw new IOException("WSL 배포판과 절대 Linux 실행 파일·작업 폴더가 필요합니다.");
        }
        public static Dictionary<string,object> Prepare(InstallState state,OpenCodeCandidate candidate,string id,string name,string directory,bool replace=false) {
            if(!System.Text.RegularExpressions.Regex.IsMatch(id??"","^[A-Za-z0-9_-]{1,64}$")||String.IsNullOrWhiteSpace(name))throw new IOException("프로필 ID와 이름을 확인하세요.");
            if(String.IsNullOrWhiteSpace(directory))throw new IOException("작업 폴더를 지정하세요.");
            if(candidate.Kind=="wsl")ValidateWslPaths(candidate,directory);
            else if(candidate.Kind=="windows") {if(!Discovery.IsPlainLocalPath(candidate.Executable,false)||!Discovery.IsPlainLocalPath(directory,true))throw new IOException("Windows 실행 파일과 작업 폴더는 심볼릭 링크가 없는 로컬 절대 경로여야 합니다.");}
            else throw new IOException("Windows 또는 WSL을 선택하세요.");
            var existing=NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new []{"profile","list","--json"}));
            if(!replace)foreach(var item in (System.Collections.IEnumerable)existing["profiles"])if((string)((Dictionary<string,object>)item)["id"]==id)throw new IOException("같은 ID의 프로필이 있습니다. 새 ID를 선택하세요.");
            if(candidate.Kind=="windows"&&candidate.Executable!=null&&candidate.Executable.EndsWith(".cmd",StringComparison.OrdinalIgnoreCase)&&candidate.Executable.IndexOfAny(new[]{'%','!','&','|','<','>','^','"'})>=0)
                throw new IOException("A .cmd launcher path cannot contain cmd metacharacters; select its underlying .exe instead");
            Discovery.Version(candidate);
            if(candidate.Kind=="wsl") {
                var args=new List<string>{"--distribution",candidate.Distribution};if(!String.IsNullOrWhiteSpace(candidate.User))args.AddRange(new []{"--user",candidate.User});args.AddRange(new []{"--exec","/usr/bin/test","-d",directory});NativeIO.RunChecked(NativeIO.WslExe,args);
            }
            var profile=new Dictionary<string,object>{{"id",id},{"name",name},{"kind",candidate.Kind},{"executable",candidate.Executable},{"directory",directory}};
            if(candidate.Kind=="wsl"){profile.Add("distribution",candidate.Distribution);if(!String.IsNullOrWhiteSpace(candidate.User))profile.Add("user",candidate.User);}
            return profile;
        }
        /// replace=true rewrites the profile this wizard page saved earlier instead of adding another.
        public static void Save(InstallState state,Dictionary<string,object> profile,bool makeDefault=false,bool replace=false) {
            if(profile==null)throw new IOException("변경 내용을 먼저 확인하세요.");
            // Recheck the profile id directly before the ordinary Bridge save.
            if(!replace){var existing=NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new []{"profile","list","--json"}));
            foreach(var item in (System.Collections.IEnumerable)existing["profiles"])if((string)((Dictionary<string,object>)item)["id"]==(string)profile["id"])throw new IOException("프로필이 이미 생겼습니다. 기존 프로필은 변경하지 않았습니다.");}
            string path=Path.Combine(state.DataDir,".installer-profile-"+Guid.NewGuid().ToString("N")+".json");
            var args=new List<string>{"profile","save","--file",path};if(!replace)args.Add("--create-only");if(makeDefault)args.Add("--default");
            try{NativeIO.WriteText(path,NativeIO.Json.Serialize(profile),"missing");BridgeControl.Invoke(state,args.ToArray());}
            finally{if(File.Exists(path))File.Delete(path);}
        }
        /// Starts the managed runtime once and reports the result in words a user can act on.
        public static string Start(InstallState state,string id) {
            var run=BridgeControl.Run(state,new []{"runtime","start","--profile",id},90000);
            Dictionary<string,object> result=null;try{result=NativeIO.Json.Deserialize<Dictionary<string,object>>(run.Output);}catch(Exception){/* Failures before startup print no JSON. */}
            object stateValue=null,version=null,error=null;if(result!=null){result.TryGetValue("state",out stateValue);result.TryGetValue("version",out version);result.TryGetValue("error",out error);}
            if(run.ExitCode==0&&stateValue as string=="ready")return "✓ 저장했습니다. OpenCode "+(version as string)+"가 시작됐고 브라우저 도구 연결을 확인했습니다.";
            string reason=error as string??(String.IsNullOrEmpty(run.Error)?"상태: "+(stateValue as string??"알 수 없음"):run.Error);
            string friendly=Friendly.Message(new IOException(reason));
            return "저장했지만 OpenCode를 시작하지 못했습니다.\r\n"+(friendly==reason?"실행 파일·작업 폴더를 확인한 뒤 [저장하고 연결 확인]을 다시 누르거나, Chrome 설정의 [시작·연결 확인]으로 재시도하세요.\r\n(원문: "+reason+")":friendly);
        }
    }
}

