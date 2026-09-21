#!/usr/bin/env python3
"""Reconstruct the final screen from a raw ANSI capture, as text.

Stripping escape codes collapses cursor positioning and produces a misleading
picture of a full-screen TUI: rows appear in the order they were written rather
than where they were drawn. This applies the positioning instead, so the output
is what the user actually saw.

This is the debug view. It keeps no colours, so use it to check layout and
wrapping; `png.py` is the one that renders a real image.

Ported from the Pi hub's `test/tools/screen.py`; see docs/demo.md.

Usage: python3 test/tools/screen.py <capture-file> [rows] [cols]
"""

import re
import sys

# OSC 66 is the kitty text-sizing protocol. OpenCode wraps every harness glyph
# in it: `ESC ] 66 ; w=1 ; <glyph> ESC \`. The payload is text to display, not a
# command, so a renderer that skips the sequence loses the glyph.
OSC66_RE = re.compile(r"\x1b\]66;([^\x07\x1b]*)(\x07|\x1b\\)")


def osc66_payload(params: str) -> tuple[str, int]:
    """Split OSC 66 parameters into the text to draw and its cell width."""
    segments = params.split(";")
    body = segments[-1]
    width = 1
    for segment in segments[:-1]:
        if segment.startswith("w="):
            try:
                width = max(1, int(segment[2:] or "1"))
            except ValueError:
                width = 1
    return body, width


def render(data: bytes, rows: int = 44, cols: int = 140) -> list[str]:
    text = data.decode("utf-8", "replace")
    screen = [[" "] * cols for _ in range(rows)]
    row = col = 0
    saved = (0, 0)
    i = 0
    n = len(text)

    def put(ch: str) -> None:
        nonlocal row, col
        if 0 <= row < rows and 0 <= col < cols:
            screen[row][col] = ch
        col += 1
        if col >= cols:
            col = 0
            row = min(rows - 1, row + 1)

    while i < n:
        ch = text[i]
        if ch == "\x1b":
            m = re.match(r"\x1b\[([0-9;:?<=>]*)([ -/]*)([@-~])", text[i:])
            if m:
                params, intermediates, cmd = m.group(1), m.group(2), m.group(3)
                nums = [int(p) for p in params.split(";") if p.isdigit()]
                if cmd == "H":
                    row = (nums[0] - 1) if len(nums) > 0 and nums[0] else 0
                    col = (nums[1] - 1) if len(nums) > 1 and nums[1] else 0
                elif cmd == "A":
                    row = max(0, row - (nums[0] if nums else 1))
                elif cmd == "B":
                    row = min(rows - 1, row + (nums[0] if nums else 1))
                elif cmd == "C":
                    col = min(cols - 1, col + (nums[0] if nums else 1))
                elif cmd == "D":
                    col = max(0, col - (nums[0] if nums else 1))
                elif cmd == "G":
                    col = max(0, (nums[0] - 1) if nums else 0)
                elif cmd == "d":
                    row = max(0, (nums[0] - 1) if nums else 0)
                elif cmd == "J":
                    mode = nums[0] if nums else 0
                    if mode in (2, 3):
                        screen = [[" "] * cols for _ in range(rows)]
                        row = col = 0
                    elif mode == 0:
                        for c in range(col, cols):
                            screen[row][c] = " "
                        for r in range(row + 1, rows):
                            screen[r] = [" "] * cols
                elif cmd == "K":
                    mode = nums[0] if nums else 0
                    if mode == 0:
                        for c in range(col, cols):
                            screen[row][c] = " "
                    elif mode == 1:
                        for c in range(0, min(col + 1, cols)):
                            screen[row][c] = " "
                    elif mode == 2:
                        screen[row] = [" "] * cols
                elif cmd == "s" and not params:
                    saved = (row, col)
                elif cmd == "u" and not params:
                    row, col = saved
                i += m.end()
                continue
            m2 = re.match(OSC66_RE, text[i:])
            if m2:
                # OSC 66 is the kitty text-sizing protocol: the payload is text to
                # display, not a command. OpenCode wraps every harness glyph in it
                # (`ESC]66;w=1;<glyph>ESC\`). Dropping the payload loses the glyph
                # and leaves whatever the last frame painted in that cell.
                body, width = osc66_payload(m2.group(1))
                for index, glyph in enumerate(body):
                    put(glyph)
                    for _ in range(max(1, width) - 1):
                        put(" ")
                i += m2.end()
                continue
            m3 = re.match(r"\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)", text[i:])
            if m3:
                i += m3.end()
                continue
            m4 = re.match(r"\x1b[()][A-Z0-9]", text[i:])
            if m4:
                i += m4.end()
                continue
            m5 = re.match(r"\x1b[=>78]", text[i:])
            if m5:
                i += m5.end()
                continue
            i += 1
            continue
        if ch == "\r":
            col = 0
        elif ch == "\n":
            row = min(rows - 1, row + 1)
        elif ch == "\b":
            col = max(0, col - 1)
        elif ch == "\t":
            col = min(cols - 1, (col // 8 + 1) * 8)
        elif ch >= " ":
            put(ch)
        i += 1

    return ["".join(r).rstrip() for r in screen]


if __name__ == "__main__":
    path = sys.argv[1]
    rows = int(sys.argv[2]) if len(sys.argv) > 2 else 44
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 140
    with open(path, "rb") as fh:
        lines = render(fh.read(), rows, cols)
    while lines and not lines[-1].strip():
        lines.pop()
    print("\n".join(lines))
