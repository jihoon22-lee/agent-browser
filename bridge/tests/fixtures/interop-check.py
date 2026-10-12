"""Owned runtime fault/stdio checks only. Output excludes credentials and config."""
import base64, json, os, pathlib, selectors, signal, socket, subprocess, sys, tempfile, time, urllib.request, urllib.parse

home = pathlib.Path(sys.argv[2])
runtime_config = json.loads((home / 'runtime.json').read_text())
record = runtime_config['runtimes']['wsl']
profile = runtime_config['profiles']['wsl']
keeper = record['wslKeeper']
mode = sys.argv[1]

def mapped(path):
    return '/mnt/' + path[0].lower() + path[2:].replace('\\', '/')

def own_identity(path):
    pid, ticks, nonce, boot = pathlib.Path(path).read_text().split()
    assert nonce == record['instance'] and boot == pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    stat = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    assert ticks == stat[19] and pid == stat[2] and int(pid) > 2 and stat[0] != 'Z'
    variables = pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    assert ('AGENT_BROWSER_RUNTIME_ID=' + nonce).encode() in variables
    return int(pid)

def config():
    auth = base64.b64encode((record['username'] + ':' + record['password']).encode()).decode()
    url = record['baseUrl'] + '/config?' + urllib.parse.urlencode({'directory':profile['directory']})
    with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': 'Basic ' + auth}), timeout=10) as response:
        return json.load(response)['mcp']['browser']

def protocol():
    own_identity(keeper['ownerFile'])
    env = os.environ.copy()
    env['WSL_INTEROP'] = keeper['socket']
    probe = subprocess.run([mapped(record['bridgeExecutable']), '--version'], env=env, capture_output=True, timeout=8)
    assert probe.returncode == 0 and probe.stdout.startswith(b'browser-bridge ')
    print(json.dumps({'stage': 'keeper-socket-windows-canary', 'ok': True, 'version':probe.stdout.decode().strip()}), flush=True)
    mcp = config()
    assert mcp['environment']['WSL_INTEROP'] == keeper['socket']
    env.update(mcp['environment'])
    child = subprocess.Popen(mcp['command'], cwd=mcp.get('cwd',profile['directory']), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    poll = selectors.DefaultSelector(); poll.register(child.stdout, selectors.EVENT_READ)
    def send(value):
        child.stdin.write(json.dumps(value).encode() + b'\n'); child.stdin.flush()
    def receive(request_id):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            assert poll.select(max(0, deadline-time.monotonic())), 'MCP response timeout'
            line = child.stdout.readline(); assert line, 'MCP exited before response'
            message = json.loads(line)
            if message.get('id') == request_id: return message
        raise AssertionError('MCP response timeout')
    try:
        send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'isolated-interop-fixture','version':'1'}}})
        initialized=receive(1)['result']; assert 'serverInfo' in initialized
        print(json.dumps({'stage':'native-bridge-mcp-initialize','ok':True,'protocolVersion':initialized['protocolVersion'],'serverInfo':initialized['serverInfo']}),flush=True)
        send({'jsonrpc':'2.0','method':'notifications/initialized'})
        began=time.monotonic()
        send({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'browser_tabs','arguments':{'action':'list'}}})
        response=receive(2)
        assert not response['result'].get('isError',False), 'First synthetic tool returned an error'
        assert 'interop-synthetic' in json.dumps(response), 'Synthetic extension did not answer the first tool'
        print(json.dumps({'stage':'first-tool-synthetic-extension-response','ok':True,'tool':'browser_tabs','requestId':2,'isError':False,'syntheticTitle':'interop-synthetic','elapsedMs':round((time.monotonic()-began)*1000)}),flush=True)
    finally:
        child.stdin.close()
        try: child.wait(timeout=5)
        except subprocess.TimeoutExpired: child.terminate(); child.wait(timeout=5)
        poll.close()

if mode == 'protocol':
    protocol()
elif mode == 'kill-keeper':
    pid=own_identity(keeper['ownerFile'])
    os.killpg(pid,signal.SIGTERM)
    print(json.dumps({'stage':'owned-keeper-terminated','pid':pid,'ok':True}))
elif mode == 'kill-server-leader':
    pid=own_identity(record['wslOwnerFile'])
    os.kill(pid,signal.SIGKILL)
    print(json.dumps({'stage':'owned-server-leader-killed-child-left-for-stop','pid':pid,'ok':True}))
elif mode == 'profile-env':
    pid=own_identity(record['wslOwnerFile'])
    variables=pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    assert b'AB_PROFILE_SENTINEL=kept Korean value' in variables
    assert pathlib.Path(f'/proc/{pid}/cwd').resolve() == pathlib.Path(profile['directory']).resolve()
    print(json.dumps({'stage':'profile-environment-and-working-directory-preserved','ok':True}))
elif mode == 'faults':
    own_identity(keeper['ownerFile'])
    mcp=config(); env=os.environ.copy(); env.update(mcp['environment'])
    missing=list(mcp['command']); missing[6]='/run/WSL/2147483647_interop'
    result=subprocess.run(missing,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=4)
    assert result.returncode != 0 and not result.stdout
    print(json.dumps({'stage':'missing-socket-refused-before-native-launch','ok':True}),flush=True)
    # A private socket accepts no protocol handshake. Never touch /run/WSL sockets.
    with tempfile.TemporaryDirectory(prefix='ab-interop-stall-') as directory:
        path=directory+'/interop'; stalled=socket.socket(socket.AF_UNIX); stalled.bind(path); stalled.listen(4)
        env['WSL_INTEROP']=path
        source=(pathlib.Path(__file__).parents[2]/'src/runtime/interop.rs').read_text()
        function=source.split('const CANARY_FUNCTION: &str = r#"',1)[1].split('"#;',1)[0]
        began=time.monotonic()
        result=subprocess.run(['/bin/sh','-c',function+'\nprobe_windows "$1"','fixture',mapped(record['bridgeExecutable'])],env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=16)
        elapsed=time.monotonic()-began; stalled.close()
        assert result.returncode != 0 and elapsed < 16
        print(json.dumps({'stage':'stalled-socket-canary-deadline','ok':True,'elapsedSeconds':round(elapsed,2)}),flush=True)
else:
    raise AssertionError('Unknown isolated check')
