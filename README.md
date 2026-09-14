# dbc-matrix-viewer

Maps which CAN identifiers a database claims, which are free, and which file
claimed them, then drills into any message's byte × bit signal layout. Runs in
the browser; the files are never uploaded.

**Live:** <https://carlbomsdata.github.io/dbc-matrix-viewer/>

## Use

Drop one or more `.dbc` files on the page. Each gets a colour and a renameable
label, so a vehicle network and the subsystems layered on top of it read apart
at a glance. A hatched cell means two files claim the same slot.

The grid covers whichever identifier space the files actually use, picked
automatically:

| Range | Covers | Typical file |
| --- | --- | --- |
| Proprietary B | PGN `0xFF00`–`0xFFFF`, 16 × 16 | J1939 |
| Standard 11-bit | id `0x000`–`0x7FF`, 64 × 32 | plain CAN |

Override it with the range selector. Anything outside the shown range —
J1939 broadcasts, Proprietary A, transport protocol, 29-bit frames — is listed
under the map and opens the same detail view.

Click a claimed cell for the messages behind it. Each gets a byte × bit matrix,
rows are bytes and columns bit 7 → 0, plus every signal with its start bit,
length, byte order, sign, scaling, unit and value table. Click a cell or a
signal for that signal's raw DBC text: the `BO_`, `SG_`, `CM_` and `VAL_` lines
exactly as they appear in your file, with a copy button. Escape closes.

The filter box matches message name, signal name, CAN identifier or PGN, and
dims the cells that do not match. Five grid themes are available, including
Okabe–Ito for colour vision deficiency.

## Bit geometry

Intel and Motorola signals are laid out the way the DBC format really defines
them: the start bit is the signal's LSB for Intel (`@1`) and its MSB for
Motorola (`@0`), and the Motorola walk steps down inside a byte before jumping
to the top of the next one. That is the part everyone gets wrong, so it is
pinned down by tests.

## Files it reads

Line endings are LF, CRLF or CR. Encoding is taken from a byte order mark when
there is one, then tried as UTF-8, then as Windows-1252, which is what Vector
and CANdb++ write by default. `VAL_TABLE_` references resolve, comments may
wrap across lines, and a comment missing its trailing semicolon does not eat
the messages after it.

The parser was checked against 202 public files from
[cantools](https://github.com/cantools/cantools) and
[opendbc](https://github.com/commaai/opendbc): all 202 parse, with no message,
signal, comment or value table lost.

## Run

Static files, no build and no dependencies: `python3 -m http.server 8000`.
Tests are `node --test`. Pushing to `main` publishes through GitHub Pages.

| File | |
| --- | --- |
| `index.html` | Page structure |
| `app.js` | Parser, bit geometry, identifier decoding, map and rendering |
| `styles.css` | Styles, light and dark |
| `bit-layout.test.js` | Bit layout, range and identifier decoding tests |
| `dbc-parser.test.js` | Parser tests, including shapes found in the wild |
