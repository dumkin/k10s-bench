#!/usr/bin/env python3
"""Runs a terminal program (k9s) in a pseudo-terminal of a fixed size, as a terminal window would.

    terminal.py <cols> <rows> <keys-fifo> -- <command> [args…]

Prints the child's pid on the first line, then everything the program draws. Bytes written to <keys-fifo>
are typed into the program. Exits when the program does.
"""

import fcntl
import os
import pty
import select
import struct
import sys
import termios

cols, rows, fifo = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
command = sys.argv[sys.argv.index("--") + 1 :]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
out = sys.stdout.buffer
out.write(f"{pid}\n".encode())
out.flush()
# Read-write, so that the fifo never reports end of file between writers.
keys = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
while True:
    try:
        ready, _, _ = select.select([fd, keys], [], [], 0.5)
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out.write(data)
        out.flush()
    if keys in ready:
        data = os.read(keys, 1024)
        if data:
            os.write(fd, data)
    if os.waitpid(pid, os.WNOHANG)[0] == pid:
        break
