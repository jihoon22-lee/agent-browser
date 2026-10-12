#!/usr/bin/env python3
"""Package existing AgentBrowser Windows build outputs without PowerShell."""
import argparse, hashlib, json, pathlib, re, shutil, struct, subprocess, tempfile, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def win(path): return subprocess.check_output(["wslpath","-w",str(path.resolve())],text=True).strip()
def main():
    p=argparse.ArgumentParser()
    for name in ["bridge","extension","notices","out"]: p.add_argument("--"+name,type=pathlib.Path,required=True)
    a=p.parse_args();version=re.search(r'^version\s*=\s*"([^"]+)"',(ROOT/"Cargo.toml").read_text(),re.M)[1]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?",version): raise ValueError("Invalid version")
    inventory=json.loads((a.notices/"third-party-inventory.json").read_text(encoding="utf-8-sig"))
    for key,rel in [("cargoLockSha256","Cargo.lock"),("pnpmLockSha256","pnpm-lock.yaml"),("extensionPackageSha256","extension/package.json"),("assetsManifestSha256","scripts/licenses/assets.json")]:
        if inventory[key]!=sha(ROOT/rel): raise ValueError("Stale license inventory: "+rel)
    for path in [a.bridge,a.extension,a.notices,a.out]:
        if any(part.is_symlink() for part in [path,*path.parents]): raise ValueError("Symbolic link in release input/output")
    a.out.mkdir(parents=True,exist_ok=True);target=a.out/("agent-browser-"+version+"-windows-x64.zip")
    if target.exists(): raise ValueError("Output exists; choose a new local output directory")
    with tempfile.TemporaryDirectory(prefix=".package-",dir=a.out) as folder:
        stage=pathlib.Path(folder)
        def copy(source,rel):
            if source.is_symlink() or not source.is_file(): raise ValueError("Nonregular package input: "+str(source))
            dest=stage/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,dest)
        copy(a.bridge,"browser-bridge.exe")
        binary=stage/"browser-bridge.exe";data=binary.read_bytes();offset=struct.unpack_from("<I",data,60)[0]
        if data[:2]!=b"MZ" or data[offset:offset+4]!=b"PE\0\0" or struct.unpack_from("<H",data,offset+4)[0]!=0x8664: raise ValueError("Not Windows x64 PE")
        if subprocess.check_output([str(binary.resolve()),"--version"],text=True).strip()!="browser-bridge "+version: raise ValueError("Bridge version mismatch")
        sources=[ROOT/"installer"/name for name in ["NativeIO.cs","Discovery.cs","Jsonc.cs","InstallerEngine.cs","ProfileForm.cs","SetupForm.cs"]]
        compiler=pathlib.Path("/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe")
        cache=ROOT/"target/installer";cache.mkdir(parents=True,exist_ok=True);gui=cache/"AgentBrowser-Setup.exe";stamp=cache/"build.json"
        fingerprint=hashlib.sha256((sha(compiler)+"\n"+"\n".join(sha(source) for source in sources)).encode()).hexdigest()
        previous=json.loads(stamp.read_text()) if stamp.exists() else {}
        if not gui.exists() or previous.get("source")!=fingerprint or previous.get("binary")!=sha(gui):
            subprocess.run([str(compiler),"/nologo","/codepage:65001","/target:winexe","/platform:x64","/optimize+","/out:"+win(gui),*["/r:"+name for name in ["System.Web.Extensions.dll","System.Core.dll","System.Management.dll","System.Windows.Forms.dll","System.Drawing.dll"]],*map(win,sources)],check=True)
            stamp.write_text(json.dumps({"source":fingerprint,"binary":sha(gui)}))
        copy(gui,"AgentBrowser-Setup.exe")
        allowed=re.compile(r"^(?:manifest\.json|(?:background|content|options|sidepanel)\.js|src/(?:options|sidepanel)/index\.html|(?:assets|chunks)/[^\r\n]+)$")
        for path in sorted(a.extension.rglob("*")):
            if path.is_symlink(): raise ValueError("Symlink in extension")
            if path.is_dir(): continue
            rel=path.relative_to(a.extension).as_posix()
            if not allowed.fullmatch(rel) or path.suffix not in [".js",".css",".html",".json",".png",".svg",".webp",".woff",".woff2",".ico"] or (path.suffix==".json" and rel!="manifest.json"): raise ValueError("Unexpected extension artifact: "+rel)
            copy(path,"extension/"+rel)
        extension=json.loads((stage/"extension/manifest.json").read_text())
        if extension["manifest_version"]!=3 or not extension.get("key"): raise ValueError("Keyed MV3 extension required")
        for name in ["setup.ps1","uninstall.ps1","installer-common.ps1","start-bridge.ps1","start-bridge.cmd","show-pairing.ps1"]: copy(ROOT/"scripts"/name,name)
        for name in ["README-install.md","CHANGELOG.md","LICENSE","SECURITY.md","docs/user-guide.md","docs/troubleshooting.md"]: copy(ROOT/name,name)
        for name in ["THIRD_PARTY_NOTICES","third-party-inventory.json"]: copy(a.notices/name,name)
        for name in ["profile-windows.json.template","profile-wsl.json.template","mcp-windows.json.template","mcp-wsl.json.template"]: copy(ROOT/"examples"/name,"examples/"+name)
        files=[{"Path":x.relative_to(stage).as_posix(),"Sha256":sha(x)} for x in sorted(stage.rglob("*")) if x.is_file()]
        (stage/"package-manifest.json").write_text(json.dumps({"Product":"agent-browser","Version":version,"Platform":"windows-x64","Files":files},indent=2)+"\n",encoding="utf-8")
        with zipfile.ZipFile(target,"x",compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    info=zipfile.ZipInfo(path.relative_to(stage).as_posix(),(2000,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;archive.writestr(info,path.read_bytes())
    digest=sha(target);(a.out/"SHA256SUMS").write_text(digest+"  "+target.name+"\n",encoding="ascii")
    print(json.dumps({"package":str(target),"sha256":digest,"files":len(files)+1}))
if __name__=="__main__": main()

