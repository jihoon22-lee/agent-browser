using System;
using System.IO;
using System.Linq;
namespace AgentBrowser.Installer {
    internal static class NativeCoreTests {
        static void Assert(bool value,string message) { if(!value) throw new Exception(message); }
        public static int Main(string[] args) {
            string root=Path.Combine(Path.GetTempPath(),"AgentBrowser-native-test-"+Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try {
                var shim=Path.Combine(root,"한글 & space.cmd");
                File.WriteAllText(shim,"@echo off\r\nif not \"%~1\"==\"--version\" exit /b 8\r\necho 1.18.29\r\n",NativeIO.Utf8);
                Assert(Discovery.Version(new OpenCodeCandidate{Kind="windows",Executable=shim})=="1.18.29","cmd version probe failed");
                Console.WriteLine("PASS native cmd probe with Unicode, spaces and ampersand");
                var found=Discovery.Find();
                Console.WriteLine("DISCOVERY "+NativeIO.Json.Serialize(new {Installs=found.Installs.Count,Distributions=found.Distributions,OpenCode=found.OpenCode.Select(c=>new {c.Kind,c.Distribution,c.User,c.Version,c.Error,SettingsCount=c.Settings.Count}).ToArray(),Notices=found.Notices}));
                if(args.Length>0) {var selected=found.OpenCode.FirstOrDefault(c=>c.Kind=="wsl"&&c.Distribution==args[0]);Assert(selected!=null&&selected.Version==null&&selected.Error==null,"expected unprobed WSL candidate not found");Assert(Discovery.Version(selected)=="1.18.29","explicit selected-candidate version probe failed");}
                Console.WriteLine("PASS native discovery smoke test");
                return 0;
            } catch(Exception error) { Console.Error.WriteLine(error);return 1; }
            finally { foreach(var file in Directory.GetFiles(root)) File.Delete(file); Directory.Delete(root); }
        }
    }
}
