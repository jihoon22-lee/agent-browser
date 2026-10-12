using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace AgentBrowser.Installer {
    internal sealed class ProfileForm : Form {
        readonly InstallState state;readonly ComboBox kind=new ComboBox(),distribution=new ComboBox(),found=new ComboBox();
        readonly TextBox user=new TextBox(),executable=new TextBox(),directory=new TextBox(),name=new TextBox(),profileId=new TextBox(),preview=new TextBox();
        readonly Button discover=new Button(),check=new Button(),save=new Button();Dictionary<string,object> prepared;int revision;bool saving;
        static void Put(Control p,Control c,string id,int x,int y,int w,int h=28){c.Name=id;c.AccessibleName=id;c.SetBounds(x,y,w,h);p.Controls.Add(c);}
        void Row(string title,Control control,string id,int y){Controls.Add(new Label{Text=title,Left=22,Top=y+4,Width=140});Put(this,control,id,170,y,535);}
        public ProfileForm(InstallState installed){
            state=installed;Text="AgentBrowser 관리 OpenCode 프로필";Size=new Size(755,690);StartPosition=FormStartPosition.CenterParent;Font=new Font("Segoe UI",10F);
            Controls.Add(new Label{Text="관리 서버용 프로필을 추가합니다. 일반 CLI의 MCP 등록과 별도입니다.\r\n서버 시작은 Chrome 페어링 후 Options에서 진행합니다.",Left=22,Top=18,Width=700,Height=50});
            Row("프로필 ID",profileId,"ProfileId",80);profileId.Text="managed-"+Guid.NewGuid().ToString("N").Substring(0,8);
            Row("이름",name,"ProfileName",120);name.Text="OpenCode";
            Row("실행 환경",kind,"ProfileKind",160);kind.DropDownStyle=ComboBoxStyle.DropDownList;kind.Items.AddRange(new object[]{"windows","wsl"});kind.SelectedIndex=0;
            Row("WSL 배포판",distribution,"ProfileDistribution",200);Row("WSL 사용자",user,"ProfileUser",240);
            Row("실행 파일",executable,"ProfileExecutable",280);Row("작업 폴더",directory,"ProfileDirectory",320);
            Put(this,found,"ProfileCandidates",170,365,390);found.DropDownStyle=ComboBoxStyle.DropDownList;found.SelectedIndexChanged+=delegate{var c=found.SelectedItem as OpenCodeCandidate;if(c==null)return;kind.SelectedItem=c.Kind;distribution.Text=c.Distribution??"";user.Text=c.User??"";executable.Text=c.Executable;directory.Text=c.Home;};
            discover.Text="후보 찾기";Put(this,discover,"DiscoverProfiles",570,364,135,30);discover.Click+=async delegate{
                if(!discover.Enabled||saving)return;discover.Enabled=false;int current=revision;
                try{var result=await Task.Run(()=>Discovery.Find());if(IsDisposed||Disposing||current!=revision||saving)return;
                    found.Items.Clear();distribution.Items.Clear();foreach(var d in result.Distributions)distribution.Items.Add(d);foreach(var c in result.OpenCode)found.Items.Add(c);
                    if(current==revision&&!saving){preview.Text=String.Join("\r\n",result.Notices);if(found.Items.Count==1)found.SelectedIndex=0;}
                }catch(Exception e){if(!IsDisposed&&!Disposing&&current==revision)preview.Text=e.Message;}
                finally{if(!IsDisposed&&!Disposing)discover.Enabled=!saving;}
            };
            preview.Multiline=true;preview.ReadOnly=true;preview.ScrollBars=ScrollBars.Vertical;Put(this,preview,"ProfilePreview",22,410,683,150);
            check.Text="확인";Put(this,check,"ValidateProfile",415,590,130,32);check.Click+=async delegate{if(!check.Enabled||saving)return;check.Enabled=false;save.Enabled=false;prepared=null;int current=revision;try{
                var candidate=new OpenCodeCandidate{Kind=(string)kind.SelectedItem,Distribution=distribution.Text,User=user.Text,Executable=executable.Text};string work=directory.Text,id=profileId.Text,label=name.Text;
                var result=await Task.Run(()=>ManagedProfile.Prepare(state,candidate,id,label,work));if(IsDisposed||Disposing)return;
                if(current!=revision){preview.Text="입력이 바뀌었습니다. 현재 내용으로 다시 확인하세요.";return;}
                prepared=result;preview.Text="추가할 프로필: "+label+" ("+id+")\r\n환경: "+candidate.Kind+" "+candidate.Distribution+" "+candidate.User+"\r\n실행 파일: "+candidate.Executable+"\r\n작업 폴더: "+work+"\r\n기존 프로필은 수정하지 않습니다. 저장 후 Chrome Options에서 시작하세요.";save.Enabled=true;
            }catch(Exception e){if(!IsDisposed&&!Disposing&&current==revision)preview.Text=e.Message;}finally{if(!IsDisposed&&!Disposing)check.Enabled=true;}};
            save.Text="프로필 저장";Put(this,save,"SaveProfile",565,590,140,32);save.Enabled=false;save.Click+=async delegate{
                if(saving||prepared==null)return;var snapshot=prepared;prepared=null;saving=true;SetInputs(false);save.Enabled=false;check.Enabled=false;discover.Enabled=false;
                try{await Task.Run(()=>ManagedProfile.Save(state,snapshot));preview.Text="프로필을 저장했습니다. Chrome Options에서 선택하고 시작하세요.";}
                catch(Exception e){preview.Text=e.Message;}
                finally{saving=false;SetInputs(true);check.Enabled=true;discover.Enabled=true;}
            };
            var close=new Button{Text="닫기"};Put(this,close,"CloseProfile",22,590,130,32);close.Click+=delegate{Close();};
            foreach(Control field in new Control[]{kind,distribution,user,executable,directory,name,profileId})field.TextChanged+=delegate{revision++;prepared=null;save.Enabled=false;};
            FormClosing+=delegate(object sender,FormClosingEventArgs e){if(saving){e.Cancel=true;preview.Text="프로필 저장을 마칠 때까지 기다려 주세요.";}};
        }
        void SetInputs(bool enabled){foreach(Control field in new Control[]{kind,distribution,user,executable,directory,name,profileId,found})field.Enabled=enabled;}
    }
    internal static class ManagedProfile {
        internal static void ValidateWslPaths(OpenCodeCandidate candidate,string directory) {
            if(String.IsNullOrEmpty(candidate.Executable)||!candidate.Executable.StartsWith("/")||!directory.StartsWith("/")||String.IsNullOrWhiteSpace(candidate.Distribution))throw new IOException("WSL 배포판과 절대 Linux 실행 파일·작업 폴더가 필요합니다.");
        }
        public static Dictionary<string,object> Prepare(InstallState state,OpenCodeCandidate candidate,string id,string name,string directory) {
            if(!System.Text.RegularExpressions.Regex.IsMatch(id??"","^[A-Za-z0-9_-]{1,64}$")||String.IsNullOrWhiteSpace(name))throw new IOException("프로필 ID와 이름을 확인하세요.");
            if(String.IsNullOrWhiteSpace(directory))throw new IOException("작업 폴더를 지정하세요.");
            if(candidate.Kind=="wsl")ValidateWslPaths(candidate,directory);
            var existing=NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new []{"profile","list","--json"}));
            foreach(var item in (System.Collections.IEnumerable)existing["profiles"])if((string)((Dictionary<string,object>)item)["id"]==id)throw new IOException("같은 ID의 프로필이 있습니다. 새 ID를 선택하세요.");
            if(candidate.Kind=="windows"&&candidate.Executable!=null&&candidate.Executable.EndsWith(".cmd",StringComparison.OrdinalIgnoreCase)&&candidate.Executable.IndexOfAny(new[]{'%','!','&','|','<','>','^','"'})>=0)
                throw new IOException("A .cmd launcher path cannot contain cmd metacharacters; select its underlying .exe instead");
            Discovery.Version(candidate);
            if(candidate.Kind=="wsl") {
                var args=new List<string>{"--distribution",candidate.Distribution};if(!String.IsNullOrWhiteSpace(candidate.User))args.AddRange(new []{"--user",candidate.User});args.AddRange(new []{"--exec","/usr/bin/test","-d",directory});NativeIO.RunChecked(NativeIO.WslExe,args);
            } else if(candidate.Kind=="windows") {if(!Path.IsPathRooted(directory)||!Directory.Exists(directory)||!Path.IsPathRooted(candidate.Executable)||!File.Exists(candidate.Executable))throw new IOException("Windows 실행 파일과 작업 폴더를 확인하세요.");}
            else throw new IOException("Windows 또는 WSL을 선택하세요.");
            var profile=new Dictionary<string,object>{{"id",id},{"name",name},{"kind",candidate.Kind},{"executable",candidate.Executable},{"directory",directory}};
            if(candidate.Kind=="wsl"){profile.Add("distribution",candidate.Distribution);if(!String.IsNullOrWhiteSpace(candidate.User))profile.Add("user",candidate.User);}
            return profile;
        }
        public static void Save(InstallState state,Dictionary<string,object> profile) {
            if(profile==null)throw new IOException("변경 내용을 먼저 확인하세요.");
            // Recheck the profile id directly before the ordinary Bridge save.
            var existing=NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new []{"profile","list","--json"}));
            foreach(var item in (System.Collections.IEnumerable)existing["profiles"])if((string)((Dictionary<string,object>)item)["id"]==(string)profile["id"])throw new IOException("프로필이 이미 생겼습니다. 기존 프로필은 변경하지 않았습니다.");
            string path=Path.Combine(state.DataDir,".installer-profile-"+Guid.NewGuid().ToString("N")+".json");
            try{NativeIO.WriteText(path,NativeIO.Json.Serialize(profile),"missing");BridgeControl.Invoke(state,new []{"profile","save","--file",path,"--create-only"});}
            finally{if(File.Exists(path))File.Delete(path);}
        }
    }
}

