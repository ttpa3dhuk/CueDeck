"""Small synchronous CDP client. Python standard library only, loopback only."""
import base64
import hashlib
import json
import os
import socket
import struct
import time
import urllib.parse
import urllib.request


def read_json(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


class CDP:
    def __init__(self, url, timeout=20):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'ws' or parsed.hostname not in ('127.0.0.1', 'localhost'):
            raise ValueError('CDP must use a loopback WebSocket')
        self.socket = socket.create_connection((parsed.hostname, parsed.port), timeout)
        self.buffer = b''
        self.sequence = 0
        self.events = []
        key = base64.b64encode(os.urandom(16)).decode()
        request = ('GET ' + parsed.path + ('?' + parsed.query if parsed.query else '') + ' HTTP/1.1\r\n'
                   f'Host: {parsed.hostname}:{parsed.port}\r\nUpgrade: websocket\r\n'
                   f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n')
        self.socket.sendall(request.encode())
        while b'\r\n\r\n' not in self.buffer:
            part = self.socket.recv(4096)
            if not part or len(self.buffer) > 65536:
                self.close()
                raise RuntimeError('WebSocket upgrade failed')
            self.buffer += part
        headers, self.buffer = self.buffer.split(b'\r\n\r\n', 1)
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        fields = dict(line.split(b':', 1) for line in headers.split(b'\r\n')[1:] if b':' in line)
        fields = {k.lower(): v.strip() for k, v in fields.items()}
        if headers.split(b'\r\n')[0].split()[1:2] != [b'101'] or fields.get(b'sec-websocket-accept') != expected:
            self.close()
            raise RuntimeError('Invalid WebSocket upgrade response')

    def close(self):
        self.socket.close()

    def _read(self, count):
        while len(self.buffer) < count:
            part = self.socket.recv(min(65536, max(4096, count - len(self.buffer))))
            if not part:
                raise ConnectionError('CDP connection closed')
            self.buffer += part
        result, self.buffer = self.buffer[:count], self.buffer[count:]
        return result

    def _send(self, payload, opcode=1):
        mask = os.urandom(4)
        size = len(payload)
        prefix = bytes([128 | opcode])
        if size < 126:
            prefix += bytes([128 | size])
        elif size < 65536:
            prefix += bytes([128 | 126]) + struct.pack('!H', size)
        else:
            prefix += bytes([128 | 127]) + struct.pack('!Q', size)
        self.socket.sendall(prefix + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(payload)))

    def _message(self):
        parts = []
        size = 0
        while True:
            first, second = self._read(2)
            opcode = first & 15
            count = second & 127
            if count == 126:
                count = struct.unpack('!H', self._read(2))[0]
            elif count == 127:
                count = struct.unpack('!Q', self._read(8))[0]
            if second & 128 or count > 64 * 1024 * 1024:
                raise RuntimeError('Invalid server WebSocket frame')
            payload = self._read(count)
            if opcode == 8:
                raise ConnectionError('CDP closed the connection')
            if opcode == 9:
                self._send(payload, 10)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise RuntimeError('Unexpected WebSocket opcode')
            parts.append(payload)
            size += count
            if size > 64 * 1024 * 1024:
                raise RuntimeError('CDP message too large')
            if first & 128:
                return json.loads(b''.join(parts))

    def call(self, method, params=None, timeout=25):
        self.sequence += 1
        sequence = self.sequence
        self._send(json.dumps({'id': sequence, 'method': method, 'params': params or {}}).encode())
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.socket.settimeout(max(.01, deadline - time.monotonic()))
            response = self._message()
            if response.get('id') != sequence:
                if 'method' in response:
                    self.events.append(response)
                    self.events = self.events[-1000:]
                continue
            if 'error' in response:
                raise RuntimeError(f'{method}: {response["error"]}')
            return response.get('result', {})
        raise TimeoutError(method)

    def evaluate(self, expression, timeout=25):
        result = self.call('Runtime.evaluate', {'expression': expression, 'awaitPromise': True,
                                              'returnByValue': True}, timeout)
        if result.get('exceptionDetails'):
            raise RuntimeError(json.dumps(result['exceptionDetails'], ensure_ascii=False))
        if result.get('result', {}).get('subtype') == 'error':
            raise RuntimeError(str(result['result']))
        return result.get('result', {}).get('value')


def target(port, marker):
    pages = read_json(f'http://127.0.0.1:{port}/json/list')
    matches = [p for p in pages if marker in p.get('url', '') and p.get('webSocketDebuggerUrl')]
    if len(matches) != 1:
        raise RuntimeError(f'Expected one {marker!r} target, found {len(matches)}')
    parsed = urllib.parse.urlsplit(matches[0]['webSocketDebuggerUrl'])
    # SSH local-forwarding changes the port, never the target identifier.
    return CDP(urllib.parse.urlunsplit(('ws', f'127.0.0.1:{port}', parsed.path, parsed.query, '')))
