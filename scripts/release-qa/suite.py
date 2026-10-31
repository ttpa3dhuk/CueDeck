"""Behavior checks against an installed CueDeck, without importing its source."""
import base64
import json
import time
import urllib.request
from pathlib import Path

from cdp import CDP, read_json, target
from fixtures import COLORS, png_pixel

REQUIRED = ['identity', 'surfaces', 'pdf-preview-take', 'pdf-navigation', 'image', 'pptx',
            'video', 'blackout', 'timers-message', 'http-control', 'omt-network', 'project-roundtrip', 'restart-persistence']
LIMITS = ['Physical TV picture/sound and A/V alignment require an external observer or capture device.',
          'Native file pickers are substituted only during project save/open; serialization and loading are real.',
          'Intel hardware, USB capture, physical clicker and real Companion device are not exercised.',
          'A digital OMT result is separate from physical playback; MediaCore candidates are not used.']


def verdict(cases):
    by_name = {c['id']: c['status'] for c in cases}
    if any(c['status'] == 'FAIL' for c in cases):
        return 'FAIL'
    if not all(by_name.get(name) == 'PASS' for name in REQUIRED):
        return 'BLOCKED'
    return 'PASS'


class Suite:
    def __init__(self, device, folder, restart=None, checkpoint=None, network=None):
        self.device, self.folder = device, Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.restart, self.checkpoint = restart, checkpoint or (lambda: None)
        self.network = network
        self.cases, self.clients = [], []
        self.operator = self.main = self.audience = self.speaker = None
        self.project_path = device['fixturePath'] + '/qa-roundtrip.pdpres'

    def connect(self):
        self.operator = target(self.device['cdpPort'], 'role=operator')
        self.clients.append(self.operator)
        self.operator.call('Runtime.enable')
        port = self.device.get('inspectorPort')
        if port:
            try:
                self.main = target(port, '')
                self.clients.append(self.main)
                self.main.evaluate("globalThis.__releaseQARequire=process.getBuiltinModule('module').createRequire(process.execPath);globalThis.__releaseQAElectron=__releaseQARequire('electron');true")
            except (OSError, RuntimeError):
                self.main = None

    def api(self, expression, timeout=30):
        return self.operator.evaluate(expression, timeout)

    def state(self):
        return self.api('window.api.state.get()')

    def wait(self, expression, timeout=20, client=None):
        client = client or self.operator
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            self.checkpoint()
            last = client.evaluate(expression)
            if last:
                return last
            time.sleep(.12)
        raise AssertionError('Timed out: ' + expression[:160] + '; last=' + repr(last))

    def expect(self, condition, message):
        if not condition:
            raise AssertionError(message)

    def screenshot(self, name, client=None):
        payload = (client or self.audience).call('Page.captureScreenshot', {'format': 'png'})['data']
        data = base64.b64decode(payload)
        (self.folder / (name + '.png')).write_bytes(data)
        return data

    def color(self, color, name):
        deadline = time.monotonic() + 15
        pixel = None
        while time.monotonic() < deadline:
            self.checkpoint()
            data = self.screenshot(name)
            pixel = png_pixel(data)
            if max(abs(a-b) for a, b in zip(pixel, color)) <= 22:
                return {'expected': color, 'actual': pixel}
            time.sleep(.15)
        raise AssertionError(f'Output pixel {pixel}, expected {color}')

    def open_preview(self, name):
        path = self.device['fixturePath'] + '/' + name
        result = self.api('window.api.preview.openPath(' + json.dumps(path) + ')', timeout=90)
        self.expect(result and result.get('ok'), f'Open {name}: {result}')
        return path

    def case(self, name, fn):
        self.checkpoint()
        started = time.monotonic()
        item = {'id': name, 'status': 'PASS'}
        try:
            item['evidence'] = fn()
        except NotImplementedError as error:
            item.update(status='BLOCKED', error=str(error))
        except Exception as error:
            item.update(status='FAIL', error=str(error))
            try:
                self.screenshot('failure-' + name, self.operator)
            except Exception:
                pass
        item['seconds'] = round(time.monotonic()-started, 3)
        self.cases.append(item)
        self.save()
        return item['status'] == 'PASS'

    def save(self):
        report = {'device': self.device['name'], 'expectedVersion': self.device['version'],
                  'verdict': verdict(self.cases), 'cases': self.cases, 'limits': LIMITS}
        temporary = self.folder / 'result.tmp'
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        temporary.replace(self.folder / 'result.json')
        return report

    def identity(self):
        url = self.api('location.href')
        expected = self.device['rendererPath']
        self.expect(expected in url and 'role=operator' in url, 'Unexpected renderer path: ' + str(url))
        self.expect(self.api('window.api.platform') == self.device['platform'], 'Wrong operating system')
        if self.main:
            info = self.main.evaluate('({version:__releaseQAElectron.app.getVersion(),executable:process.execPath,packaged:__releaseQAElectron.app.isPackaged})')
            self.expect(info['version'] == self.device['version'] and info['packaged'], 'Wrong packaged version: '+str(info))
            self.expect(info['executable'].replace('\\', '/').lower() == self.device['app'].lower(), 'Wrong installed executable')
            return info
        # This identity comes from the installed app manifest, checked by the controller.
        return {'renderer': url, 'version': self.device['version'], 'manifest': self.device['identity']}

    def surfaces(self):
        self.api('window.api.layout.setAskOnStartup(false)')
        state = self.state()
        display = state['displayMap']['operator']
        mapping = {'operator': display, 'speaker': display, 'audience': display}
        self.api('window.api.layout.set("operator-speaker-audience",'+json.dumps(mapping)+',true,false)')
        deadline = time.monotonic()+15
        while True:
            try:
                self.audience = target(self.device['cdpPort'], '/audience/index.html')
                self.speaker = target(self.device['cdpPort'], 'role=speaker')
                self.clients.extend([self.audience, self.speaker])
                break
            except (OSError, RuntimeError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.2)
        self.api('window.api.timer.pause()')
        self.api('window.api.timer.setTickSound(false)')
        self.api('window.api.timer.setGongSound(false)')
        self.api('window.api.audienceTimer.pause()')
        self.api('window.api.audienceTimer.setVisible(false)')
        self.api('window.api.speakerMessage.set(null)')
        state = self.state()
        if state['blackout']:
            self.api('window.api.blackout.toggle()')
        self.api('window.api.preview.setSlideTakeMode("from-start")')
        self.api('window.api.preview.setVideoTakeMode("play-start")')
        self.api('window.api.video.setLoop(false)')
        if self.main:
            self.main.evaluate("__releaseQAElectron.BrowserWindow.getAllWindows().find(w=>w.getTitle()==='CueDeck').setBounds({x:30,y:30,width:1000,height:600});true")
        return {'roles': ['operator', 'audience', 'speaker'], 'windowed': True}

    def pdf_preview_take(self):
        # Set a known program first; staging a different file must preserve it.
        self.open_preview('03_image.png')
        self.api('window.api.preview.take()')
        self.color(COLORS[2], 'before-preview')
        before = self.state()['pdfPath']
        self.open_preview('01_Кириллица.pdf')
        self.wait('window.api.state.get().then(s=>s.preview.totalSlides===3)')
        self.expect(self.state()['pdfPath'] == before, 'Opening preview changed the program')
        self.color(COLORS[2], 'preview-preserves-program')
        self.api("document.getElementById('take-btn').click();true")
        self.wait('window.api.state.get().then(s=>s.fileKind==="pdf"&&s.currentSlide===1)')
        return self.color(COLORS[0], 'pdf-take-red')

    def pdf_navigation(self):
        observations = []
        for page in (2, 3, 1, 3, 1):
            self.api(f'window.api.nav.goto({page})')
            self.wait(f'window.api.state.get().then(s=>s.currentSlide==={page})')
            observations.append(self.color(COLORS[page-1], f'pdf-page-{page}'))
        self.expect(self.speaker.evaluate('document.getElementById("current-canvas").width>0'), 'Speaker PDF canvas is empty')
        return observations

    def image(self):
        self.open_preview('03_image.png')
        self.api('window.api.preview.take("fade")')
        self.wait('window.api.state.get().then(s=>s.fileKind==="image")')
        return self.color(COLORS[2], 'image-fade-blue')

    def pptx(self):
        self.open_preview('02_slides.pptx')
        self.wait('window.api.state.get().then(s=>s.preview.totalSlides===3)', timeout=90)
        self.api('window.api.preview.take()')
        self.wait('window.api.state.get().then(s=>s.fileKind==="pptx")')
        first = self.color(COLORS[0], 'pptx-red')
        self.api('window.api.nav.goto(2)')
        second = self.color(COLORS[1], 'pptx-green')
        return [first, second]

    def video(self):
        self.open_preview('04_video.mp4')
        self.api('window.api.preview.take()')
        self.wait('window.api.state.get().then(s=>s.fileKind==="video"&&s.video.durationSec>10)')
        self.api('window.api.video.play()')
        before = self.wait('(()=>{const v=document.getElementById("slide-video");return v.readyState>=2&&!v.paused&&v.currentTime})()', client=self.audience)
        time.sleep(.8)
        after = self.audience.evaluate('document.getElementById("slide-video").currentTime')
        self.expect(after > before+.3, 'Video time did not advance')
        self.api('window.api.video.pause()')
        self.api('window.api.video.seek(5)')
        self.wait('(()=>{const v=document.getElementById("slide-video");return v.readyState>=2&&!v.seeking&&Math.abs(v.currentTime-5)<.35})()', client=self.audience)
        self.screenshot('video-seek')
        self.expect(self.speaker.evaluate('document.getElementById("current-video").muted'), 'Speaker must be muted')
        return {'advancedSeconds': after-before, 'seek': 5, 'speakerMuted': True}

    def blackout(self):
        if not self.state()['blackout']:
            self.api("document.getElementById('blackout-toggle').click();true")
        self.wait('window.api.state.get().then(s=>s.blackout)')
        result = self.color([0, 0, 0], 'blackout')
        self.expect(self.audience.evaluate('document.getElementById("slide-video").muted'), 'Blackout did not mute audience video')
        self.api('window.api.blackout.toggle()')
        self.wait('window.api.state.get().then(s=>!s.blackout)')
        return result

    def timers_message(self):
        self.api('window.api.timer.setLoop(false)')
        self.api('window.api.timer.setMode("countdown")')
        self.api('window.api.timer.setDuration(10000)')
        self.api('window.api.timer.reset()')
        self.api('window.api.timer.start()')
        self.wait('window.api.state.get().then(s=>s.timer.running)')
        time.sleep(1.2)
        self.api('window.api.timer.pause()')
        elapsed = self.state()['timer']['elapsedMs']
        self.expect(900 <= elapsed <= 5000, f'Timer elapsed {elapsed}')
        self.api('window.api.audienceTimer.configure({mode:"countdown",durationMs:90000,color:"#ff1100"})')
        self.api('window.api.audienceTimer.setVisible(true)')
        self.wait('(()=>{const e=document.getElementById("audience-timer");return !e.classList.contains("hidden")&&e.textContent.includes("01:30")})()', client=self.audience)
        self.api('window.api.speakerMessage.set("QA: сообщение спикеру")')
        self.wait('document.getElementById("speaker-message").textContent.includes("QA: сообщение спикеру")', client=self.speaker)
        self.screenshot('speaker-message', self.speaker)
        self.api('window.api.speakerMessage.set(null)')
        self.api('window.api.audienceTimer.setVisible(false)')
        return {'elapsedMs': elapsed, 'audienceTimer': '01:30', 'message': True}

    def http_control(self):
        settings = {'enabled': True, 'httpPort': self.device.get('httpPort', 19420), 'oscPort': 19421,
                    'lan': False, 'companionPush': False, 'companionHost': '127.0.0.1:8000'}
        result = self.api('window.api.remote.configure('+json.dumps(settings)+')')
        self.expect(result.get('ok') and result['status']['http'] == 'on', str(result))
        port = self.device.get('httpForwardPort', settings['httpPort'])
        root = f'http://127.0.0.1:{port}/api/'
        status = read_json(root+'state')
        self.expect(status.get('app') == 'CueDeck' and status.get('version') == self.device['version'], 'Wrong HTTP version')
        result = read_json(root+'timer/set/2:30')
        self.expect(result.get('ok'), str(result))
        self.expect(self.state()['timer']['durationMs'] == 150000, 'HTTP did not change actual timer')
        before = self.state()['blackout']
        result = read_json(root+'blackout/toggle')
        self.expect(result.get('ok') and self.state()['blackout'] != before, 'HTTP blackout did not reach program')
        self.color([0, 0, 0], 'http-blackout')
        read_json(root+'blackout/toggle')
        return {'version': status['version'], 'timerMs': 150000, 'blackoutPixel': True}

    def project_roundtrip(self):
        if not self.main:
            raise NotImplementedError('Installed app must be started with a loopback Node inspector for controlled file pickers')
        files = [self.device['fixturePath']+'/'+n for n in ('01_Кириллица.pdf', '02_slides.pptx', '03_image.png', '04_video.mp4')]
        self.api('window.api.project.create()')
        self.api('window.api.playlist.addPaths('+json.dumps(files)+')')
        entries = self.state()['playlist']
        self.expect(len(entries) == 4, 'Not all fixture files were added')
        self.api('window.api.playlist.update('+json.dumps(entries[0]['id'])+',{displayName:"QA кириллица",slideFadeMs:350})')
        # Save dialog alone is replaced; no StateStore or serialization internals are touched.
        self.main.evaluate('globalThis.__releaseQAOriginalSave=__releaseQAElectron.dialog.showSaveDialog;__releaseQAElectron.dialog.showSaveDialog=async()=>({canceled:false,filePath:'+json.dumps(self.project_path)+'});true')
        try:
            saved = self.api('window.api.project.save(true)')
            self.expect(saved.get('ok') and saved.get('path') == self.project_path, str(saved))
        finally:
            self.main.evaluate('__releaseQAElectron.dialog.showSaveDialog=__releaseQAOriginalSave;delete globalThis.__releaseQAOriginalSave;true')
        self.api('window.api.project.create()')
        self.main.evaluate('globalThis.__releaseQAOriginalOpen=__releaseQAElectron.dialog.showOpenDialog;__releaseQAElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+json.dumps(self.project_path)+']});true')
        try:
            loaded = self.api('window.api.project.open()', timeout=90)
            self.expect(loaded.get('ok'), str(loaded))
        finally:
            self.main.evaluate('__releaseQAElectron.dialog.showOpenDialog=__releaseQAOriginalOpen;delete globalThis.__releaseQAOriginalOpen;true')
        restored = self.state()['playlist']
        self.expect(len(restored) == 4 and restored[0]['displayName'] == 'QA кириллица' and restored[0].get('slideFadeMs') == 350,
                    'Playlist/fade/Unicode did not survive save/open')
        return {'entries': 4, 'fadeMs': 350, 'unicode': True, 'nativePicker': 'substituted'}

    def omt_network(self):
        if not self.network:
            raise NotImplementedError('No independent receiver configured')
        self.open_preview('04_video.mp4')
        self.api('window.api.video.setLoop(true)')
        self.api('window.api.preview.take()')
        self.api('window.api.video.setMuted(false)')
        self.api('window.api.video.play()')
        try:
            self.api('window.api.omt.configure({enabled:{timer:false,program:true,prompter:false},programAudio:true,fps:{timer:25,program:25,prompter:25}})')
            self.wait('window.api.state.get().then(s=>s.omt.outputs.program.state==="on"&&s.omt.outputs.program.address)')
            result = self.network(self.state()['omt']['outputs']['program']['address'], self.device)
            self.expect(result.get('final') is True and result.get('ok') is True and result.get('checks') and all(result['checks'].values()),
                        'Actual product OMT output failed: '+json.dumps(result))
            return result
        finally:
            self.api('window.api.omt.configure({enabled:{timer:false,program:false,prompter:false}})')
            self.api('window.api.video.setLoop(false)')

    def persistence(self):
        if not self.restart or not self.main or not any(c['id']=='project-roundtrip' and c['status']=='PASS' for c in self.cases):
            raise NotImplementedError('Cold persistence requires project roundtrip and an owned restart')
        self.api('window.api.ui.setTheme("dark")')
        before = self.state()['playlist']
        self.close()
        self.restart()
        self.connect()
        self.api('window.api.session.restore()', timeout=90)
        after = self.state()['playlist']
        self.expect(len(after) == 4 and after[0]['displayName'] == 'QA кириллица' and after[0].get('slideFadeMs') == 350,
                    'Cold launch lost playlist or slide fade')
        self.expect([x['filePath'] for x in before] == [x['filePath'] for x in after], 'Cold launch changed material paths')
        return {'coldRestart': True, 'playlist': 4, 'fadeMs': 350}

    def close(self):
        for client in self.clients:
            try:
                client.close()
            except OSError:
                pass
        self.clients = []

    def run(self):
        try:
            self.connect()
            if not self.case('identity', self.identity):
                return self.save()
            if not self.case('surfaces', self.surfaces):
                return self.save()
            for name, fn in [('pdf-preview-take', self.pdf_preview_take), ('pdf-navigation', self.pdf_navigation),
                             ('image', self.image), ('pptx', self.pptx), ('video', self.video),
                             ('blackout', self.blackout), ('timers-message', self.timers_message),
                             ('http-control', self.http_control), ('omt-network', self.omt_network), ('project-roundtrip', self.project_roundtrip),
                             ('restart-persistence', self.persistence)]:
                self.case(name, fn)
        finally:
            if self.operator:
                try:
                    self.api('window.api.timer.pause()'); self.api('window.api.audienceTimer.pause()')
                    self.api('window.api.audienceTimer.setVisible(false)'); self.api('window.api.video.pause()')
                except Exception as error:
                    self.cases.append({'id': 'cleanup', 'status': 'FAIL', 'error': str(error)})
            self.close()
        return self.save()
