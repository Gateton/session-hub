# The demo image

`assets/opencode-hub.png` is the screenshot of session-hub's browser inside
OpenCode, with sessions from all six harnesses in one list.

```bash
node tools/make-demo-image.mjs
```

That is the whole command. It needs `opencode` on `PATH`, Node 22.5+, and
`python3` with Pillow and fontTools (`python3 -m pip install pillow fonttools`).
On Linux it also uses `unshare` when it is available; see
[Where the demo projects live](#where-the-demo-projects-live).

It takes about twenty seconds and produces a ~370 KB PNG at 2219x1576.

## What the command actually does

```
tools/make-demo-image.mjs
  |
  |-- test/fixtures/demo-home.mjs      write a synthetic home: 18 invented
  |                                   sessions, three per harness
  |-- bin/sessionhub.mjs index --force  build the hub index from that home
  |-- bin/sessionhub.mjs doctor --json  and refuse to continue unless all six
  |                                   harnesses are `ok` with sessions
  |-- test/tools/capture.py            run OpenCode in a real pty, press alt+h,
  |                                   record every byte it writes
  |-- test/tools/png.py                render those bytes to a PNG
```

Nothing is hand-drawn and nothing is mocked. The pixels come from OpenCode's own
renderer, driven through a real terminal, and the data comes from the real hub
pipeline: the same `index` and `context` commands a user runs, against a home
directory that is not this machine's.

`test/tools/screen.py` is the same capture as plain text. When something looks
wrong in the image, that is the fastest way to see what the application actually
put on the screen:

```bash
python3 test/tools/screen.py /tmp/session-hub-demo/opencode-hub.ansi 44 140
```

## The data is invented, and that is checkable

The image goes in a public repository, so every string in it is synthetic: three
projects (`/srv/work/acme-api`, `/srv/work/ledger-ui`, `/srv/work/search-service`)
and eighteen sessions with invented titles and invented conversations, three per
harness. `test/fixtures/demo-home.mjs` never reads a real store.

The fixture writes the shapes each harness actually writes: Pi's JSONL tree,
Claude Code's `projects/<slug>/<uuid>.jsonl` with an `ai-title`, Codex rollouts
under `sessions/YYYY/MM/DD/`, JCode's single-document sessions, and the Crush and
OpenCode SQLite databases. Timestamps are relative to the moment the fixture
runs, which is why the image says "just now" and "11m ago" rather than a date
that ages.

To check for leaks yourself, look for anything that is not the synthetic home:

```bash
python3 - <<'PY'
data = open("/tmp/session-hub-demo/opencode-hub.ansi", "rb").read().decode("utf-8", "replace")
for needle in ["/home/", "Projects/", "Documents/"]:
    print(needle, data.count(needle))
PY
```

The only `/home/` in the capture is inside `/tmp/session-hub-demo/home/...`,
which is the synthetic home.

## Where the demo projects live

The reference fixture puts its projects at `/srv/work/acme-api`, and the image is
more believable when it shows those paths than when it shows
`/tmp/session-hub-demo/work/acme-api` truncated to twenty-five columns. So the
tool re-executes itself inside a private user + mount namespace with a tmpfs over
`/srv`, which needs no root and leaves the machine's own `/srv` untouched:

```
unshare -rm bash -c 'mount -t tmpfs tmpfs /srv; ... exec node tools/make-demo-image.mjs'
```

Where that is not possible (macOS, a locked-down kernel, `--no-namespace`) it
falls back to `<demo-root>/work` and says so in its output. Everything else works
identically; only the paths in the image are longer.

The demo root defaults to `/tmp/session-hub-demo` and holds the synthetic home,
the index, the scratch config and the raw capture. Override it with
`--demo-root`, or keep the capture out of the way entirely.

## Options

| Flag | Default | Why you would change it |
| --- | --- | --- |
| `--cols` | 140 | Terminal width. Below 138 the browser drops the harness *labels* and keeps only the glyphs, because the list pane falls under its 58-column threshold. |
| `--rows` | 44 | Terminal height. 44 shows all eighteen sessions at once. |
| `--size` | 26 | Font size in the PNG. Changes sharpness, not what fits. |
| `--out` | `assets/opencode-hub.png` | Where the image goes. |
| `--demo-root` | `/tmp/session-hub-demo` | Where the synthetic home and the raw capture go. |
| `--keep` | off | Keep the `.raw` capture, including the shutdown. |
| `--no-namespace` | off | Skip the namespace, whatever the machine allows. |

## Pitfalls, in the order they bit

Everything below cost a failed attempt. They are written down because each one
produces an image that *looks* plausible while being wrong.

### 1. A pty that does not answer leaves the TUI blocked

The first attempt produced 284 bytes and no image: OpenCode's renderer (`opentui`)
probes the terminal before it draws anything, and waits for the answers. The
queries, and what a real terminal replies:

| Query | Meaning | Reply |
| --- | --- | --- |
| `CSI 6n` | cursor position | `CSI <row>;<col> R` |
| `CSI ? Pm $p` | is DEC private mode Pm supported | `CSI ? Pm;2$y` |
| `CSI ? u` | kitty keyboard protocol | `CSI ? 0u` (this terminal does not speak it) |
| `CSI > q` | XTVERSION | `DCS > \| text ST` |
| `CSI 14t` | window size in pixels | `CSI 4;<px high>;<px wide> t` |
| `DCS + q <hex>` | termcap lookup | `DCS 0 + r <hex> ST` (not supported) |
| `OSC 10;?` / `OSC 11;?` | foreground and background colour | `OSC 10;rgb:.../.../... ST` |
| `OSC 4;<n>;?` | palette entry | `OSC 4;<n>;rgb:.../.../... ST` |

`TerminalResponder` in `test/tools/capture.py` answers them as they arrive. It
also tracks the cursor, so the `CSI 6n` reply is a position that is true rather
than a constant.

Two details are easy to get wrong. The palette query is terminated with **BEL**,
not `ESC \`, and a pattern that only accepts `ESC \` silently never answers it.
And the kitty keyboard query is answered *negatively* on purpose: this pty does
not implement the protocol, which is why the script presses `alt+h` rather than
`ctrl+shift+h`.

### 2. OpenCode paints backgrounds

The Pi hub's renderer assumed a background is never painted, because Pi never
paints one. OpenCode does: every row is drawn as
`ESC[38;2;R;G;Bm ESC[48;2;R;G;Bm ...`, `ESC[49m` restores the default, and the
selected row is a filled block. Unpatched, the selected row and the pane fills
render as empty space, which is exactly the kind of "looks fine at a glance"
failure this image cannot afford.

### 3. OSC 66 wraps every harness glyph

The markers (π ✻ ⬡ ⌘ ❯ ◆) are not written as plain characters. They are written
as `ESC ] 66 ; w=1 ; <glyph> ESC \`, the kitty text-sizing protocol, where the
payload *is* text to display. A renderer that skips the whole sequence loses the
glyph **and** leaves whatever the previous frame had in that cell, so the browser
shows the wrong character rather than a blank. Both `png.py` and `screen.py`
parse the payload and draw it.

### 4. CSI does not have to be `digits` + letter

`CSI 1 SP q` (DECSCUSR, the cursor shape) has an intermediate byte before the
final one. With a pattern of `digits then letter`, the escape is not recognised,
the parser falls through and paints the literal text `[1 q` onto the screen. The
image had a stray `[1` and `q` in its bottom corner until the pattern was widened
to the real ECMA-48 shape, `params` + `intermediates` + `final`.

### 5. The alternate screen is a real screen

OpenCode uses `ESC[?1049h`. Without a second buffer, the shell prompt this was
launched from would still be sitting under the TUI, and the exit sequence would
scroll it into view. `png.py` keeps two buffers and renders the alternate one.

### 6. A hand-written OpenCode store hangs the TUI

The fixture's first version created `session`/`message`/`part` by hand, the same
way the Pi hub's fixture does for Crush. The hub read it happily and `doctor`
said `ok`... and OpenCode hung at startup on its own splash screen, because it
runs schema migrations against that file every time it starts and the file had
the tables but none of the migration history. The browser never opened, and the
capture was a picture of a splash screen.

The fix is in the fixture: `warmOpenCodeStore` runs `opencode db path` with the
demo's `XDG_DATA_HOME`, which makes OpenCode create and migrate its own database,
and only then are rows inserted (`emitOpenCode` checks the columns it finds with
`pragma table_info` rather than assuming a schema).

### 7. The plugin has two halves in two files

`integrations/opencode` exports a server plugin and a TUI plugin, and OpenCode
loads them from different places. Listing the directory in `opencode.json` loads
the server half only: the plugin log shows `plugin loaded` and `registered the
/hub command`, and `alt+h` does nothing, because nothing registered the route.
The browser comes from `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/session-hub/integrations/opencode"]
}
```

The tool writes both files into its scratch config.

### 8. A key sent before the TUI is ready is a key nobody receives

The first working script slept eight seconds and then pressed `alt+h`. That is a
race: the TUI is a Bun process that loads config, starts a server and paints, and
a key delivered before its keymaps exist does nothing at all. The script now
waits for the host's own home screen (`Ask anything`), and then for the browser's
own footer line (`open again from anywhere`) before accepting the capture. If
that line never appears, the whole capture is retried from scratch, up to four
times, and the tool fails loudly instead of writing a picture of something else.

### 9. The six-harness view cannot be the project view

The browser opens on "this project, newest first", which is the right default for
a real user. It is the wrong view for this image, for a reason worth knowing:
**Crush records no working directory**, so a `crush` session can never match a
project query (`repo`, `cwd` or a `cwd` prefix). A project-scoped browser lists
every harness except Crush.

So OpenCode is started from a directory that contains no indexed sessions, and
the browser falls back to the newest sessions everywhere. That is the only view
in which all six harnesses appear at once, and it is what the header's
`18 of 18 shown · 3 project(s)` describes.

The one thing that does not match is the browser's own subtitle, which is the
host's fixed wording for the unfiltered view: it reads "this project, newest
first" under a list from three projects. That line is drawn by the browser, not
by the capture, and the alternative is an image with five harnesses in it.

### 10. TMPDIR is not always neutral

`os.tmpdir()` on this machine is under the user's home, so the demo home landed
in `/home/<user>/...` and the preview pane's `- Source path:` line put that path
into a public image. The demo root is now a fixed `/tmp/session-hub-demo`
(overridable), and the leak check above is the way to confirm it.

## What this image does not prove

- **Nothing about a model.** The browser reads transcripts off disk; no model is
  involved on that path and none is configured in the scratch config, so the
  image says nothing about what the hub does with a live session.
- **Nothing about tapping a row.** The capture presses `alt+h` and captures the
  default selection. It does not press `enter`, so no pending pick was recorded.
- **It is a Windows-or-macOS-blind pipeline.** `capture.py` uses `pty`,
  `termios` and `fcntl`, which are POSIX only. The hub itself runs anywhere Node
  does; this renderer does not.
- **Legibility is a trade-off.** At 140 columns a scaled-to-880px image has about
  6.3 pixels per character, which is enough to see the layout, the six marker
  colours and the shape of the text, not to read every word. Fewer columns would
  mean bigger text and no harness names: below 138 columns the list pane is under
  58 columns wide and the browser drops the labels to keep the glyph and the
  colour. The PNG is rendered at a high enough resolution (2219x1576, 26px font)
  to stay sharp when it is opened full size.
