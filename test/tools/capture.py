#!/usr/bin/env python3
"""Drive a full-screen TUI inside a real PTY and capture the ANSI stream.

A screenshot of a terminal application is only worth showing if the application
actually drew it. So this is not a mocked renderer: it allocates a pty, gives it
the window size the image will have, starts the program in it, feeds it real
keystrokes, and writes down every byte that comes back. `screen.py` and `png.py`
then reconstruct what was on that screen.

Two things need the pty rather than a pipe:

  * window size. A TUI asks the terminal how wide it is (`TIOCGWINSZ`) and lays
    itself out for that answer. Without a pty there is no answer, and every
    layout decision is made for a terminal that does not exist.
  * keystrokes. Opening the browser is a key press (alt+h), which only reaches
    the program if it owns a terminal in raw mode.

Usage:
  python3 test/tools/capture.py --out capture.ansi --cols 140 --rows 44 \
      --cwd /srv/demo --env COLORTERM=truecolor --script steps.json -- opencode

The script is a JSON list of steps, run in order:
  {"sleep": 2.0}                     wait, while still recording
  {"send": "\\u001bh"}               write these bytes to the pty
  {"wait": "session-hub", "timeout": 30}   wait for a regex to appear on screen
  {"mark": "capture"}                remember this offset: the image ends here

With a mark, `<out>` holds the capture up to that point and `<out>.raw` holds
everything including the shutdown. The shutdown is left out of the image on
purpose: leaving a route repaints, and the exit writes to the primary screen.
"""

import argparse
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import threading
import time

READ_CHUNK = 65536

# The terminal's own colours, reported when the application asks. These match the
# defaults `png.py` draws with, so an application that picks its theme from the
# terminal's background gets the same answer the image is rendered with.
TERM_FG = (0xCC, 0xCC, 0xCC)
TERM_BG = (0x11, 0x13, 0x19)

# Colour indices the application may ask about, until it sets its own.
XTERM_PALETTE = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
    (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
    (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
    (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]

# DEC private modes a program may ask about with `CSI ? Pm $p`. 2 means
# "recognised and reset", which is what xterm reports for a mode it supports and
# has not been asked to enable. Anything not listed is reported as 0 (unknown).
DEC_MODES = {
    1000: 2, 1002: 2, 1003: 2, 1004: 2, 1006: 2,
    1015: 2, 1016: 2, 2004: 2, 2026: 2, 2027: 2,
}

# Every query this responder knows how to answer, and how. Keeping them in one
# table is what makes it obvious that nothing here is guessing: each entry is a
# sequence a terminal is specified to answer.
QUERY_RES = [
    ("cursor_report", re.compile(rb"\x1b\[6n")),
    ("window_pixels", re.compile(rb"\x1b\[14t")),
    ("window_chars", re.compile(rb"\x1b\[18t")),
    ("dec_mode", re.compile(rb"\x1b\[\?([0-9;]+)\$p")),
    ("kitty_keys", re.compile(rb"\x1b\[\?u")),
    ("xtversion", re.compile(rb"\x1b\[>([0-9]*)q")),
    ("xtgettcap", re.compile(rb"\x1bP\+q([0-9a-fA-F;]+)\x1b\\")),
    ("osc_palette", re.compile(rb"\x1b\]4;([0-9]+);\?\x1b\\")),
    ("osc_fg", re.compile(rb"\x1b\]10;\?(\x1b\\|\x07)")),
    ("osc_bg", re.compile(rb"\x1b\]11;\?(\x1b\\|\x07)")),
]

# Anything that is neither a query nor a plain character, so the cursor tracker
# can walk over it without treating escape bytes as text.
CSI_RE = re.compile(rb"\x1b\[([0-9;:?<=>]*)([ -/]*)([@-~])")
OSC_RE = re.compile(rb"\x1b\][^\x07\x1b]*(\x07|\x1b\\)")
DCS_RE = re.compile(rb"\x1b[P^_][^\x07\x1b]*\x1b\\")


def rgb_hex(rgb):
    return "rgb:%02x%02x/%02x%02x/%02x%02x" % (rgb[0], rgb[0], rgb[1], rgb[1], rgb[2], rgb[2])


class TerminalResponder:
    """Answer terminal capability queries, the way a real terminal does.

    This is not optional politeness. `opentui`, which draws OpenCode's TUI,
    probes the terminal on startup and waits for the answers: cursor position
    (`CSI 6n`), DEC private mode support (`CSI ? Pm $p`), the kitty keyboard
    protocol (`CSI ? u`), XTVERSION (`CSI > q`), termcap (`DCS + q`), the window
    size in pixels (`CSI 14 t`) and the terminal's colours (`OSC 10/11/4`).
    A pty that never answers leaves the application blocked before it draws
    anything, which is exactly what the first attempt at this capture produced:
    284 bytes of queries and not a single cell.

    The replies are the documented ones for each query, with xterm's own values.
    Only queries with a defined reply are answered; everything else is ignored.
    """

    def __init__(self, cols, rows, respond=True):
        self.cols = cols
        self.rows = rows
        self.respond = respond
        self.pending = b""
        self.row = 1
        self.col = 1
        self.answered = {}

    def feed(self, chunk):
        """Consume output, return the bytes the terminal would send back."""
        buf = self.pending + chunk
        self.pending = b""
        out = []
        pos = 0
        while pos < len(buf):
            best = None
            for name, rx in QUERY_RES:
                m = rx.search(buf, pos)
                if m and (best is None or m.start() < best[1].start()):
                    best = (name, m)
            if best is None:
                break
            name, m = best
            self.advance(buf[pos:m.start()])
            self.advance(m.group(0))
            self.answered[name] = self.answered.get(name, 0) + 1
            if self.respond:
                reply = self.reply(name, m)
                if reply:
                    out.append(reply)
            pos = m.end()

        rest = buf[pos:]
        # A sequence split across two reads must not be answered twice, so a short
        # tail that looks like the start of one is held back for the next chunk.
        tail = rest.rfind(b"\x1b")
        if tail >= 0 and len(rest) - tail < 64:
            self.pending = rest[tail:]
            self.advance(rest[:tail])
        else:
            self.advance(rest)
        return b"".join(out)

    def reply(self, name, m):
        if name == "cursor_report":
            return b"\x1b[%d;%dR" % (self.row, self.col)
        if name == "window_pixels":
            # 8x17 pixel cells, which is what a 26px render at this font lands on.
            return b"\x1b[4;%d;%dt" % (self.rows * 17, self.cols * 8)
        if name == "window_chars":
            return b"\x1b[8;%d;%dt" % (self.rows, self.cols)
        if name == "dec_mode":
            parts = []
            for raw in m.group(1).split(b";"):
                if not raw.isdigit():
                    continue
                mode = int(raw)
                parts.append(b"\x1b[?%d;%d$y" % (mode, DEC_MODES.get(mode, 0)))
            return b"".join(parts)
        if name == "kitty_keys":
            # No flags: this terminal does not do the kitty keyboard protocol, so
            # the application uses the ordinary key encodings.
            return b"\x1b[?0u"
        if name == "xtversion":
            return b"\x1bP>|harness-pty 1.0\x1b\\"
        if name == "xtgettcap":
            # "1 + r" says the capability is not supported. Claiming support for a
            # capability this terminal does not have would make the application
            # emit sequences nothing here understands.
            return b"\x1bP0+r" + m.group(1) + b"\x1b\\"
        if name == "osc_palette":
            index = int(m.group(1))
            rgb = XTERM_PALETTE[index] if index < len(XTERM_PALETTE) else (0, 0, 0)
            return b"\x1b]4;%d;%s\x1b\\" % (index, rgb_hex(rgb).encode())
        if name == "osc_fg":
            return b"\x1b]10;%s\x1b\\" % rgb_hex(TERM_FG).encode()
        if name == "osc_bg":
            return b"\x1b]11;%s\x1b\\" % rgb_hex(TERM_BG).encode()
        return b""

    def advance(self, text):
        """Track the cursor, so `CSI 6n` reports a position that is true."""
        i = 0
        while i < len(text):
            byte = text[i : i + 1]
            if byte == b"\x1b":
                m = CSI_RE.match(text, i) or OSC_RE.match(text, i) or DCS_RE.match(text, i)
                if m:
                    self.apply_csi(m.group(0))
                    i = m.end()
                    continue
                i += 1
                continue
            if byte == b"\r":
                self.col = 1
            elif byte == b"\n":
                self.row = min(self.rows, self.row + 1)
            elif byte == b"\b":
                self.col = max(1, self.col - 1)
            elif byte >= b" ":
                # One cell per character: the harness glyphs are single width, and
                # this only has to be right for the cursor report.
                self.col += 1
                if self.col > self.cols:
                    self.col = 1
                    self.row = min(self.rows, self.row + 1)
            i += 1

    def apply_csi(self, seq):
        m = CSI_RE.match(seq)
        if not m:
            return
        params, cmd = m.group(1), m.group(3)
        nums = [int(p) for p in params.split(b";") if p.isdigit()]
        if cmd in (b"H", b"f"):
            self.row = nums[0] if len(nums) > 0 and nums[0] else 1
            self.col = nums[1] if len(nums) > 1 and nums[1] else 1
        elif cmd == b"A":
            self.row = max(1, self.row - (nums[0] if nums else 1))
        elif cmd == b"B":
            self.row = min(self.rows, self.row + (nums[0] if nums else 1))
        elif cmd == b"C":
            self.col = min(self.cols, self.col + (nums[0] if nums else 1))
        elif cmd == b"D":
            self.col = max(1, self.col - (nums[0] if nums else 1))
        elif cmd == b"G":
            self.col = max(1, nums[0] if nums else 1)
        elif cmd == b"d":
            self.row = max(1, nums[0] if nums else 1)


class Driver:
    def __init__(self, argv, cwd, env, cols, rows, respond=True):
        self.argv = argv
        self.cwd = cwd
        self.env = env
        self.cols = cols
        self.rows = rows
        self.terminal = TerminalResponder(cols, rows, respond=respond)
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.eof = threading.Event()
        self.child = None
        self.fd = None

    def start(self):
        pid, fd = pty.fork()
        if pid == 0:
            # Child: a fresh session whose controlling terminal is the pty.
            try:
                os.chdir(self.cwd)
            except Exception:
                os._exit(126)
            env = dict(self.env)
            env["COLUMNS"] = str(self.cols)
            env["LINES"] = str(self.rows)
            os.execvpe(self.argv[0], self.argv, env)
            os._exit(127)
        self.child = pid
        self.fd = fd
        self.resize(self.cols, self.rows)
        thread = threading.Thread(target=self._pump, daemon=True)
        thread.start()

    def resize(self, cols, rows):
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, winsize)
        try:
            os.kill(self.child, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    def _pump(self):
        while True:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.2)
            except (OSError, ValueError):
                break
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, READ_CHUNK)
            except OSError:
                # EIO is how a closed pty reports EOF.
                break
            if not chunk:
                break
            with self.lock:
                self.buf.extend(chunk)
            reply = self.terminal.feed(chunk)
            if reply:
                try:
                    os.write(self.fd, reply)
                except OSError:
                    break
        self.eof.set()

    def offset(self):
        with self.lock:
            return len(self.buf)

    def text(self, limit=None):
        with self.lock:
            data = bytes(self.buf)
        if limit is not None:
            data = data[-limit:]
        return data.decode("utf-8", "replace")

    def data(self):
        with self.lock:
            return bytes(self.buf)

    def send(self, data):
        os.write(self.fd, data.encode("utf-8"))

    def wait_for(self, pattern, timeout):
        """Wait for a regex to appear in the stream. Returns True on a match."""
        deadline = time.time() + timeout
        rx = re.compile(pattern)
        while time.time() < deadline:
            if rx.search(self.text(limit=400_000)):
                return True
            if self.eof.is_set():
                break
            time.sleep(0.05)
        return False

    def stop(self, grace=1.5):
        """Ask the program to exit, then make sure it has."""
        if self.child is None:
            return
        for how in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(self.child, how)
            except ProcessLookupError:
                break
            end = time.time() + grace / 2
            while time.time() < end:
                done, _ = os.waitpid(self.child, os.WNOHANG)
                if done:
                    self.child = None
                    return
                time.sleep(0.05)
        try:
            os.waitpid(self.child, os.WNOHANG)
        except ChildProcessError:
            pass
        self.child = None
        try:
            os.close(self.fd)
        except OSError:
            pass


def load_script(path):
    with open(path) as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="capture file (up to the mark)")
    ap.add_argument("--script", required=True, help="JSON list of steps")
    ap.add_argument("--cols", type=int, default=140)
    ap.add_argument("--rows", type=int, default=44)
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--env", action="append", default=[], metavar="K=V")
    ap.add_argument("--timeout", type=float, default=120.0, help="hard stop for the whole run")
    ap.add_argument(
        "--no-respond",
        action="store_true",
        help="do not answer terminal queries (what a naive pty does; useful to prove they matter)",
    )
    ap.add_argument("command", nargs=argparse.REMAINDER)
    args = ap.parse_args()

    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        ap.error("no command to run")

    # A terminal is more than TERM: the locale decides whether the app is allowed
    # to emit the harness glyphs at all, and COLORTERM decides whether it uses
    # 24-bit colour or the matching one behind its back.
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
        # HOME and XDG_CONFIG_HOME are always supplied by the caller: this script
        # must never read the user's real config.
    }
    for pair in args.env:
        key, _, value = pair.partition("=")
        env[key] = value

    steps = load_script(args.script)
    driver = Driver(command, args.cwd, env, args.cols, args.rows, respond=not args.no_respond)

    started = time.time()
    mark = None
    driver.start()
    try:
        for step in steps:
            if time.time() - started > args.timeout:
                print("capture: timeout reached, stopping", file=sys.stderr)
                break
            if "sleep" in step:
                time.sleep(float(step["sleep"]))
            if "send" in step:
                driver.send(step["send"])
            if "resize" in step:
                driver.resize(int(step["resize"][0]), int(step["resize"][1]))
            if "wait" in step:
                ok = driver.wait_for(step["wait"], float(step.get("timeout", 20)))
                if not ok:
                    print(f"capture: timed out waiting for {step['wait']!r}", file=sys.stderr)
            if "mark" in step:
                mark = driver.offset()
    finally:
        # Everything after the mark is shutdown noise; the raw log keeps it.
        # The mark is a byte offset, so this stays bytes: decoding and re-encoding
        # would change the length of anything that was not valid UTF-8.
        raw = driver.data()
        driver.stop()

    with open(args.out, "wb") as fh:
        fh.write(raw if mark is None else raw[:mark])
    if mark is not None:
        with open(args.out + ".raw", "wb") as fh:
            fh.write(raw)
    kept = len(raw) if mark is None else mark
    print(f"capture: {kept} bytes kept, {len(raw)} total -> {args.out}")
    answered = driver.terminal.answered
    if answered:
        summary = ", ".join(f"{name} x{count}" for name, count in sorted(answered.items()))
        print(f"capture: answered {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
