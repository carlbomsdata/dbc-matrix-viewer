"use strict";

/* Bit-layout regression tests. No dependencies — run with:  node --test
 *
 * The DBC start bit is the signal's LSB for Intel (@1) and its MSB for
 * Motorola (@0). Getting that backwards is the classic way to draw a layout
 * matrix that looks plausible and is wrong, so it is pinned down here. */

const test = require("node:test");
const assert = require("node:assert");

const { signalBitOrder, signalCells, bitToCell, decodeCanId, parseDbc } = require("./app.js");

const bytesOf = (start, len, littleEndian) => {
  const seen = new Set(signalCells(start, len, littleEndian).map((c) => c.byte));
  return [...seen].sort((a, b) => a - b);
};

test("bitToCell puts the MSB in column 0", () => {
  assert.deepStrictEqual(bitToCell(7), { byte: 0, col: 0 });
  assert.deepStrictEqual(bitToCell(0), { byte: 0, col: 7 });
  assert.deepStrictEqual(bitToCell(23), { byte: 2, col: 0 });
  assert.deepStrictEqual(bitToCell(63), { byte: 7, col: 0 });
});

test("Motorola start 7 length 8 occupies exactly byte 0", () => {
  assert.deepStrictEqual(signalBitOrder(7, 8, false), [7, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepStrictEqual(bytesOf(7, 8, false), [0]);
});

test("Motorola start 23 length 16 occupies exactly bytes 2-3", () => {
  assert.deepStrictEqual(
    signalBitOrder(23, 16, false),
    [23, 22, 21, 20, 19, 18, 17, 16, 31, 30, 29, 28, 27, 26, 25, 24]
  );
  assert.deepStrictEqual(bytesOf(23, 16, false), [2, 3]);
});

test("Motorola 16-bit signals at 7/23/39/55 tile the frame in byte pairs", () => {
  assert.deepStrictEqual(bytesOf(7, 16, false), [0, 1]);
  assert.deepStrictEqual(bytesOf(23, 16, false), [2, 3]);
  assert.deepStrictEqual(bytesOf(39, 16, false), [4, 5]);
  assert.deepStrictEqual(bytesOf(55, 16, false), [6, 7]);

  // Together they cover all 64 bits exactly once.
  const all = [7, 23, 39, 55].flatMap((start) => signalBitOrder(start, 16, false));
  assert.strictEqual(new Set(all).size, 64);
});

test("Motorola 8-bit signals at 7/15/.../55 give one signal per byte", () => {
  for (let byte = 0; byte < 8; byte++) {
    assert.deepStrictEqual(bytesOf(byte * 8 + 7, 8, false), [byte]);
  }
});

test("Intel bits are contiguous in absolute index", () => {
  assert.deepStrictEqual(signalBitOrder(23, 16, true), [
    23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
  ]);
  // Start 23 is the LSB and sits in byte 2, so 16 bits run into byte 4.
  assert.deepStrictEqual(bytesOf(23, 16, true), [2, 3, 4]);

  // A byte-aligned Intel signal is the one that lands on bytes 2-3.
  assert.deepStrictEqual(bytesOf(16, 16, true), [2, 3]);
  assert.deepStrictEqual(bytesOf(0, 8, true), [0]);
});

test("Intel and Motorola disagree for the same start bit", () => {
  assert.notDeepStrictEqual(signalBitOrder(23, 16, true), signalBitOrder(23, 16, false));
});

test("degenerate inputs produce no cells instead of throwing", () => {
  assert.deepStrictEqual(signalBitOrder(0, 0, false), []);
  assert.deepStrictEqual(signalBitOrder(-1, 8, true), []);
  assert.deepStrictEqual(signalBitOrder(7, NaN, false), []);
});

test("J1939 PDU2 identifier decodes", () => {
  const can = decodeCanId(0x98ff6080);
  assert.strictEqual(can.extended, true);
  assert.strictEqual(can.id, 0x18ff6080);
  assert.strictEqual(can.priority, 6);
  assert.strictEqual(can.pduFormat, 0xff);
  assert.strictEqual(can.pgn, 0xff60);
  assert.strictEqual(can.sourceAddress, 0x80);
  assert.strictEqual(can.destinationAddress, undefined);
});

test("J1939 PDU1 identifier keeps the destination address out of the PGN", () => {
  const can = decodeCanId(0x18ea2140); // PF 0xEA (request), DA 0x21, SA 0x40
  assert.strictEqual(can.pgn, 0xea00);
  assert.strictEqual(can.destinationAddress, 0x21);
  assert.strictEqual(can.sourceAddress, 0x40);
});

test("11-bit identifiers stay standard", () => {
  const can = decodeCanId(0x123);
  assert.strictEqual(can.extended, false);
  assert.strictEqual(can.hex, "0x123");
});

const SAMPLE = [
  'VERSION ""',
  "",
  "BU_: PLC_TO_HMI HMI_TO_PLC",
  "",
  "BO_ 2566873216 PLC_TO_HMI_FN: 8 PLC_TO_HMI",
  ' SG_ PLC_TO_HMI_FN_F1_STATE : 7|8@0+ (1,0) [0|255] "" Vector__XXX',
  ' SG_ PLC_TO_HMI_FN_F2_STATE : 15|8@0+ (1,0) [0|255] "" Vector__XXX',
  "",
  "BO_ 291 MUXED: 8 ECU",
  ' SG_ Mode M : 7|8@0+ (1,0) [0|255] "" Vector__XXX',
  ' SG_ Speed m0 : 23|16@1- (0.1,-50) [0|0] "km/h"  Dash,Logger',
  "",
  'CM_ BO_ 2566873216 "Function key states";',
  'CM_ SG_ 291 Speed "Wheel speed',
  'measured at the hub";',
  'VAL_ 291 Mode 1 "Running" 0 "Idle" ;',
  "",
].join("\r\n");

test("parses messages, signals, comments and value tables", () => {
  const db = parseDbc(SAMPLE);
  assert.strictEqual(db.messages.length, 2);
  assert.strictEqual(db.signalCount, 4);
  assert.deepStrictEqual(db.nodes, ["PLC_TO_HMI", "HMI_TO_PLC"]);

  const fn = db.messages[0];
  assert.strictEqual(fn.name, "PLC_TO_HMI_FN");
  assert.strictEqual(fn.dlc, 8);
  assert.strictEqual(fn.transmitter, "PLC_TO_HMI");
  assert.strictEqual(fn.comment.text, "Function key states");
  assert.strictEqual(fn.line, "BO_ 2566873216 PLC_TO_HMI_FN: 8 PLC_TO_HMI");
  assert.deepStrictEqual(bytesOf(fn.signals[0].startBit, fn.signals[0].length, false), [0]);
  assert.deepStrictEqual(bytesOf(fn.signals[1].startBit, fn.signals[1].length, false), [1]);

  const muxed = db.messages[1];
  const mode = muxed.signals.find((s) => s.name === "Mode");
  const speed = muxed.signals.find((s) => s.name === "Speed");

  assert.strictEqual(mode.mux, "M");
  assert.strictEqual(mode.isMultiplexor, true);
  assert.deepStrictEqual(mode.values, [
    { value: 0, label: "Idle" },
    { value: 1, label: "Running" },
  ]);

  assert.strictEqual(speed.mux, "m0");
  assert.strictEqual(speed.muxValue, 0);
  assert.strictEqual(speed.littleEndian, true);
  assert.strictEqual(speed.signed, true);
  assert.strictEqual(speed.factor, 0.1);
  assert.strictEqual(speed.offset, -50);
  assert.strictEqual(speed.unit, "km/h");
  assert.deepStrictEqual(speed.receivers, ["Dash", "Logger"]);
  // The comment wrapped onto a second line and must survive verbatim.
  assert.strictEqual(speed.comment.text, "Wheel speed\nmeasured at the hub");
});

test("signal lines are kept verbatim for the source panel", () => {
  const db = parseDbc(SAMPLE);
  const sig = db.messages[0].signals[0];
  assert.strictEqual(
    sig.line,
    ' SG_ PLC_TO_HMI_FN_F1_STATE : 7|8@0+ (1,0) [0|255] "" Vector__XXX'
  );
});

test("a non-DBC file is rejected with a message, not a crash", () => {
  assert.throws(() => parseDbc("hello world\nthis is not a dbc\n"), /does not look like a CAN database/);
});

/* ---- Proprietary B range ---- */

const { isProprietaryB, PGN_BASE, PGN_END } = require("./app.js");

const withPgn = (rawId) => ({ can: decodeCanId(rawId) });

test("Proprietary B is the PGN range the allocation grid draws", () => {
  assert.strictEqual(PGN_BASE, 0xff00);
  assert.strictEqual(PGN_END, 0xffff);
  assert.strictEqual(PGN_END - PGN_BASE + 1, 256); // 16 rows x 16 columns
});

test("Proprietary B membership", () => {
  assert.strictEqual(isProprietaryB(withPgn(0x18ff6080)), true); // PGN 0xFF60
  assert.strictEqual(isProprietaryB(withPgn(0x18ff0000)), true); // first cell
  assert.strictEqual(isProprietaryB(withPgn(0x18ffff00)), true); // last cell
  assert.strictEqual(isProprietaryB(withPgn(0x18fee600)), false); // 0xFEE6, below the range
  assert.strictEqual(isProprietaryB(withPgn(0x18ef0000)), false); // Proprietary A
  assert.strictEqual(isProprietaryB(withPgn(0x123)), false); // 11-bit
});

test("every Proprietary B PGN lands in exactly one grid cell", () => {
  const seen = new Set();
  for (let hi = 0; hi < 16; hi++) {
    for (let lo = 0; lo < 16; lo++) {
      seen.add(PGN_BASE | (hi << 4) | lo);
    }
  }
  assert.strictEqual(seen.size, 256);
  assert.ok(seen.has(0xff60));
  assert.ok(seen.has(PGN_BASE));
  assert.ok(seen.has(PGN_END));
});

test("a PDU2 identifier maps to the grid cell its PGN names", () => {
  const can = decodeCanId(0x18ff6080);
  assert.strictEqual((can.pgn >> 4) & 0xf, 0x6); // row FF6x
  assert.strictEqual(can.pgn & 0xf, 0x0); // column 0
});

/* ---- regressions found in review ---- */

const { GRID_RANGES, rangeById, rangeCellCount } = require("./app.js");

test("PDU1 does not fold a data page onto page zero", () => {
  const pdu1 = rangeById("pdu1");
  const page0 = { can: decodeCanId(0x18 << 24 | 0x0a << 16) }; // PF 0x0A, DP 0
  const page1 = { can: decodeCanId((0x18 << 24) | (1 << 24) | (0x0a << 16)) };

  assert.strictEqual(page0.can.pgn, 0x0a00);
  assert.strictEqual(pdu1.cellOf(page0), 0x0a);
  assert.ok(page1.can.pgn > 0xffff, "the data page bit lands above the PGN low word");
  assert.strictEqual(pdu1.cellOf(page1), -1, "it used to share 0x0A00's cell and be mislabelled");
});

test("every range maps a slot back to the identifier it names", () => {
  for (const range of GRID_RANGES) {
    assert.strictEqual(typeof range.identifierOf, "function", range.id);
    assert.strictEqual(range.cols * range.rows, rangeCellCount(range), range.id);
    // valueOf would have shadowed Object.prototype.valueOf
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(range, "valueOf"),
      false,
      range.id + " must not shadow valueOf"
    );
  }
  assert.strictEqual(rangeById("propb").identifierOf(0x60), 0xff60);
  assert.strictEqual(rangeById("std11").identifierOf(0x123), 0x123);
  assert.strictEqual(rangeById("pdu2").identifierOf(0), 0xf000);
  assert.strictEqual(rangeById("pdu1").identifierOf(0xea), 0xea00);
});

test("every theme is well formed and every palette is distinguishable", () => {
  const { GRID_THEMES, signalPaint } = require("./app.js");
  assert.ok(GRID_THEMES.length >= 15, "expected a decent spread of themes");

  const ids = new Set();
  for (const theme of GRID_THEMES) {
    assert.ok(theme.id && theme.label, JSON.stringify(theme.id));
    assert.strictEqual(ids.has(theme.id), false, "duplicate id " + theme.id);
    ids.add(theme.id);
    assert.ok(theme.paints.length >= 8, theme.id + " needs at least eight paints");

    for (const p of theme.paints) {
      assert.ok(p.h >= 0 && p.h < 360, theme.id + " hue " + p.h);
      assert.ok(p.c >= 0 && p.c <= 0.4, theme.id + " chroma " + p.c);
      assert.ok(p.l > 0.2 && p.l <= 1, theme.id + " lightness " + p.l);
    }

    // Neighbouring files must not land on near-identical colours.
    for (let i = 1; i < theme.paints.length; i++) {
      const a = theme.paints[i - 1];
      const b = theme.paints[i];
      const dh = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h));
      const apart = dh > 12 || Math.abs(a.l - b.l) > 0.06 || Math.abs(a.c - b.c) > 0.04;
      assert.ok(apart, theme.id + ": paints " + (i - 1) + " and " + i + " are too close");
    }

    if (theme.field) {
      assert.ok(theme.field.bg && theme.field.ink && theme.field.rule, theme.id + " field");
    }
  }

  // The signal palette inside a message is independent of the grid theme.
  assert.notStrictEqual(signalPaint(0).hue, signalPaint(1).hue);
});
