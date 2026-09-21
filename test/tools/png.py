#!/usr/bin/env python3
"""Render a raw ANSI capture to a real PNG.

A PTY capture is a stream of cursor movements and colour changes. Stripping the
escapes collapses the layout, and ignoring SGR loses the theme. This applies both,
so the image is what the user actually saw on screen.

Differences from the Pi hub's version this was ported from, all of them forced by
OpenCode's terminal output (see docs/demo.md):

  * OpenCode paints backgrounds. `ESC[48;2;R;G;Bm` and its 256-colour and basic
    forms are applied per cell, and `ESC[49m` restores the terminal default. The
    Pi hub's renderer assumed a background was never painted, so an unpatched
    port would have drawn the selected row and the pane fills as empty space.
  * OpenCode uses the alternate screen (`ESC[?1049h` / `ESC[?1049l`). There are
    two buffers here and the alternate one is what gets rendered, so the shell
    prompt this was launched from never appears in the image.
  * `ESC[K` mode 1 (erase to start of line) is handled; OpenCode uses it on rows
    it repaints from the right edge.

Usage:
  python3 test/tools/png.py <capture> <out.png> [--rows N] [--cols N] [--size N]
"""

import argparse
import re
import sys

from PIL import Image, ImageDraw, ImageFont

DEFAULT_FG = (205, 211, 222)
DEFAULT_BG = (17, 19, 25)

# Primary font first, then fallbacks. A real terminal resolves missing glyphs
# through fontconfig, so a renderer that uses one font file would show tofu
# boxes for symbols the terminal actually draws. The hub's markers are
# π ✻ ⬡ ⌘ ❯ ◆, which no single monospace font covers.
FONT_CHAIN = [
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "/usr/share/fonts/Adwaita/AdwaitaMono-Regular.ttf",
    "/usr/share/fonts/noto/NotoSansSymbols2-Regular.ttf",
    "/usr/share/fonts/noto/NotoSansSymbols-Regular.ttf",
]
FONT_CHAIN_BOLD = [
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/Adwaita/AdwaitaMono-Bold.ttf",
    "/usr/share/fonts/noto/NotoSansSymbols2-Regular.ttf",
]


# 256-colour palette, computed the same way xterm does.
def _palette() -> list[tuple[int, int, int]]:
    base = [
        (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
        (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
        (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
        (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
    ]
    for i in range(216):
        r, g, b = i // 36, (i % 36) // 6, i % 6
        conv = lambda v: 0 if v == 0 else 55 + v * 40
        base.append((conv(r), conv(g), conv(b)))
    for i in range(24):
        v = 8 + i * 10
        base.append((v, v, v))
    return base


PALETTE = _palette()

# OSC 66 is the kitty text-sizing protocol: `ESC ] 66 ; w=1 ; <glyph> ESC \`.
# OpenCode wraps every harness glyph in it. The payload is text to display, not
# a command, so a renderer that skips the whole sequence silently loses the
# marker and leaves the previous frame's character in that cell.
OSC66_RE = re.compile(r"\x1b\]66;([^\x07\x1b]*)(\x07|\x1b\\)")


def osc66_payload(params):
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


class Cell:
    __slots__ = ("ch", "fg", "bg", "bold")

    def __init__(self):
        self.ch = " "
        self.fg = DEFAULT_FG
        self.bg = None
        self.bold = False

    def blank(self) -> bool:
        return self.ch == " " and self.bg is None


class Screen:
    """One terminal buffer. Kept separate so the alternate screen is real."""

    def __init__(self, rows: int, cols: int):
        self.rows = rows
        self.cols = cols
        self.cells = [[Cell() for _ in range(cols)] for _ in range(rows)]

    def clear(self) -> None:
        self.cells = [[Cell() for _ in range(self.cols)] for _ in range(self.rows)]


def emulate(data: bytes, rows: int, cols: int) -> list[list[Cell]]:
    text = data.decode("utf-8", "replace")
    primary = Screen(rows, cols)
    active = primary
    alternate = None
    row = col = 0
    fg, bg, bold = DEFAULT_FG, None, False
    saved = (0, 0)
    i, n = 0, len(text)

    def draw(ch: str) -> None:
        """Place one character the way the terminal would (see `put` below)."""
        nonlocal row, col
        if 0 <= row < rows and 0 <= col < cols:
            cell = active.cells[row][col]
            cell.ch, cell.fg, cell.bg, cell.bold = ch, fg, bg, bold
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
                        active.clear()
                        row = col = 0
                    elif mode == 0:
                        for c in range(col, cols):
                            active.cells[row][c] = Cell()
                        for r in range(row + 1, rows):
                            active.cells[r] = [Cell() for _ in range(cols)]
                elif cmd == "K":
                    mode = nums[0] if nums else 0
                    if mode == 0:
                        for c in range(col, cols):
                            active.cells[row][c] = Cell()
                    elif mode == 1:
                        for c in range(0, min(col + 1, cols)):
                            active.cells[row][c] = Cell()
                    elif mode == 2:
                        active.cells[row] = [Cell() for _ in range(cols)]
                elif cmd == "s" and not params:
                    saved = (row, col)
                elif cmd == "u" and not params:
                    row, col = saved
                elif cmd == "m" and not intermediates and ">" not in params and "<" not in params:
                    fg, bg, bold = apply_sgr(nums or [0], fg, bg, bold)
                elif cmd == "h" or cmd == "l":
                    # DEC private modes. 1049 is the alternate screen; the cursor
                    # and mouse modes are safe to ignore when rendering a still.
                    if "?" in params and 1049 in nums:
                        if cmd == "h":
                            if alternate is None:
                                alternate = Screen(rows, cols)
                            alternate.clear()
                            active = alternate
                        else:
                            active = primary
                    elif "?" in params and (47 in nums or 1047 in nums):
                        if cmd == "h":
                            if alternate is None:
                                alternate = Screen(rows, cols)
                            alternate.clear()
                            active = alternate
                        else:
                            active = primary
                i += m.end()
                continue
            m2 = re.match(OSC66_RE, text[i:])
            if m2:
                body, width = osc66_payload(m2.group(1))
                for index, glyph in enumerate(body):
                    draw(glyph)
                    # A wider cell is filled with blanks: the right half of a wide
                    # glyph has no character of its own.
                    for _ in range(max(1, width) - 1):
                        draw(" ")
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
            draw(ch)
        i += 1

    return active.cells


def apply_sgr(nums, fg, bg, bold):
    idx = 0
    while idx < len(nums):
        v = nums[idx]
        if v == 0:
            fg, bg, bold = DEFAULT_FG, None, False
        elif v == 1:
            bold = True
        elif v == 22:
            bold = False
        elif v == 39:
            fg = DEFAULT_FG
        elif v == 49:
            bg = None
        elif v == 7:
            fg, bg = (bg or DEFAULT_BG), fg
        elif v in (30, 31, 32, 33, 34, 35, 36, 37):
            fg = PALETTE[v - 30]
        elif v in (90, 91, 92, 93, 94, 95, 96, 97):
            fg = PALETTE[v - 90 + 8]
        elif v in (40, 41, 42, 43, 44, 45, 46, 47):
            bg = PALETTE[v - 40]
        elif v in (100, 101, 102, 103, 104, 105, 106, 107):
            bg = PALETTE[v - 100 + 8]
        elif v == 38 or v == 48:
            if idx + 1 < len(nums) and nums[idx + 1] == 2 and idx + 4 < len(nums):
                rgb = tuple(nums[idx + 2 : idx + 5])
                if v == 38:
                    fg = rgb
                else:
                    bg = rgb
                idx += 4
            elif idx + 1 < len(nums) and nums[idx + 1] == 5 and idx + 2 < len(nums):
                rgb = PALETTE[nums[idx + 2] % 256]
                if v == 38:
                    fg = rgb
                else:
                    bg = rgb
                idx += 2
        idx += 1
    return fg, bg, bold


def coverage(path):
    """Set of codepoints a font can actually draw."""
    from fontTools.ttLib import TTFont

    try:
        f = TTFont(path, fontNumber=0, lazy=True)
        cps = set()
        for t in f["cmap"].tables:
            cps |= set(t.cmap.keys())
        f.close()
        return cps
    except Exception:
        return set()


def build_chain(paths, size):
    """Load a font chain and precompute which codepoints each covers."""
    chain = []
    for path in paths:
        try:
            chain.append((ImageFont.truetype(path, size), coverage(path)))
        except Exception:
            continue
    return chain


def pick(chain, ch, primary):
    """First font in the chain that covers this character, else the primary."""
    cp = ord(ch)
    for font, cps in chain:
        if cp in cps:
            return font
    return chain[0][0] if chain else primary


def to_png(screen, out_path, size, pad, radius):
    regular = build_chain(FONT_CHAIN, size)
    bold = build_chain(FONT_CHAIN_BOLD, size)
    font = regular[0][0]
    cw = font.getlength("M")
    ascent, descent = font.getmetrics()
    lh = ascent + descent

    rows = len(screen)
    cols = len(screen[0]) if rows else 0
    w = int(cols * cw) + pad * 2
    h = int(rows * lh) + pad * 2

    img = Image.new("RGB", (w, h), DEFAULT_BG)
    draw = ImageDraw.Draw(img)

    # Backgrounds first, batched into runs so we do not draw one rect per cell.
    for r, line in enumerate(screen):
        c = 0
        while c < cols:
            bg = line[c].bg
            if bg is None:
                c += 1
                continue
            start = c
            while c < cols and line[c].bg == bg:
                c += 1
            draw.rectangle(
                [pad + start * cw, pad + r * lh, pad + c * cw, pad + (r + 1) * lh],
                fill=bg,
            )

    # Group runs by (colour, bold, resolved font) so a fallback glyph splits the
    # run instead of dragging the rest of the line into the wrong font.
    for r, line in enumerate(screen):
        y = pad + r * lh
        c = 0
        while c < cols:
            cell = line[c]
            if cell.ch == " ":
                c += 1
                continue
            fg = cell.fg
            chain = bold if cell.bold else regular
            f = pick(chain, cell.ch, font)
            start = c
            run = ""
            while (
                c < cols
                and line[c].ch != " "
                and line[c].fg == fg
                and line[c].bold == cell.bold
                and pick(chain, line[c].ch, font) is f
            ):
                run += line[c].ch
                c += 1
            draw.text((pad + start * cw, y), run, font=f, fill=fg)

    img.save(out_path)
    return w, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("capture")
    ap.add_argument("out")
    ap.add_argument("--rows", type=int, default=44)
    ap.add_argument("--cols", type=int, default=140)
    ap.add_argument("--size", type=int, default=26)
    ap.add_argument("--pad", type=int, default=18)
    ap.add_argument("--radius", type=int, default=10)
    ap.add_argument("--keep-rows", action="store_true", help="do not trim empty rows")
    args = ap.parse_args()

    with open(args.capture, "rb") as fh:
        data = fh.read()
    screen = emulate(data, args.rows, args.cols)
    # Drop trailing blank lines so the image is not mostly empty.
    if not args.keep_rows:
        while screen and all(c.blank() for c in screen[-1]):
            screen.pop()
    w, h = to_png(screen, args.out, args.size, args.pad, args.radius)
    print(f"{args.out}: {w}x{h}, {len(screen)} rows")


if __name__ == "__main__":
    sys.exit(main())
