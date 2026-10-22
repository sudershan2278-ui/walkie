#!/usr/bin/env python3
"""Key a radio's PTT through a serial port's RTS/DTR lines.

Reads "1" (key) or "0" (unkey) lines on stdin. Uses only the Python standard
library, so it runs on a stock Raspberry Pi OS.

Usage: ptt.py /dev/ttyACM0 aioc|rts|dtr
  aioc: DTR on and RTS off keys the AIOC cable's PTT (its default setting)
  rts:  RTS on keys PTT (common DIY transistor or CAT cables)
  dtr:  DTR on keys PTT
"""
import fcntl
import os
import struct
import sys
import termios

TIOCM_DTR = getattr(termios, "TIOCM_DTR", 0x002)
TIOCM_RTS = getattr(termios, "TIOCM_RTS", 0x004)


def set_lines(fd, on_bits, off_bits):
    if on_bits:
        fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack("I", on_bits))
    if off_bits:
        fcntl.ioctl(fd, termios.TIOCMBIC, struct.pack("I", off_bits))


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ("aioc", "rts", "dtr"):
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    device, mode = sys.argv[1], sys.argv[2]
    fd = os.open(device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)

    def key(on):
        if mode == "aioc":
            set_lines(fd, TIOCM_DTR if on else 0, TIOCM_RTS if on else TIOCM_DTR | TIOCM_RTS)
        elif mode == "rts":
            set_lines(fd, TIOCM_RTS if on else 0, 0 if on else TIOCM_RTS)
        else:
            set_lines(fd, TIOCM_DTR if on else 0, 0 if on else TIOCM_DTR)

    key(False)
    try:
        for line in sys.stdin:
            key(line.strip() == "1")
    finally:
        key(False)
        os.close(fd)


if __name__ == "__main__":
    main()
