# dbc-matrix-viewer

Maps the J1939 Proprietary B PGN range from your CAN database files — which of
the 256 parameter groups are claimed, by which file, and what is still free —
then drills into any message's byte × bit layout. Runs in the browser; nothing
is uploaded.

**Live:** <https://carlbomsdata.github.io/dbc-matrix-viewer/>

## Use

Drop one or more `.dbc` files on the page. Each gets a colour and a renameable
label, so a vehicle network and the subsystems layered on top of it read apart
at a glance. The grid covers PGN `0xFF00`–`0xFFFF`: rows are the high nibble of
the low byte, columns the low nibble. A hatched cell means two files claim the
same PGN.

Click a claimed cell to open the messages behind it. Each one gets a byte × bit
matrix — rows are bytes, columns bit 7 → 0 — plus every signal with its start
bit, length, byte order, sign, scaling, unit and value table. Click a cell or a
signal to see that signal's raw DBC text: the `BO_`, `SG_`, `CM_` and `VAL_`
lines exactly as they appear in your file, with a copy button. Escape closes.

The filter box matches message name, signal name, CAN identifier or PGN, and
dims the cells that do not match. Messages outside Proprietary B — J1939
broadcasts, Proprietary A, transport protocol, 11-bit frames — are listed under
the map rather than plotted.

## Bit geometry

Intel and Motorola signals are laid out the way the DBC format really defines
them: the start bit is the signal's LSB for Intel (`@1`) and its MSB for
Motorola (`@0`), and the Motorola walk steps down inside a byte before jumping
to the top of the next one. That is the part everyone gets wrong, so it is
pinned down by tests in `bit-layout.test.js`.

## Run

Static files, no build and no dependencies: `python3 -m http.server 8000`.
Tests are `node --test`. Pushing to `main` publishes through GitHub Pages.

## Files

| File                 |                                                             |
| -------------------- | ----------------------------------------------------------- |
| `index.html`         | Page structure                                              |
| `app.js`             | DBC parser, bit geometry, J1939 decoding, map and rendering |
| `styles.css`         | Styles, light and dark                                      |
| `bit-layout.test.js` | Bit-layout, PGN range and parser tests                      |
