"use strict";

/* Parser coverage across the shapes real .dbc exports actually take. Vector,
 * CANdb++, Kvaser, candb and hand-written files all differ in line endings,
 * encoding, indentation and which optional sections they emit. Run with:
 * node --test */

const test = require("node:test");
const assert = require("node:assert");

const { parseDbc, decodeDbcBytes } = require("./app.js");

const lines = (...rows) => rows.join("\n");
const crlf = (text) => text.replace(/\n/g, "\r\n");
const cr = (text) => text.replace(/\n/g, "\r");

const MINIMAL = lines(
  'VERSION "1.0"',
  "",
  "BU_: ECU DASH",
  "",
  "BO_ 291 Engine: 8 ECU",
  ' SG_ Rpm : 7|16@0+ (0.25,0) [0|8000] "rpm" DASH',
  ""
);

const firstSignal = (db) => db.messages[0].signals[0];

/* ---- line endings and encoding ---- */

test("accepts LF, CRLF and CR line endings alike", () => {
  for (const [name, text] of [["LF", MINIMAL], ["CRLF", crlf(MINIMAL)], ["CR", cr(MINIMAL)]]) {
    const db = parseDbc(text);
    assert.strictEqual(db.messages.length, 1, name);
    assert.strictEqual(db.signalCount, 1, name);
    assert.strictEqual(firstSignal(db).name, "Rpm", name);
  }
});

test("a UTF-8 byte order mark does not break the first line", () => {
  const db = parseDbc("﻿" + MINIMAL);
  assert.strictEqual(db.version, "1.0");
  assert.strictEqual(db.messages.length, 1);
});

test("decodes UTF-8, UTF-8 with BOM, UTF-16 and Windows-1252", () => {
  const utf8 = new TextEncoder().encode('SG_ T : 0|8@1+ (1,0) [0|0] "°C"  X');
  assert.ok(decodeDbcBytes(utf8).includes("°C"));

  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  assert.ok(decodeDbcBytes(bom).startsWith("SG_"), "BOM is stripped");

  // Windows-1252: 0xB0 is the degree sign, which is not valid UTF-8 on its own.
  const cp1252 = Uint8Array.from('SG_ T : 0|8@1+ (1,0) [0|0] "\xb0C"  X', (c) => c.charCodeAt(0));
  assert.ok(decodeDbcBytes(cp1252).includes("°C"), "falls back to Windows-1252");

  const utf16le = new Uint8Array([0xff, 0xfe, 0x42, 0x00, 0x4f, 0x00, 0x5f, 0x00]);
  assert.strictEqual(decodeDbcBytes(utf16le), "BO_");
});

test("tabs are as good as spaces for indentation", () => {
  const db = parseDbc(lines("BO_ 291 Engine: 8 ECU", '\tSG_ Rpm : 7|16@0+ (1,0) [0|0] "" ECU', ""));
  assert.strictEqual(db.signalCount, 1);
});

/* ---- the NS_ header block ---- */

test("the NS_ block does not swallow the file", () => {
  const db = parseDbc(
    lines(
      'VERSION ""',
      "",
      "NS_ : ",
      "\tNS_DESC_",
      "\tCM_",
      "\tBA_DEF_",
      "\tBA_",
      "\tVAL_",
      "\tVAL_TABLE_",
      "\tSG_MUL_VAL_",
      "",
      "BS_:",
      "",
      "BU_: ECU",
      "",
      "BO_ 291 Engine: 8 ECU",
      ' SG_ Rpm : 7|16@0+ (1,0) [0|0] "" ECU',
      ""
    )
  );
  assert.strictEqual(db.messages.length, 1);
  assert.strictEqual(db.signalCount, 1);
});

/* ---- BO_ shapes ---- */

test("message identifiers, DLCs and transmitters", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 Standard: 8 ECU",
      "BO_ 2566873216 Extended: 8 PLC",
      "BO_ 100 Empty: 0 Vector__XXX",
      "BO_ 101 CanFd: 64 ECU",
      ""
    )
  );
  const [std, ext, empty, fd] = db.messages;

  assert.strictEqual(std.can.extended, false);
  assert.strictEqual(std.can.hex, "0x123");

  assert.strictEqual(ext.can.extended, true);
  assert.strictEqual(ext.can.pgn, 0xff60);

  assert.strictEqual(empty.dlc, 0);
  assert.deepStrictEqual(empty.signals, []);
  assert.strictEqual(empty.transmitter, "Vector__XXX");

  assert.strictEqual(fd.dlc, 64);
});

test("a message with no signals is kept, not dropped", () => {
  const db = parseDbc("BO_ 100 Empty: 8 ECU\n");
  assert.strictEqual(db.messages.length, 1);
  assert.strictEqual(db.signalCount, 0);
});

/* ---- SG_ shapes ---- */

const SIGNAL_CASES = [
  ['SG_ Plain : 0|8@1+ (1,0) [0|255] "" ECU', { name: "Plain", littleEndian: true, signed: false }],
  ['SG_ Signed : 0|16@1- (1,0) [-100|100] "" ECU', { signed: true }],
  ['SG_ Motorola : 7|16@0+ (1,0) [0|0] "" ECU', { littleEndian: false }],
  ['SG_ Scaled : 0|16@1+ (0.0009765625,-31.374) [0|0] "rad" ECU', { factor: 0.0009765625, offset: -31.374 }],
  ['SG_ Exponent : 0|16@1+ (1E-3,1e2) [0|0] "" ECU', { factor: 0.001, offset: 100 }],
  ['SG_ Spaced  :  0|8@1+  (1,0)  [0|255]  "km/h"  ECU', { unit: "km/h" }],
  ['SG_ NoRecv : 0|8@1+ (1,0) [0|255] ""', { receivers: [] }],
  ['SG_ ManyRecv : 0|8@1+ (1,0) [0|255] "" A,B,C', { receivers: ["A", "B", "C"] }],
  ['SG_ SpaceRecv : 0|8@1+ (1,0) [0|255] ""  A, B', { receivers: ["A", "B"] }],
  ['SG_ Unit_With_Space : 0|8@1+ (1,0) [0|255] "m per s" ECU', { unit: "m per s" }],
  ['SG_ Digits9 : 0|8@1+ (1,0) [0|255] "" ECU', { name: "Digits9" }],
];

test("every documented SG_ shape parses", () => {
  for (const [line, expected] of SIGNAL_CASES) {
    const db = parseDbc(lines("BO_ 291 M: 8 ECU", " " + line, ""));
    assert.strictEqual(db.signalCount, 1, "unparsed: " + line);
    const sig = firstSignal(db);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepStrictEqual(sig[key], value, key + " in: " + line);
    }
  }
});

test("multiplexor tokens", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 M: 8 ECU",
      ' SG_ Mode M : 7|8@0+ (1,0) [0|255] "" ECU',
      ' SG_ OnZero m0 : 15|8@0+ (1,0) [0|255] "" ECU',
      ' SG_ OnTwelve m12 : 23|8@0+ (1,0) [0|255] "" ECU',
      ' SG_ Nested m3M : 31|8@0+ (1,0) [0|255] "" ECU',
      ""
    )
  );
  const by = Object.fromEntries(db.messages[0].signals.map((s) => [s.name, s]));

  assert.strictEqual(by.Mode.mux, "M");
  assert.strictEqual(by.Mode.isMultiplexor, true);
  assert.strictEqual(by.Mode.muxValue, null);

  assert.strictEqual(by.OnZero.muxValue, 0);
  assert.strictEqual(by.OnTwelve.muxValue, 12);

  assert.strictEqual(by.Nested.mux, "m3M");
  assert.strictEqual(by.Nested.muxValue, 3);
  assert.strictEqual(by.Nested.isMultiplexor, true, "m3M is both multiplexed and a multiplexor");
});

test("a malformed SG_ line is skipped without losing its neighbours", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 M: 8 ECU",
      " SG_ Broken : 7|8@0+ (1,0)",
      ' SG_ Fine : 15|8@0+ (1,0) [0|255] "" ECU',
      ""
    )
  );
  assert.strictEqual(db.signalCount, 1);
  assert.strictEqual(firstSignal(db).name, "Fine");
});

/* ---- CM_ shapes ---- */

test("comments on messages and signals, including the awkward ones", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 M: 8 ECU",
      ' SG_ A : 7|8@0+ (1,0) [0|255] "" ECU',
      ' SG_ B : 15|8@0+ (1,0) [0|255] "" ECU',
      ' SG_ C : 23|8@0+ (1,0) [0|255] "" ECU',
      "",
      'CM_ BO_ 291 "Engine block";',
      'CM_ SG_ 291 A "range: 0 - 250 ; 251 - 255 error";',
      'CM_ SG_ 291 B "first line',
      'second line";',
      'CM_ BU_ ECU "a node comment";',
      'CM_ "a database comment";',
      ""
    )
  );
  const msg = db.messages[0];
  const by = Object.fromEntries(msg.signals.map((s) => [s.name, s]));

  assert.strictEqual(msg.comment.text, "Engine block");
  assert.strictEqual(by.A.comment.text, "range: 0 - 250 ; 251 - 255 error", "semicolon inside quotes");
  assert.strictEqual(by.B.comment.text, "first line\nsecond line", "comment wrapped across lines");
  assert.strictEqual(by.C.comment, null);
});

test("node and database comments do not derail the following message", () => {
  const db = parseDbc(
    lines('CM_ BU_ ECU "node";', 'CM_ "global";', "BO_ 291 M: 8 ECU", ' SG_ A : 7|8@0+ (1,0) [0|0] "" ECU', "")
  );
  assert.strictEqual(db.messages.length, 1);
  assert.strictEqual(db.signalCount, 1);
});

/* ---- VAL_ and VAL_TABLE_ ---- */

test("inline value descriptions", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 M: 8 ECU",
      ' SG_ Gear : 7|8@0+ (1,0) [0|255] "" ECU',
      'VAL_ 291 Gear 2 "Second" 1 "First" 0 "Neutral" -1 "Reverse" ;',
      ""
    )
  );
  assert.deepStrictEqual(firstSignal(db).values, [
    { value: -1, label: "Reverse" },
    { value: 0, label: "Neutral" },
    { value: 1, label: "First" },
    { value: 2, label: "Second" },
  ]);
});

test("a VAL_ that references a VAL_TABLE_ by name resolves", () => {
  const db = parseDbc(
    lines(
      'VAL_TABLE_ GearTable 1 "First" 0 "Neutral" ;',
      "BO_ 291 M: 8 ECU",
      ' SG_ Gear : 7|8@0+ (1,0) [0|255] "" ECU',
      "VAL_ 291 Gear GearTable ;",
      ""
    )
  );
  assert.deepStrictEqual(firstSignal(db).values, [
    { value: 0, label: "Neutral" },
    { value: 1, label: "First" },
  ]);
});

test("value labels may contain spaces, punctuation and escaped quotes", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 M: 8 ECU",
      ' SG_ S : 7|8@0+ (1,0) [0|255] "" ECU',
      'VAL_ 291 S 1 "Not available / error" 0 "say \\"hi\\"" ;',
      ""
    )
  );
  const values = firstSignal(db).values;
  assert.strictEqual(values.length, 2);
  assert.strictEqual(values[1].label, "Not available / error");
});

test("a VAL_ for an unknown signal is ignored rather than throwing", () => {
  const db = parseDbc(
    lines("BO_ 291 M: 8 ECU", ' SG_ S : 7|8@0+ (1,0) [0|0] "" ECU', 'VAL_ 999 Ghost 0 "x" ;', "")
  );
  assert.strictEqual(db.messages.length, 1);
  assert.strictEqual(firstSignal(db).values, null);
});

/* ---- sections that must be tolerated ---- */

const NOISE = lines(
  'BA_DEF_ BO_  "GenMsgCycleTime" INT 0 65535;',
  'BA_DEF_DEF_  "GenMsgCycleTime" 100;',
  'BA_ "GenMsgCycleTime" BO_ 291 20;',
  "BO_TX_BU_ 291 : ECU,GATEWAY;",
  "SIG_VALTYPE_ 291 Rpm : 1;",
  "SG_MUL_VAL_ 291 Rpm Mode 1-3;",
  "SIG_GROUP_ 291 GroupName 1 : Rpm;",
  'EV_ Var1: 0 [0|100] "" 0 1 DUMMY_NODE_VECTOR0 Vector__XXX;',
  "BA_DEF_REL_ BU_SG_REL_  \"Rel\" INT 0 1;",
  'CM_ EV_ Var1 "an environment variable";'
);

test("attribute, group, valtype and environment sections are tolerated", () => {
  const db = parseDbc(
    lines("BO_ 291 Engine: 8 ECU", ' SG_ Rpm : 7|16@0+ (1,0) [0|0] "" ECU', "", NOISE, "")
  );
  assert.strictEqual(db.messages.length, 1);
  assert.strictEqual(db.signalCount, 1);
  assert.strictEqual(firstSignal(db).name, "Rpm");
});

test("sections before the first BO_ are tolerated too", () => {
  const db = parseDbc(lines(NOISE, "", "BO_ 291 Engine: 8 ECU", ' SG_ Rpm : 7|16@0+ (1,0) [0|0] "" ECU', ""));
  assert.strictEqual(db.messages.length, 1);
  assert.strictEqual(db.signalCount, 1);
});

/* ---- structure ---- */

test("duplicate message identifiers are both kept", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 First: 8 A",
      ' SG_ X : 7|8@0+ (1,0) [0|0] "" A',
      "BO_ 291 Second: 8 B",
      ' SG_ Y : 7|8@0+ (1,0) [0|0] "" B',
      ""
    )
  );
  assert.strictEqual(db.messages.length, 2);
  assert.deepStrictEqual(db.messages.map((m) => m.name), ["First", "Second"]);
});

test("signals are ordered by the first cell they occupy", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 M: 8 ECU",
      ' SG_ Later : 39|8@0+ (1,0) [0|0] "" ECU',
      ' SG_ Earlier : 7|8@0+ (1,0) [0|0] "" ECU',
      ' SG_ Middle : 23|8@0+ (1,0) [0|0] "" ECU',
      ""
    )
  );
  assert.deepStrictEqual(db.messages[0].signals.map((s) => s.name), ["Earlier", "Middle", "Later"]);
});

test("a signal reaching past the DLC still gets cells", () => {
  const db = parseDbc(lines("BO_ 291 M: 2 ECU", ' SG_ Long : 0|64@1+ (1,0) [0|0] "" ECU', ""));
  const sig = firstSignal(db);
  assert.strictEqual(sig.cells.length, 64);
  assert.strictEqual(sig.cells[sig.cells.length - 1].byte, 7);
});

test("empty and whitespace-only files are rejected with a message", () => {
  for (const text of ["", "\n\n\n", "   \n\t\n"]) {
    assert.throws(() => parseDbc(text), /does not look like a CAN database/);
  }
});

test("node lists", () => {
  assert.deepStrictEqual(parseDbc(lines("BU_: A B C", "BO_ 1 M: 8 A", "")).nodes, ["A", "B", "C"]);
  assert.deepStrictEqual(parseDbc(lines("BU_:", "BO_ 1 M: 8 A", "")).nodes, []);
  assert.deepStrictEqual(parseDbc(lines("BU_: ", "BO_ 1 M: 8 A", "")).nodes, []);
});

test("verbatim source lines survive for every statement kind", () => {
  const src = lines(
    "BO_ 291 M: 8 ECU",
    ' SG_ S : 7|8@0+ (1,0) [0|255] "u" ECU',
    'CM_ BO_ 291 "msg";',
    'CM_ SG_ 291 S "sig";',
    'VAL_ 291 S 0 "zero" ;',
    ""
  );
  const db = parseDbc(src);
  const msg = db.messages[0];
  const sig = msg.signals[0];
  assert.strictEqual(msg.line, "BO_ 291 M: 8 ECU");
  assert.strictEqual(sig.line, ' SG_ S : 7|8@0+ (1,0) [0|255] "u" ECU');
  assert.strictEqual(msg.comment.line, 'CM_ BO_ 291 "msg";');
  assert.strictEqual(sig.comment.line, 'CM_ SG_ 291 S "sig";');
  assert.strictEqual(sig.valueLine, 'VAL_ 291 S 0 "zero" ;');
});

/* ---- shapes found by running the parser over public DBC corpora ----
 *
 * These are distilled from opendbc and the cantools test files rather than
 * invented, because the interesting failures were all things nobody would
 * think to write by hand. */

test("a CM_ with no trailing semicolon does not swallow the next message", () => {
  // opendbc/dbc/toyota_radar_dsu_tssp.dbc: a bare CM_ "Front target" between
  // two messages used to eat the following six BO_ blocks whole.
  const db = parseDbc(
    lines(
      "BO_ 791 OBJECT_11: 8 RADAR",
      ' SG_ ID : 5|6@0+ (1,0) [0|255] "" XXX',
      "",
      'CM_ "Front target"',
      "BO_ 1664 CLUSTER_F: 8 RADAR",
      ' SG_ LONG_DIST : 7|13@1+ (0.03,0) [0|255] "m" XXX',
      "BO_ 1665 CLUSTER_F_A: 8 RADAR",
      ' SG_ LAT_DIST : 20|11@1- (0.015,0) [-20|20] "m" XXX',
      ""
    )
  );
  assert.strictEqual(db.messages.length, 3);
  assert.strictEqual(db.signalCount, 3);
  assert.deepStrictEqual(db.messages.map((m) => m.name), ["OBJECT_11", "CLUSTER_F", "CLUSTER_F_A"]);
});

test("a semicolon-less CM_ SG_ does not swallow the comments after it", () => {
  const db = parseDbc(
    lines(
      "BO_ 919 LDW: 8 XXX",
      ' SG_ A : 7|8@0+ (1,0) [0|255] "" XXX',
      ' SG_ B : 15|8@0+ (1,0) [0|255] "" XXX',
      'CM_ SG_ 919 A "no semicolon here"',
      'CM_ SG_ 919 B "but this one still lands";',
      ""
    )
  );
  const by = Object.fromEntries(db.messages[0].signals.map((s) => [s.name, s]));
  assert.strictEqual(by.A.comment.text, "no semicolon here");
  assert.strictEqual(by.B.comment.text, "but this one still lands");
});

test("a genuinely wrapped comment is still joined", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 M: 8 ECU",
      ' SG_ A : 7|8@0+ (1,0) [0|255] "" ECU',
      ' SG_ B : 15|8@0+ (1,0) [0|255] "" ECU',
      'CM_ SG_ 291 A "line one',
      'line two"',
      'CM_ SG_ 291 B "after";',
      ""
    )
  );
  const by = Object.fromEntries(db.messages[0].signals.map((s) => [s.name, s]));
  assert.strictEqual(by.A.comment.text, "line one\nline two");
  assert.strictEqual(by.B.comment.text, "after", "the wrapped comment released the next line");
});

test("an escaped quote inside a comment does not leave the string open", () => {
  const db = parseDbc(
    lines(
      "BO_ 291 M: 8 ECU",
      ' SG_ A : 7|8@0+ (1,0) [0|255] "" ECU',
      ' SG_ B : 15|8@0+ (1,0) [0|255] "" ECU',
      'CM_ SG_ 291 A "he said \\"go\\" loudly";',
      'CM_ SG_ 291 B "next";',
      ""
    )
  );
  const by = Object.fromEntries(db.messages[0].signals.map((s) => [s.name, s]));
  assert.strictEqual(by.B.comment.text, "next");
});

test("a VAL_ with an empty choice list keeps its source line", () => {
  // cantools tests/files/dbc/empty_choice.dbc
  const db = parseDbc(
    lines(
      "BO_ 10 M: 8 ECU",
      ' SG_ empty_choice : 7|8@0+ (1,0) [0|255] "" ECU',
      "VAL_ 10 empty_choice ;",
      ""
    )
  );
  const sig = firstSignal(db);
  assert.strictEqual(sig.valueLine, "VAL_ 10 empty_choice ;");
  assert.strictEqual(sig.values, null, "no choices to list");
});

test("a database with no messages is accepted, not rejected", () => {
  // opendbc ships include fragments that are nothing but CM_ IMPORT lines.
  const db = parseDbc(lines('CM_ "IMPORT _honda_common.dbc";', 'CM_ "IMPORT _bosch_2018.dbc";', ""));
  assert.strictEqual(db.messages.length, 0);
  assert.strictEqual(db.signalCount, 0);

  const headerOnly = parseDbc(lines('VERSION ""', "NS_ :", "\tCM_", "BS_:", "BU_: ECU", ""));
  assert.strictEqual(headerOnly.messages.length, 0);
  assert.deepStrictEqual(headerOnly.nodes, ["ECU"]);
});

test("something that is not a CAN database is still rejected", () => {
  assert.throws(() => parseDbc("hello world\nthis is a text file\n"), /does not look like a CAN database/);
  assert.throws(() => parseDbc("{\n  \"json\": true\n}\n"), /does not look like a CAN database/);
});

test("a VAL_ or CM_ naming a signal that does not exist is ignored quietly", () => {
  // 112 of these across opendbc; the files reference signals defined elsewhere.
  const db = parseDbc(
    lines(
      "BO_ 302 ACC_07: 8 XXX",
      ' SG_ ACC_Anhalteweg : 12|11@1+ (0.01,0) [0|20.45] "" XXX',
      'CM_ SG_ 302 ACC_Hold_Request "a signal this file does not define";',
      'VAL_ 302 ACC_Hold_Request 1 "on" ;',
      ""
    )
  );
  assert.strictEqual(db.signalCount, 1);
  assert.strictEqual(firstSignal(db).comment, null);
  assert.strictEqual(firstSignal(db).values, null);
});
