"""Run only the MCP command from this test's isolated managed OpenCode runtime."""
import base64
import json
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request

home = Path(sys.argv[1])
runtime = json.loads((home / 'runtime.json').read_text())
record = runtime['runtimes']['iframe-wsl']
profile = runtime['profiles']['iframe-wsl']
auth = base64.b64encode((record['username'] + ':' + record['password']).encode()).decode()
url = record['baseUrl'] + '/config?' + urllib.parse.urlencode({'directory': profile['directory']})
with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': 'Basic ' + auth}), timeout=10) as response:
    mcp = json.load(response)['mcp']['browser']
env = os.environ.copy()
env.update(mcp['environment'])
assert env['WSL_INTEROP'] == record['wslKeeper']['socket']
os.chdir(profile['directory'])
os.execvpe(mcp['command'][0], mcp['command'], env)
