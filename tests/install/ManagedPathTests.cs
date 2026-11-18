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

                // An organization folder can let the user create, change and delete files but not change permissions.
                // Modify has no "change permissions" right, and the OWNER RIGHTS entry takes away the owner's implicit one.
                string locked = Path.Combine(parent, "no-permission-change"), lockedRoot = Path.Combine(locked, "install");
                Directory.CreateDirectory(locked);
                var policy = new DirectorySecurity();
                policy.SetAccessRuleProtection(true, false);
                foreach (var sid in new [] { WindowsIdentity.GetCurrent().User, new SecurityIdentifier("S-1-3-4") })
                    policy.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.Modify, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.SetAccessControl(locked, policy);
                string probe = Path.Combine(locked, "probe"); Directory.CreateDirectory(probe);
                bool refused = false;
                try { var changed = Directory.GetAccessControl(probe); changed.SetAccessRuleProtection(true, true); Directory.SetAccessControl(probe, changed); }
                catch (UnauthorizedAccessException) { refused = true; }
                Directory.Delete(probe);
                Assert(refused, "Fixture error: this folder still lets the user change permissions");
                listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
                listener.Start(); port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
                string lockedAcl = Acl(locked);
                // Replacing an existing file must not depend on copying its permissions.
                string replaced = Path.Combine(locked, "replaced.json");
                NativeIO.WriteAtomic(replaced, NativeIO.Utf8.GetBytes("first"));
                NativeIO.WriteAtomic(replaced, NativeIO.Utf8.GetBytes("second"));
                Assert(File.ReadAllText(replaced) == "second", "An existing file was not replaced in a folder that refuses permission changes");
                File.Delete(replaced);
                options = new SetupOptions { PackageDir = args[1], InstallDir = lockedRoot, Start = true, Startup = false, Port = port };
                InstallerEngine.Apply(InstallerEngine.Prepare(options), CancellationToken.None, s => {});
                var lockedState = InstallerEngine.State(lockedRoot);
                Assert(lockedState != null && Running(lockedState), "Bridge did not start in a folder that refuses permission changes");
                File.WriteAllText(Path.Combine(lockedRoot, "data", "preserved.txt"), "synthetic user data");
                InstallerEngine.Apply(InstallerEngine.Prepare(options), CancellationToken.None, s => {});
                Assert(InstallerEngine.State(lockedRoot).InstallId == lockedState.InstallId, "Reinstall changed identity in a folder that refuses permission changes");
                InstallerEngine.Apply(InstallerEngine.Prepare(new SetupOptions { Operation = "uninstall", InstallDir = lockedRoot }), CancellationToken.None, s => {});
                Assert(InstallerEngine.State(lockedRoot) == null, "Uninstall left the installation record in a folder that refuses permission changes");
                Assert(File.ReadAllText(Path.Combine(lockedRoot, "data", "preserved.txt")) == "synthetic user data", "Uninstall removed retained data");
                Assert(Directory.GetDirectories(lockedRoot, ".transaction-*").Length == 0, "A transaction folder was left behind");
                Assert(Acl(locked) == lockedAcl, "Installer changed the folder's ACL");
                Console.WriteLine("PASS install/start/reinstall/remove in a folder that refuses permission changes");
                return 0;
            } catch (Exception error) { Console.Error.WriteLine(error.GetType().Name + ": " + error.Message); Console.Error.WriteLine(error.StackTrace); return 1; }
        }
    }
}
