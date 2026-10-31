import base64
import hashlib
import json
import socket
import struct
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

from cdp import CDP
from controller import Controller, installed_matches, verified_asset
from fixtures import COLORS, create, png_bytes, png_pixel
from suite import REQUIRED, verdict


class FixtureTests(unittest.TestCase):
    def test_generated_files_have_three_pdf_pages_and_real_pptx_zip(self):
        with tempfile.TemporaryDirectory() as folder:
            root = create(folder)
            pdf = (root/'01_Кириллица.pdf').read_bytes()
            self.assertEqual(pdf.count(b'/Type /Page '), 3)
            self.assertIn(b'/Count 3', pdf)
            with ZipFile(root/'02_slides.pptx') as archive:
                self.assertIsNone(archive.testzip())
                for i in (1, 2, 3):
                    self.assertIn(f'ppt/slides/slide{i}.xml', archive.namelist())
            self.assertEqual(png_pixel((root/'03_image.png').read_bytes()), list(COLORS[2]))

    def test_png_detects_wrong_output_color(self):
        self.assertEqual(png_pixel(png_bytes(13, 7, COLORS[0])), list(COLORS[0]))
        self.assertNotEqual(png_pixel(png_bytes(13, 7, COLORS[0])), list(COLORS[1]))

    def test_png_rejects_corruption(self):
        data = bytearray(png_bytes(13, 7, COLORS[0]))
        data[44] ^= 1
        with self.assertRaises(ValueError):
            png_pixel(bytes(data))

    def test_png_reconstructs_all_filters(self):
        import zlib
        for kind in range(5):
            width, height, channels = 4, 3, 3
            source = [list(range(10, 22)), list(range(30, 42)), list(range(50, 62))]
            raw = bytearray()
            previous = [0]*12
            for row in source:
                raw.append(kind)
                for col, value in enumerate(row):
                    left = row[col-channels] if col >= channels else 0
                    up = previous[col]
                    diag = previous[col-channels] if col >= channels else 0
                    p = left+up-diag
                    distances = [abs(p-left), abs(p-up), abs(p-diag)]
                    predictor = [0, left, up, (left+up)//2, [left, up, diag][distances.index(min(distances))]][kind]
                    raw.append((value-predictor) & 255)
                previous = row
            def chunk(t, b):
                return struct.pack('!I', len(b))+t+b+struct.pack('!I', zlib.crc32(t+b)&0xffffffff)
            data = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0))+chunk(b'IDAT', zlib.compress(raw))+chunk(b'IEND', b'')
            self.assertEqual(png_pixel(data), [36, 37, 38])


class VerdictTests(unittest.TestCase):
    def cases(self):
        return [{'id': name, 'status': 'PASS'} for name in REQUIRED]

    def test_no_checks_cannot_pass(self):
        self.assertEqual(verdict([]), 'BLOCKED')

    def test_missing_required_check_cannot_pass(self):
        self.assertEqual(verdict(self.cases()[:-1]), 'BLOCKED')

    def test_blocked_case_cannot_pass(self):
        cases = self.cases(); cases[0]['status'] = 'BLOCKED'
        self.assertEqual(verdict(cases), 'BLOCKED')

    def test_failure_dominates(self):
        cases = self.cases(); cases[0]['status'] = 'FAIL'
        self.assertEqual(verdict(cases), 'FAIL')

    def test_cleanup_failure_dominates(self):
        self.assertEqual(verdict(self.cases()+[{'id': 'cleanup', 'status': 'FAIL'}]), 'FAIL')

    def test_full_required_set_passes(self):
        self.assertEqual(verdict(self.cases()), 'PASS')


class ArtifactTests(unittest.TestCase):
    def test_shared_bench_lock_prevents_any_device_actions(self):
        import fcntl
        with tempfile.TemporaryDirectory() as folder:
            config = dict(root=folder, windowsHost='test-host', windowsRoot='C:/ReleaseQA')
            controller = Controller(config)
            with (Path(folder)/'active.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.object(controller, 'win', side_effect=AssertionError('Device must not be touched')):
                    result = controller.run({'tag_name':'v1.2.3'})
                self.assertEqual(result['state'], 'waiting')
                self.assertFalse((Path(folder)/'release-attempts.json').exists())

    def test_finished_version_is_not_retried_automatically(self):
        with tempfile.TemporaryDirectory() as folder:
            controller = Controller(dict(root=folder, windowsHost='test-host', windowsRoot='C:/ReleaseQA'))
            (Path(folder)/'release-attempts.json').write_text(json.dumps({'v1.2.3':{'id':'previous','state':'failed','verdict':'FAIL'}}))
            with patch.object(controller, 'win', side_effect=AssertionError('Device must not be touched')):
                result = controller.run({'tag_name':'v1.2.3'})
            self.assertEqual(result['id'], 'previous')
            self.assertEqual(result['verdict'], 'FAIL')

    def test_same_version_with_wrong_payload_is_rejected(self):
        installed = dict(version='1.2.3', asarSha256='a', executableSha256='b')
        self.assertTrue(installed_matches(installed, dict(asarSha256='a', executableSha256='b'), '1.2.3'))
        self.assertFalse(installed_matches(installed, dict(asarSha256='a', executableSha256='c'), '1.2.3'))
        self.assertFalse(installed_matches(installed, dict(asarSha256='a', executableSha256='b'), '1.2.4'))

    def test_asset_checks_digest_and_members_independently(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            path = folder/'CueDeck-1.2.3-win.zip'
            with ZipFile(path, 'w') as archive:
                archive.writestr('CueDeck.exe', b'executable')
                archive.writestr('resources/app.asar', b'payload')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            release = {'assets': [dict(name=path.name, state='uploaded', digest='sha256:'+digest, size=path.stat().st_size)]}
            result = verified_asset(release, path.name, folder)
            self.assertEqual(result['asarSha256'], hashlib.sha256(b'payload').hexdigest())
            release['assets'][0]['digest'] = None
            with self.assertRaises((RuntimeError, TypeError)):
                verified_asset(release, path.name, folder)

    def test_missing_and_duplicate_assets_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            asset = dict(name='a.zip', state='uploaded')
            for assets in ([], [asset, asset]):
                with self.assertRaises(RuntimeError):
                    verified_asset({'assets': assets}, 'a.zip', Path(folder))


class ProtocolTests(unittest.TestCase):
    def test_external_debugger_is_rejected(self):
        with self.assertRaises(ValueError):
            CDP('ws://example.com:1234/debug')

    def test_real_handshake_masking_and_fragmented_response(self):
        server = socket.socket()
        server.bind(('127.0.0.1', 0)); server.listen(1)
        port = server.getsockname()[1]
        errors = []
        def serve():
            try:
                with server.accept()[0] as connection:
                    connection.settimeout(3)
                    request = b''
                    while b'\r\n\r\n' not in request:
                        request += connection.recv(4096)
                    key = next(line.split(b':', 1)[1].strip() for line in request.split(b'\r\n') if line.startswith(b'Sec-WebSocket-Key:'))
                    accept = base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
                    connection.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n')
                    def read(n):
                        value=b''
                        while len(value)<n:
                            part=connection.recv(n-len(value))
                            if not part: raise EOFError()
                            value+=part
                        return value
                    a, b = read(2)
                    self.assertTrue(b & 128)
                    length = b & 127
                    if length == 126: length = struct.unpack('!H', read(2))[0]
                    mask = read(4); payload = read(length)
                    message = json.loads(bytes(c^mask[i%4] for i,c in enumerate(payload)))
                    response = json.dumps({'id': message['id'], 'result': {'result': {'value': 'working'}}}).encode()
                    cut=len(response)//2
                    connection.sendall(bytes([1, cut])+response[:cut]+bytes([128, len(response)-cut])+response[cut:])
            except Exception as error:
                errors.append(error)
            finally:
                server.close()
        thread = threading.Thread(target=serve); thread.start()
        client = CDP(f'ws://127.0.0.1:{port}/debug')
        try:
            self.assertEqual(client.evaluate('test'), 'working')
        finally:
            client.close(); thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        if errors: raise errors[0]


if __name__ == '__main__':
    unittest.main()
