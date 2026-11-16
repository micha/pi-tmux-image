#!/usr/bin/env python3
"""Synthetic OSC 5522 routing experiment; never accesses a real clipboard.

Uses a private tmux socket and a PTY as the outer terminal. No output from the
private terminal is forwarded to the invoking terminal. Requires Python 3/tmux.
"""

import json
import os
import pathlib
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import fcntl


def main():
    tmux = shutil.which("tmux")
    if not tmux:
        raise RuntimeError("tmux is required")
    with tempfile.TemporaryDirectory(prefix="pi-clipboard-routing-") as directory:
        root = pathlib.Path(directory)
        socket = str(root / "tmux.sock")
        env = {key: value for key, value in os.environ.items()
               if key not in ("TMUX", "TMUX_PANE")}
        env.update(HOME=directory, TERM="xterm-256color")
        receiver = root / "receiver.py"
        receiver.write_text('''import os, pathlib, sys, tty
name, directory = sys.argv[1:]
tty.setraw(0)
os.write(1, ("READY-" + name).encode())
pending = b""
while True:
    data = os.read(0, 65536)
    if name == "origin" and data == b"r":
        request = b"\\x1b]5522;type=read:id=origin-request;aW1hZ2UvcG5n\\x1b\\\\"
        os.write(1, b"\\x1bPtmux;" + request.replace(b"\\x1b", b"\\x1b\\x1b") + b"\\x1b\\\\")
    else:
        with (pathlib.Path(directory) / (name + ".bin")).open("ab") as output:
            output.write(data)
        pending += data
        if pending == b"plain text 123\\r":
            os.write(1, ("TYPED-" + name).encode())
            pending = b""
        elif b"status=DONE:id=origin-request" in pending and pending.endswith(b"\\x1b\\\\"):
            os.write(1, ("RECEIVED-" + name).encode())
            pending = b""
''')

        def command(*args):
            return subprocess.run([tmux, "-S", socket, *args], env=env,
                                  check=True, capture_output=True, timeout=5)

        pid, master = pty.fork()
        if pid == 0:
            os.execve(tmux, [tmux, "-S", socket, "-f", "/dev/null", "new-session",
                            "-s", "probe", "-n", "origin", sys.executable,
                            str(receiver), "origin", directory], env)
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
            buffered = b""

            def until(marker):
                nonlocal buffered
                deadline = time.monotonic() + 5
                while marker not in buffered:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not select.select([master], [], [], remaining)[0]:
                        raise RuntimeError("private terminal experiment timed out")
                    buffered += os.read(master, 65536)
                    if len(buffered) > 1024 * 1024:
                        raise RuntimeError("private terminal output exceeded bound")
                buffered = buffered.split(marker, 1)[1]

            until(b"READY-origin")
            command("set-option", "-g", "allow-passthrough", "all")
            command("send-keys", "-t", "probe:origin", "r")
            # Observe the outbound request only on the fake terminal, never stdout.
            until(b"\x1b]5522;type=read:id=origin-request;aW1hZ2UvcG5n\x1b\\")
            typing = b"plain text 123\r"
            os.write(master, typing)
            until(b"TYPED-origin")
            origin_typing = (root / "origin.bin").read_bytes() == typing
            reply = (b"\x1b]5522;type=read:status=OK:id=origin-request\x1b\\"
                     b"\x1b]5522;type=read:status=DATA:id=origin-request:"
                     b"mime=aW1hZ2UvcG5n;c3ludGhldGlj\x1b\\"
                     b"\x1b]5522;type=read:status=DONE:id=origin-request\x1b\\")
            os.write(master, reply)
            until(b"RECEIVED-origin")
            same_pane = (root / "origin.bin").read_bytes() == typing + reply
            command("send-keys", "-t", "probe:origin", "r")
            until(b"\x1b]5522;type=read:id=origin-request;aW1hZ2UvcG5n\x1b\\")
            command("new-window", "-t", "probe", "-n", "other", sys.executable,
                    str(receiver), "other", directory)
            until(b"READY-other")
            os.write(master, typing)
            until(b"TYPED-other")
            other_typing = (root / "other.bin").read_bytes() == typing
            # Simulate the same reply arriving after a user changes windows while
            # the outer terminal's permission prompt is pending.
            os.write(master, reply)
            until(b"RECEIVED-other")
            wrong_pane = (root / "other.bin").read_bytes() == typing + reply
            print(json.dumps({
                "tmux": command("-V").stdout.decode().strip(),
                "outbound_passthrough_observed": True,
                "normal_typing_preserved_in_both_windows": origin_typing and other_typing,
                "same_active_pane_received_exact_reply": same_pane,
                "different_active_pane_received_origin_reply": wrong_pane,
                "real_clipboard_accessed": False,
            }, indent=2))
            if not same_pane or not wrong_pane or not origin_typing or not other_typing:
                raise RuntimeError("routing behavior changed; investigate before drawing conclusions")
        finally:
            subprocess.run([tmux, "-S", socket, "kill-server"], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            os.close(master)
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)


if __name__ == "__main__":
    main()
