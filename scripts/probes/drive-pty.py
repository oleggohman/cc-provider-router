#!/usr/bin/env python3
"""Drives an interactive `claude` session in a pty and records the screen.

usage:
  drive-pty.py run <cwd> <screen-log> <seconds> <step>... -- <claude args...>
  drive-pty.py show <screen-log> [<last-n-chars>]

`run` starts `claude <claude args...>` in <cwd> (a temp directory, never the
repo), sends each step at its time, and after <seconds> writes the raw
screen bytes to <screen-log> and ends the session.

A step is `<second>:<key>` or `<second>:text:<what to type>`, the second
counted from the start. Keys: enter, esc, down, up, tab, ctrl-c.
A new directory first shows the workspace trust dialog: `down` then `enter`
picks "Yes, I trust this folder". Example:

  drive-pty.py run "$RUN/cwd" "$RUN/screen.raw" 70 8:down 9:enter \\
      '20:text:scenario=slow:25 go' 21:enter 30:esc \\
      '40:text:scenario=text go' 41:enter -- \\
      --plugin-dir "$PROBE" --settings "$RUN/settings.json" \\
      --permission-mode auto --model custom:mock:m --debug-file "$RUN/debug.log"

`show` prints the log with the terminal control sequences removed and
repeated lines dropped.
"""
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

KEYS = {'enter': b'\r', 'esc': b'\x1b', 'down': b'\x1b[B', 'up': b'\x1b[A', 'tab': b'\t', 'ctrl-c': b'\x03'}


def show(path, last=6000):
    raw = open(path, 'rb').read().decode('utf-8', 'replace')
    text = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]', '\n', raw)
    seen = []
    for line in (x.strip() for x in text.split('\n')):
        if line and line not in seen:
            seen.append(line)
    print('\n'.join(seen)[-last:])


def parse(step):
    at, _, what = step.partition(':')
    if what.startswith('text:'):
        return float(at), what[5:].encode()
    if what not in KEYS:
        sys.exit(f'unknown key {what!r}; keys: {", ".join(KEYS)}')
    return float(at), KEYS[what]


def run(cwd, log, total, steps, args):
    for a in args:
        if a in ('--dangerously-skip-permissions', 'bypassPermissions'):
            sys.exit('refusing a bypass mode')
    steps = sorted(parse(s) for s in steps)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.environ['TERM'] = 'xterm-256color'
        os.execvp('claude', ['claude', *args])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
    start, buf, i = time.time(), b'', 0
    while time.time() - start < total:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                buf += os.read(fd, 65536)
            except OSError:
                break
        while i < len(steps) and time.time() - start >= steps[i][0]:
            try:
                os.write(fd, steps[i][1])
            except OSError:
                pass
            i += 1
    with open(log, 'wb') as f:
        f.write(buf)
    try:
        os.kill(pid, 15)
    except OSError:
        pass


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'show':
        show(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6000)
    elif len(sys.argv) >= 6 and sys.argv[1] == 'run' and '--' in sys.argv:
        cut = sys.argv.index('--')
        run(sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5:cut], sys.argv[cut + 1:])
    else:
        sys.exit(__doc__)
