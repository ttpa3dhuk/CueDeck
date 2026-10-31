"""Mini-owned release runner and launchd polling entry point. No AI calls."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

from cdp import CDP, read_json, target
from fixtures import create
from suite import Suite, REQUIRED, LIMITS

HERE = Path(__file__).resolve().parent


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temporary.replace(path)


def command(args, timeout=30):
    result = subprocess.run([str(a) for a in args], stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr[-1600:]} {result.stdout[-600:]}')
    return result.stdout


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def release_info(repository, tag=None):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid repository')
    if tag and not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError('Expected stable vX.Y.Z tag')
    suffix = 'tags/'+tag if tag else 'latest'
    request = urllib.request.Request(f'https://api.github.com/repos/{repository}/releases/{suffix}',
                                     headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'CueDeck-release-QA'})
    release = read_json(request, timeout=20)
    if release.get('draft') or release.get('prerelease') or not re.fullmatch(r'v\d+\.\d+\.\d+', release.get('tag_name', '')):
        raise ValueError('Only published stable releases are accepted')
    return release


def verified_asset(release, name, cache):
    matches = [a for a in release['assets'] if a['name'] == name and a.get('state') == 'uploaded']
    if len(matches) != 1:
        raise RuntimeError('Missing or ambiguous release asset: '+name)
    asset = matches[0]
    digest = asset.get('digest') or ''
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        raise RuntimeError('GitHub did not supply an asset SHA256: '+name)
    expected = digest[7:]
    path = cache / name
    if not path.exists() or path.stat().st_size != asset['size'] or sha(path) != expected:
        request = urllib.request.Request(asset['browser_download_url'], headers={'User-Agent': 'CueDeck-release-QA'})
        temporary = path.with_suffix('.partial')
        try:
            with urllib.request.urlopen(request, timeout=90) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output)
            if temporary.stat().st_size != asset['size'] or sha(temporary) != expected:
                raise RuntimeError('Release asset size/SHA256 mismatch: '+name)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    with zipfile.ZipFile(path) as archive:
        if archive.testzip():
            raise RuntimeError('ZIP CRC failed: '+name)
        payload = {}
        for key, suffix in [('asarSha256', 'resources/app.asar'), ('executableSha256', 'CueDeck.exe' if '-win.' in name else 'Contents/MacOS/CueDeck')]:
            members = [n for n in archive.namelist() if n.lower().endswith(suffix.lower())]
            if len(members) != 1:
                raise RuntimeError('Missing/ambiguous ZIP member: '+suffix)
            with archive.open(members[0]) as source:
                digest_object = hashlib.sha256()
                for chunk in iter(lambda: source.read(1024*1024), b''):
                    digest_object.update(chunk)
                payload[key] = digest_object.hexdigest()
    return {**payload, 'asset': name, 'assetSha256': expected, 'assetBytes': asset['size']}


def installed_matches(installed, artifact, version):
    return installed.get('version') == version and all(installed.get(k) == artifact.get(k) for k in ('asarSha256', 'executableSha256'))


class Controller:
    def __init__(self, config):
        self.config = config
        self.root = Path(config['root']).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.host = config['windowsHost']
        if not re.fullmatch(r'[a-zA-Z0-9_.-]+', self.host):
            raise ValueError('Expected a configured SSH alias')
        self.remote = config['windowsRoot'].replace('\\', '/')
        if not re.fullmatch(r'[A-Z]:/[A-Za-z0-9/_-]+', self.remote):
            raise ValueError('Use a Windows QA root without spaces or shell characters')
        self.ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', self.host]
        self.tunnel = None
        self.caffeinate = None
        self.folder = None
        self.deadline = None

    def win(self, action):
        return command(self.ssh + ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                  self.remote+'/windows-app.ps1', '-Action', action, '-Root', self.remote], timeout=50)

    def checkpoint(self):
        if self.folder and (self.folder/'STOP').exists():
            raise InterruptedError('Stop requested')
        if self.deadline and time.monotonic() > self.deadline:
            raise TimeoutError('Release QA time budget exhausted')
        if self.folder:
            write(self.root/'release-status.json', {**self.status, 'heartbeat': now()})

    def status_write(self, **fields):
        self.status.update(fields)
        self.checkpoint()

    def mini_identity(self):
        app = Path('/Applications/CueDeck.app')
        with (app/'Contents/Info.plist').open('rb') as handle:
            version = plistlib.load(handle)['CFBundleShortVersionString']
        return {'version': version, 'executable': str(app/'Contents/MacOS/CueDeck'),
                'executableSha256': sha(app/'Contents/MacOS/CueDeck'), 'asarSha256': sha(app/'Contents/Resources/app.asar')}

    def network(self, address, device):
        import urllib.parse
        endpoint = urllib.parse.urlsplit(address)
        if endpoint.scheme != 'omt' or not endpoint.port:
            raise RuntimeError('SDK did not expose a direct OMT address: '+str(address))
        host = self.config['miniAddress'] if device['platform'] == 'darwin' else self.config['windowsAddress']
        source = f'omt://{host}:{endpoint.port}'
        self.status_write(phase=device['name']+'-network-output')
        if device['platform'] == 'darwin':
            text = command(self.ssh+['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                     self.remote+'/windows-receiver.ps1', '-Root', self.remote, '-Source', source, '-Seconds', '15'], timeout=40)
            decoder, results = json.JSONDecoder(), []
            for index, char in enumerate(text):
                if char == '{':
                    try:
                        value, _ = decoder.raw_decode(text[index:])
                        if value.get('final') is True:
                            results.append(value)
                    except (ValueError, AttributeError):
                        pass
            if not results:
                raise RuntimeError('Windows observer produced no final JSON')
            result = results[-1]
        else:
            output = self.folder/'windows-to-mini-omt'
            environment = dict(os.environ, ELECTRON_RUN_AS_NODE='1',
                               NODE_PATH='/Applications/CueDeck.app/Contents/Resources/app.asar/node_modules',
                               OMT_LIB_DIR='/Applications/CueDeck.app/Contents/Resources/omt',
                               OMT_STORAGE_PATH=str(output/'settings'))
            (output/'settings').mkdir(parents=True)
            with (self.folder/'network-receiver.log').open('wb') as log:
                subprocess.run(['/Applications/CueDeck.app/Contents/MacOS/CueDeck', str(HERE/'receiver.cjs'), source, str(output), '15'],
                               env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log, timeout=40)
            result = json.loads((output/'result.json').read_text())
        write(self.folder/(device['name']+'-network.json'), result)
        return result

    def stop_app(self, device):
        if device['platform'] == 'darwin' and not self.mini_running():
            return
        if device['platform'] == 'win32' and not json.loads(self.win('inspect')).get('processes'):
            return
        # Prefer a controlled normal quit through the inspected, verified installed process.
        try:
            client = target(device['inspectorPort'], '')
        except (OSError, RuntimeError):
            client = None
        if client:
            try:
                actual = client.evaluate('process.execPath')
                if actual.replace('\\', '/').lower() != device['app'].lower():
                    raise RuntimeError('Inspector belongs to another executable')
                client.evaluate("(()=>{const {app,dialog}=process.getBuiltinModule('module').createRequire(process.execPath)('electron');const original=dialog.showMessageBox;dialog.showMessageBox=async(...args)=>{const options=args[args.length-1];const response=options.buttons?.findIndex(b=>b==='Закрыть без сохранения'||b==='Close without saving');if(response>=0)return{response,checkboxChecked:false};return original(...args)};setTimeout(()=>app.quit(),80);return true})()")
            finally:
                client.close()
        else:
            raise NotImplementedError('Initial setup: close CueDeck normally on this bench device before its first QA launch. The runner does not click native quit dialogs, change permissions or force-kill the app.')
        deadline = time.monotonic()+20
        while time.monotonic() < deadline:
            if device['platform'] == 'darwin':
                running = self.mini_running()
            else:
                running = bool(json.loads(self.win('inspect')).get('processes'))
            if not running:
                return
            time.sleep(.3)
        raise RuntimeError('Normal app quit did not finish; no force kill was attempted')

    def start_app(self, device):
        if device['platform'] == 'win32':
            self.win('start')
        else:
            if self.mini_running():
                raise RuntimeError('Installed app is already running')
            environment = dict(os.environ)
            environment.pop('ELECTRON_RUN_AS_NODE', None)
            environment['CUEDECK_NO_NAG'] = '1'
            with (self.folder/'mini-app.log').open('ab') as log:
                subprocess.Popen([device['app'], '--remote-debugging-address=127.0.0.1',
                                  '--remote-debugging-port='+str(device['cdpPort']),
                                  '--inspect=127.0.0.1:'+str(device['inspectorPort'])], env=environment,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        self.wait_operator(device)

    def mini_running(self):
        result = subprocess.run(['pgrep', '-f', '^/Applications/CueDeck.app/Contents/MacOS/CueDeck( |$)'], capture_output=True)
        if result.returncode not in (0, 1):
            raise RuntimeError('Could not inspect installed CueDeck process')
        if len(result.stdout.splitlines()) > 1:
            raise RuntimeError('Multiple installed CueDeck main/helper processes; inspect before restart')
        return result.returncode == 0

    def wait_operator(self, device):
        deadline = time.monotonic()+30
        while time.monotonic() < deadline:
            self.checkpoint()
            try:
                client = target(device['cdpPort'], 'role=operator')
                client.close()
                return
            except (OSError, RuntimeError):
                try:
                    pages = read_json(f'http://127.0.0.1:{device["cdpPort"]}/json/list')
                    for page in pages:
                        if page.get('url', '').startswith('data:'):
                            url = page['webSocketDebuggerUrl']
                            # Only the documented boot selector is accepted; no numeric dialog guesses.
                            import urllib.parse
                            p = urllib.parse.urlsplit(url)
                            c = CDP(f'ws://127.0.0.1:{device["cdpPort"]}{p.path}')
                            try:
                                is_boot = c.evaluate("typeof pick==='function'&&document.querySelectorAll('button[data-i]').length===3&&!!document.getElementById('ask')")
                                if is_boot:
                                    c.call('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13})
                                    c.call('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13})
                            finally:
                                c.close()
                except (OSError, RuntimeError):
                    pass
                time.sleep(.3)
        raise RuntimeError('Operator UI did not appear (locked/logged-out desktop or startup dialog)')

    def run(self, release, retry=False):
        tag = release['tag_name']
        version = tag[1:]
        self.status = {'state': 'waiting', 'tag': tag, 'phase': 'bench-lock', 'updated': now()}
        # SAME lock as existing native and SDK benches. Never infer availability from status files.
        lock = (self.root/'active.lock').open('a')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            write(self.root/'release-queue.json', {**self.status, 'reason': 'Another bench worker owns active.lock'})
            lock.close()
            return self.status
        ledger_path = self.root/'release-attempts.json'
        ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
        if tag in ledger and not retry:
            lock.close()
            return {'state': 'already-attempted', **ledger[tag]}
        rid = 'release-'+tag+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        self.folder = self.root/'runs'/rid
        self.folder.mkdir(parents=True)
        self.status.update(id=rid, pid=os.getpid(), state='running', started=now(), phase='preflight')
        self.deadline = time.monotonic()+1200
        results = []
        try:
            self.checkpoint()
            if shutil.disk_usage(self.root).free < 3*1024**3:
                raise RuntimeError('Less than 3 GiB free')
            self.caffeinate = subprocess.Popen(['/usr/bin/caffeinate', '-i', '-w', str(os.getpid())], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # The parent QA directory is staged once by deployment, outside active tests.
            mini = self.mini_identity()
            windows = json.loads(self.win('inspect'))
            if mini['version'] != version or windows['version'] != version:
                self.status_write(state='waiting', phase='installation', reason='Both installed versions must match '+tag)
                write(self.root/'release-queue.json', self.status)
                return self.status
            ledger[tag] = {'id': rid, 'state': 'started', 'started': now()}
            write(ledger_path, ledger)
            cache = self.root/'release-cache'/tag
            cache.mkdir(parents=True, exist_ok=True)
            self.status_write(phase='verify-release-assets')
            expected_mini = verified_asset(release, f'CueDeck-{version}-Silicon-mac.zip', cache)
            expected_windows = verified_asset(release, f'CueDeck-{version}-win.zip', cache)
            if not installed_matches(mini, expected_mini, version) or not installed_matches(windows, expected_windows, version):
                raise RuntimeError('Installed executable/app.asar differs from verified GitHub release')
            manifest = {'tag': tag, 'releaseId': release['id'], 'publishedAt': release['published_at'],
                        'mini': {**mini, 'artifact': expected_mini}, 'windows': {**windows, 'artifact': expected_windows},
                        'scripts': {p.name: sha(p) for p in HERE.iterdir() if p.suffix in ('.py', '.ps1', '.cjs')},
                        'requiredCasesPerDevice': REQUIRED, 'limits': LIMITS}
            write(self.folder/'manifest.json', manifest)
            self.status_write(phase='fixtures')
            fixtures = create(self.folder/'fixtures', self.config['ffmpeg'])
            command(['scp', '-q', '-r', '-o', 'BatchMode=yes', str(fixtures), f'{self.host}:{self.remote}/'], timeout=60)
            self.tunnel = subprocess.Popen(['ssh', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10',
                                           '-L', '127.0.0.1:19823:127.0.0.1:9823', '-L', '127.0.0.1:19829:127.0.0.1:9829',
                                           '-L', '127.0.0.1:19840:127.0.0.1:19420', self.host], stdin=subprocess.DEVNULL,
                                          stdout=subprocess.DEVNULL, stderr=(self.folder/'tunnel.log').open('wb'))
            time.sleep(.5)
            if self.tunnel.poll() is not None:
                raise RuntimeError('SSH loopback forwarding failed')
            devices = [dict(name='mini', platform='darwin', app='/Applications/CueDeck.app/Contents/MacOS/CueDeck',
                            rendererPath='/Applications/CueDeck.app/Contents/Resources/app.asar/', cdpPort=9822, inspectorPort=9828,
                            fixturePath=str(fixtures), version=version, identity=mini),
                       dict(name='windows', platform='win32', app='C:/Program Files/CueDeck/CueDeck.exe',
                            rendererPath='/Program%20Files/CueDeck/resources/app.asar/', cdpPort=19823, inspectorPort=19829,
                            httpForwardPort=19840, fixturePath=self.remote+'/fixtures', version=version, identity=windows)]
            for device in devices:
                self.status_write(phase=device['name']+'-prepare')
                try:
                    # Adopt only the exact verified installed binary; normal close, never a forced kill.
                    self.stop_app(device)
                    self.start_app(device)
                except Exception as error:
                    result = {'device': device['name'], 'verdict': 'BLOCKED', 'cases': [{'id': 'preparation', 'status': 'BLOCKED', 'error': str(error)}]}
                else:
                    def restart(d=device):
                        self.stop_app(d)
                        self.start_app(d)
                    self.status_write(phase=device['name']+'-suite')
                    result = Suite(device, self.folder/device['name'], restart, self.checkpoint, self.network).run()
                results.append(result)
                self.status_write(results=results)
            outcome = 'FAIL' if any(r['verdict']=='FAIL' for r in results) else ('PASS' if len(results)==2 and all(r['verdict']=='PASS' for r in results) else 'BLOCKED')
            self.status.update(state='completed', verdict=outcome)
        except InterruptedError as error:
            self.status.update(state='stopped', verdict='BLOCKED', error=str(error))
        except Exception as error:
            self.status.update(state='failed', verdict='FAIL', error=str(error))
        finally:
            if self.tunnel:
                self.tunnel.terminate()
                try:
                    self.tunnel.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.tunnel.kill(); self.tunnel.wait()
                    self.status.setdefault('cleanupErrors', []).append('SSH tunnel needed forced termination')
            if self.caffeinate:
                self.caffeinate.terminate()
                self.caffeinate.wait(timeout=5)
            self.status.update(finished=now(), results=results)
            if self.status.get('cleanupErrors'):
                self.status['verdict'] = 'FAIL'
            write(self.folder/'result.json', self.status)
            write(self.root/'release-status.json', self.status)
            lines = ['# CueDeck release '+tag, '', 'State: '+self.status['state'], 'Verdict: '+self.status.get('verdict', 'BLOCKED'), '',
                     '| Device | Check | Result |', '| --- | --- | --- |']
            for result in results:
                for case in result['cases']:
                    lines.append('| '+result['device']+' | '+case['id']+' | '+case['status']+' |')
            if self.status.get('error'):
                lines.extend(['', self.status['error']])
            lines.extend(['', '## Limits', '']+['- '+limit for limit in LIMITS])
            (self.folder/'RESULTS.md').write_text('\n'.join(lines)+'\n')
            write(self.folder/'sha256.json', {str(p.relative_to(self.folder)): sha(p) for p in self.folder.rglob('*') if p.is_file() and p.name != 'sha256.json'})
            if tag in ledger:
                ledger[tag] = {k: self.status[k] for k in ('id', 'state', 'verdict', 'finished') if k in self.status}
                write(ledger_path, ledger)
            lock.close()
        return self.status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['poll', 'run', 'status', 'stop', 'install-watcher'])
    parser.add_argument('--config', type=Path, default=Path.home()/'cuedeck-bench/release-qa.json')
    parser.add_argument('--tag')
    parser.add_argument('--retry', action='store_true', help='Explicitly repeat a finished attempt')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    controller = Controller(config)
    if args.action in ('status', 'stop'):
        path = controller.root/'release-status.json'
        status = json.loads(path.read_text()) if path.exists() else {'state': 'not-started'}
        if args.action == 'stop' and status.get('state') == 'running':
            (controller.root/'runs'/status['id']/'STOP').touch()
        queue = controller.root/'release-queue.json'
        print(json.dumps({'latest': status, 'queue': json.loads(queue.read_text()) if queue.exists() else None}, ensure_ascii=False, indent=2))
        return 0
    if args.action == 'install-watcher':
        label = 'local.cuedeck.release-qa'
        path = Path.home()/'Library/LaunchAgents'/ (label+'.plist')
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            raise RuntimeError('Watcher already exists; inspect before replacing')
        definition = {'Label': label, 'ProgramArguments': [sys.executable, str(HERE/'controller.py'), 'poll', '--config', str(args.config.resolve())],
                      'StartInterval': 300, 'RunAtLoad': True, 'ProcessType': 'Background',
                      'StandardOutPath': str(controller.root/'release-watcher.log'), 'StandardErrorPath': str(controller.root/'release-watcher-error.log')}
        with path.open('wb') as output:
            plistlib.dump(definition, output)
        command(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', path])
        print(path)
        return 0
    try:
        release = release_info(config['repository'], args.tag)
    except Exception as error:
        if args.action == 'poll':
            write(controller.root/'release-queue.json', {'state': 'waiting', 'phase': 'github', 'updated': now(), 'error': str(error)})
            return 0
        raise
    result = controller.run(release, args.retry)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result.get('verdict') == 'FAIL' else 0


if __name__ == '__main__':
    sys.exit(main())
