#!/usr/bin/env python3
"""Private tmux + fake outer PTY driver; fixed synthetic clipboard responses only."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
import zlib

root, host_root, worker, node, output_format, fragmented = sys.argv[1:]
root = pathlib.Path(root)
tmux = shutil.which('tmux')
if not tmux:
    raise RuntimeError('tmux missing')
socket = str(root / 'private.sock')
env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8', 'PI_OFFLINE': '1', 'PI_TUI_WRITE_LOG': ''}

def command(*args):
    return subprocess.run([tmux, '-S', socket, *args], env=env, capture_output=True, check=True, timeout=5)

def chunk(name, payload):
    named = name + payload
    return struct.pack('>I', len(payload)) + named + struct.pack('>I', zlib.crc32(named))

def interrupted(signum, _frame):
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
pid = master = None
try:
    command('-f', '/dev/null', 'new-session', '-d', '-s', 'probe', '-x', '100', '-y', '30')
    command('set-option', '-g', 'allow-passthrough', 'all')
    command('set-option', '-s', 'extended-keys', 'on')
    command('set-option', '-s', 'extended-keys-format', output_format)
    command('respawn-pane', '-k', '-t', 'probe:0', node, worker, str(root), host_root, output_format)
    pid, master = pty.fork()
    if pid == 0:
        os.execve(tmux, [tmux, '-S', socket, 'attach-session', '-t', 'probe'], env)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    buffered = b''
    def until(pattern):
        global buffered
        deadline = time.monotonic() + 20
        while True:
            match = re.search(pattern, buffered)
            if match:
                buffered = buffered[match.end():]
                return match
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([master], [], [], remaining)[0]:
                raise RuntimeError('private PTY event timed out')
            try:
                data = os.read(master, 65536)
            except OSError:
                raise RuntimeError('private worker terminal closed before expected event') from None
            if not data:
                raise RuntimeError('private worker ended early')
            buffered += data
            if len(buffered) > 2 * 1024 * 1024:
                raise RuntimeError('private terminal output bound exceeded')
    until(b'CLIPBOARD_PRIVATE_WORKER_READY')
    (root / 'start').write_text('start')
    request = until(rb'\x1b\]5522;type=read:id=([a-zA-Z0-9_.+-]+);aW1hZ2UvcG5n\x1b\\')
    request_id = request.group(1)
    # Deliberate modal typing must never reach the editor draft.
    os.write(master, b'ordinary typing deliberately captured while modal')
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) +
           chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00\xff')) + chunk(b'IEND', b''))
    import base64
    def packet(status, payload=None):
        return (b'\x1b]5522;type=read:status=' + status + b':id=' + request_id +
                (b':mime=aW1hZ2UvcG5n;' + base64.b64encode(payload) if payload is not None else b'') + b'\x1b\\')
    reply = packet(b'OK') + b''.join(packet(b'DATA', png[i:i+17]) for i in range(0, len(png), 17)) + packet(b'DONE')
    if fragmented == 'yes':
        # Split header/payload/terminator bytes across writes, with controlled
        # delays below tmux's own Escape-key ambiguity interval. No real data.
        cuts = [1, 5, 25, 75, len(reply) - 1, len(reply)]
        start = 0
        for stop in cuts:
            os.write(master, reply[start:stop]); start = stop
            select.select([], [], [], 0.08)
    else:
        os.write(master, reply)  # One coalesced terminal reply, no timing gaps.
    until(b'CLIPBOARD_PRIVATE_OUTSIDE_READY')
    os.write(master, b'\x1b]outside typed\x1b[200~outside pasted\x1b[201~')
    until(b'CLIPBOARD_PRIVATE_WORKER_DONE')
    result = json.loads((root / 'result.json').read_text())
    result['tmux'] = command('-V').stdout.decode().strip()
    result['fragmentedOuterWrites'] = fragmented == 'yes'
    print(json.dumps(result))
    if not result['ok']:
        sys.exit(1)
finally:
    subprocess.run([tmux, '-S', socket, 'kill-server'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    if master is not None:
        os.close(master)
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
