using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;

namespace AgentBrowser.Installer {
    internal static class ManagedPathTests {
        static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
        static string Acl(string path) { return Directory.GetAccessControl(path).GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner | AccessControlSections.Group); }
        static bool Running(InstallState state) { return NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(BridgeControl.Invoke(state, new [] { "status", "--json" })).ContainsKey("browsers"); }
        public static int Main(string[] args) {
            try {
                // A managed owner is not a reason to reject an otherwise writable path.
                var descriptor = new DirectorySecurity();
                var owner = new SecurityIdentifier("S-1-5-21-1-2-3-1001");
                descriptor.SetOwner(owner);
                descriptor.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, AccessControlType.Allow));
                var secured = InstallerEngine.PrivateAcl(descriptor);
                Assert(secured.GetOwner(typeof(SecurityIdentifier)).Value == owner.Value, "Data protection changed the owner");
                Console.WriteLine("PASS managed owner does not block data ACL preparation");

                string parent = args[0], root = Path.Combine(parent, "install");
                Directory.CreateDirectory(parent);
                var acl = Directory.GetAccessControl(parent);
                acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"), FileSystemRights.Modify, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.SetAccessControl(parent, acl);
                Directory.CreateDirectory(root);
                string parentAcl = Acl(parent), rootAcl = Acl(root);
                var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
                listener.Start(); int port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
                var options = new SetupOptions { PackageDir = args[1], InstallDir = root, Start = true, Startup = false, Port = port };
                InstallerEngine.Apply(InstallerEngine.Prepare(options), CancellationToken.None, s => {});
                var first = InstallerEngine.State(root);
                Assert(Running(first), "Managed path Bridge did not start");
                File.WriteAllText(Path.Combine(root, "data", "preserved.txt"), "synthetic user data");
                InstallerEngine.Apply(InstallerEngine.Prepare(options), CancellationToken.None, s => {});
                Assert(InstallerEngine.State(root).InstallId == first.InstallId, "Reinstall changed identity");
                Assert(Running(InstallerEngine.State(root)), "Reinstall did not preserve a running Bridge");
                Assert(File.ReadAllText(Path.Combine(root, "data", "preserved.txt")) == "synthetic user data", "Reinstall changed data");
                Assert(Acl(parent) == parentAcl && Acl(root) == rootAcl, "Installer changed managed folder ACLs");
                InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions { Operation = "uninstall", InstallDir = root }), CancellationToken.None, s => {});
                Assert(InstallerEngine.State(root) == null, "Uninstall left the installation record");
                Assert(File.Exists(Path.Combine(root, "data", "preserved.txt")), "Uninstall removed retained data");
                Assert(Acl(parent) == parentAcl && Acl(root) == rootAcl, "Uninstall changed managed folder ACLs");
                Console.WriteLine("PASS managed path install/start/reinstall/remove preserves directory ACLs and user data");
                return 0;
            } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
    }
}
