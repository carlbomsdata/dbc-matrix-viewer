"use strict";

/* dbc-matrix-viewer — reads a CAN database (.dbc) and draws the byte x bit
 * layout matrix for every message. Everything runs in the page; the file is
 * read with FileReader and never leaves the browser. */

/* ------------------------------------------------------------------ *
 * Bit geometry
 *
 * A DBC start bit is an absolute bit index into the frame:
 *   byte = bit >> 3, bit-in-byte = bit & 7, where bit-in-byte 7 is the MSB.
 *
 * For Intel (@1, little-endian) the start bit is the signal's LSB and the
 * signal runs upwards through absolute indices.
 *
 * For Motorola (@0, big-endian) the start bit is the signal's MSB. The walk
 * goes *down* inside the byte and, on reaching the byte's LSB (bit % 8 == 0),
 * jumps to the MSB of the next byte — which is bit + 15.
 * ------------------------------------------------------------------ */

var BITS_PER_BYTE = 8;

function signalBitOrder(startBit, length, littleEndian) {
  var bits = [];
  if (!Number.isInteger(startBit) || !Number.isInteger(length)) return bits;
  if (startBit < 0 || length <= 0) return bits;

  if (littleEndian) {
    for (var i = 0; i < length; i++) bits.push(startBit + i);
    return bits;
  }

  var bit = startBit;
  for (var j = 0; j < length; j++) {
    bits.push(bit);
    bit = bit % BITS_PER_BYTE === 0 ? bit + 15 : bit - 1;
  }
  return bits;
}

/* Absolute bit index -> matrix cell. Column 0 is the MSB (bit 7 of the byte),
 * so the matrix reads left-to-right as bit 7..0, the way DBC tools draw it. */
function bitToCell(bit) {
  return { byte: Math.floor(bit / BITS_PER_BYTE), col: 7 - (bit % BITS_PER_BYTE) };
}

function signalCells(startBit, length, littleEndian) {
  return signalBitOrder(startBit, length, littleEndian).map(function (bit) {
    var cell = bitToCell(bit);
    return { bit: bit, byte: cell.byte, col: cell.col };
  });
}

/* ------------------------------------------------------------------ *
 * CAN id / J1939 decoding
 * ------------------------------------------------------------------ */

function decodeCanId(rawId) {
  var raw = rawId >>> 0;
  var extended = (raw & 0x80000000) !== 0 || raw > 0x7ff;
  var id = extended ? raw & 0x1fffffff : raw & 0x7ff;

  var out = {
    raw: raw,
    id: id,
    extended: extended,
    hex: "0x" + id.toString(16).toUpperCase().padStart(extended ? 8 : 3, "0"),
  };

  if (!extended) return out;

  var pf = (id >>> 16) & 0xff;
  var ps = (id >>> 8) & 0xff;
  var dp = (id >>> 24) & 0x03; /* extended data page + data page */
  var pdu1 = pf < 240;

  out.priority = (id >>> 26) & 0x07;
  out.pduFormat = pf;
  out.pduSpecific = ps;
  out.sourceAddress = id & 0xff;
  out.pgn = (dp << 16) | (pf << 8) | (pdu1 ? 0 : ps);
  out.pgnHex = "0x" + out.pgn.toString(16).toUpperCase().padStart(4, "0");
  if (pdu1) out.destinationAddress = ps;

  return out;
}

/* ------------------------------------------------------------------ *
 * Parser
 * ------------------------------------------------------------------ */

/* A .dbc carries no encoding declaration. Vector and CANdb++ write Windows-1252
 * by default, so decoding everything as UTF-8 turns a degree sign or a Swedish
 * name into replacement characters — or fails outright. Honour a byte order
 * mark, try UTF-8 strictly, and fall back to Windows-1252 when that rejects. */
function decodeDbcBytes(buffer) {
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

var RE_BO = /^BO_\s+(\d+)\s+([^\s:]+)\s*:\s*(\d+)\s+(\S+)/;
var RE_SG =
  /^SG_\s+([^\s:]+)(?:\s+([Mm]\d*M?))?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,()]*),([^,()]*)\)\s*\[([^|\]]*)\|([^\]]*)\]\s*"([^"]*)"\s*(.*?)\s*$/;
var RE_CM_BO = /^CM_\s+BO_\s+(\d+)\s+"([\s\S]*)"\s*;?\s*$/;
var RE_CM_SG = /^CM_\s+SG_\s+(\d+)\s+([^\s"]+)\s+"([\s\S]*)"\s*;?\s*$/;
var RE_VAL = /^VAL_\s+(\d+)\s+([^\s"]+)\s+([\s\S]*?)\s*;?\s*$/;
var RE_BU = /^BU_\s*:\s*(.*)$/;
var RE_VAL_TABLE = /^VAL_TABLE_\s+([^\s"]+)\s+([\s\S]*?)\s*;?\s*$/;

/* True while a quoted string is still open at the end of the text.
 *
 * This is what decides whether a CM_ or VAL_ continues onto the next line. It
 * deliberately does not look for a trailing semicolon: plenty of real files
 * omit it (opendbc's toyota_radar_dsu_tssp.dbc has a bare CM_ "Front target"),
 * and scanning ahead for a semicolon swallows every message that follows. */
function stringStillOpen(text) {
  var inString = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inString && c === "\\") {
      i++;
      continue;
    }
    if (c === '"') inString = !inString;
  }
  return inString;
}

function signalKey(messageRawId, signalName) {
  return messageRawId + "\u0000" + signalName;
}

var RE_DBC_MARKER = /^(VERSION\b|NS_\s*:|BS_\s*:|BU_\s*:|BO_\s|SG_\s|CM_\s|VAL_\s|VAL_TABLE_\s|BA_DEF_|BA_\s|EV_\s|SIG_VALTYPE_\s|BO_TX_BU_\s)/;

function looksLikeDbc(lines) {
  for (var i = 0; i < lines.length; i++) {
    if (RE_DBC_MARKER.test(lines[i].trim())) return true;
  }
  return false;
}

function parseDbc(text) {
  var lines = String(text).replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").split("\n");
  var messages = [];
  var messagesById = new Map();
  var signalsByKey = new Map();
  var nodes = [];
  var version = "";
  var current = null;
  var pending = [];
  var valueTables = new Map();

  function finishMessage() {
    current = null;
  }

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var line = raw.trim();
    if (!line) continue;

    /* Statements that may wrap onto following lines. The trailing space
     * matters: the NS_ header block lists bare "CM_" and "VAL_" tokens that
     * are declarations, not statements, and must not be consumed here. */
    if (/^(CM_|VAL_|VAL_TABLE_)[ \t]/.test(line)) {
      var stmt = raw;
      var wrapped = 0;
      while (stringStillOpen(stmt) && i + 1 < lines.length && wrapped < 500) {
        i++;
        wrapped++;
        stmt += "\n" + lines[i];
      }
      finishMessage();
      pending.push(stmt.replace(/\s+$/, ""));
      continue;
    }

    if (line.indexOf("SG_ ") === 0 && current) {
      var sg = parseSignalLine(line, raw, current);
      if (sg) {
        current.signals.push(sg);
        signalsByKey.set(signalKey(current.rawId, sg.name), sg);
      }
      continue;
    }

    var mBo = RE_BO.exec(line);
    if (mBo) {
      current = {
        rawId: Number(mBo[1]) >>> 0,
        name: mBo[2],
        dlc: Number(mBo[3]),
        transmitter: mBo[4],
        line: raw.replace(/\s+$/, ""),
        lineNo: i + 1,
        comment: null,
        signals: [],
      };
      current.can = decodeCanId(current.rawId);
      messages.push(current);
      if (!messagesById.has(current.rawId)) messagesById.set(current.rawId, current);
      continue;
    }

    var mBu = RE_BU.exec(line);
    if (mBu) {
      nodes = mBu[1].split(/\s+/).filter(Boolean);
      finishMessage();
      continue;
    }

    if (line.indexOf("VERSION ") === 0) {
      version = line.slice(8).replace(/^"|"$/g, "");
      continue;
    }

    finishMessage();
  }

  function applyStatement(stmt) {
    var flat = stmt.trim();

    var cmBo = RE_CM_BO.exec(flat);
    if (cmBo) {
      var msgForComment = messagesById.get(Number(cmBo[1]) >>> 0);
      if (msgForComment) msgForComment.comment = { text: cmBo[2], line: stmt };
      return;
    }

    var cmSg = RE_CM_SG.exec(flat);
    if (cmSg) {
      var sigForComment = signalsByKey.get(signalKey(Number(cmSg[1]) >>> 0, cmSg[2]));
      if (sigForComment) sigForComment.comment = { text: cmSg[3], line: stmt };
      return;
    }

    if (RE_VAL_TABLE.test(flat)) return;

    var val = RE_VAL.exec(flat);
    if (val) {
      var sigForValues = signalsByKey.get(signalKey(Number(val[1]) >>> 0, val[2]));
      if (!sigForValues) return;

      var values = parseValuePairs(val[3]);
      if (!values.length) {
        /* "VAL_ <id> <signal> <TableName> ;" points at a VAL_TABLE_. */
        var named = valueTables.get(val[3].trim());
        if (named) values = named.slice();
      }
      sigForValues.valueLine = stmt;
      if (values.length) sigForValues.values = values;
    }
  }

  /* CM_ and VAL_ reference messages and signals by id, so they are applied once
   * the whole file has been read rather than in stream order. Value tables go
   * first: a VAL_ may name one instead of listing its own pairs. */
  pending.forEach(function (stmt) {
    var table = RE_VAL_TABLE.exec(stmt.trim());
    if (table) valueTables.set(table[1], parseValuePairs(table[2]));
  });
  pending.forEach(applyStatement);

  /* A database with no messages is unusual but legal — opendbc ships include
   * fragments that are nothing but CM_ lines. Only reject a file carrying none
   * of the format's structural keywords at all. */
  if (!messages.length && !looksLikeDbc(lines)) {
    throw new Error("No DBC sections found — this does not look like a CAN database file.");
  }

  var signalCount = 0;
  messages.forEach(function (msg) {
    msg.signals.forEach(function (sig) {
      sig.cells = signalCells(sig.startBit, sig.length, sig.littleEndian);
      sig.message = msg;
    });
    /* Order by first occupied cell so the legend reads top-to-bottom with the
     * matrix, and so the colour ramp separates physical neighbours. */
    msg.signals.sort(function (a, b) {
      var ac = a.cells[0] || { byte: 1e9, col: 1e9 };
      var bc = b.cells[0] || { byte: 1e9, col: 1e9 };
      return ac.byte - bc.byte || ac.col - bc.col || a.name.localeCompare(b.name);
    });
    msg.signals.forEach(function (sig, index) {
      sig.index = index;
      sig.id = msg.rawId + ":" + sig.name;
    });
    signalCount += msg.signals.length;
  });

  return {
    version: version,
    nodes: nodes,
    messages: messages,
    signalCount: signalCount,
  };
}

function parseSignalLine(line, raw, message) {
  var m = RE_SG.exec(line);
  if (!m) return null;

  var mux = m[2] || null;
  return {
    name: m[1],
    mux: mux,
    isMultiplexor: mux === "M" || (mux !== null && /M$/.test(mux)),
    muxValue: mux && /^m/.test(mux) ? Number(mux.slice(1).replace(/M$/, "")) : null,
    startBit: Number(m[3]),
    length: Number(m[4]),
    littleEndian: m[5] === "1",
    signed: m[6] === "-",
    factor: Number(m[7]),
    offset: Number(m[8]),
    min: Number(m[9]),
    max: Number(m[10]),
    unit: m[11],
    receivers: m[12] ? m[12].split(/[\s,]+/).filter(Boolean) : [],
    line: raw.replace(/\s+$/, ""),
    comment: null,
    values: null,
    valueLine: null,
    messageRawId: message.rawId,
  };
}

function parseValuePairs(text) {
  var pairs = [];
  var re = /(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    pairs.push({ value: Number(m[1]), label: m[2] });
  }
  pairs.sort(function (a, b) {
    return a.value - b.value;
  });
  return pairs;
}

/* ------------------------------------------------------------------ *
 * Colour
 *
 * A name hash collides too often — two neighbouring signals landing on the
 * same hue makes the matrix unreadable, which is the one thing it has to do.
 * Signals are sorted by position, so walking hues by the golden angle puts
 * every neighbour ~137.5 degrees apart, and a three-step lightness/chroma
 * cycle keeps them apart once the hue circle wraps around.
 * ------------------------------------------------------------------ */

var GOLDEN_ANGLE = 137.508;
var LIGHTNESS_CYCLE = [0, 0.055, -0.045];
var CHROMA_CYCLE = [0.115, 0.085, 0.105];

function signalPaint(index) {
  return {
    hue: (index * GOLDEN_ANGLE + 21) % 360,
    dl: LIGHTNESS_CYCLE[index % LIGHTNESS_CYCLE.length],
    chroma: CHROMA_CYCLE[index % CHROMA_CYCLE.length],
  };
}

function applyPaint(node, index) {
  var paint = signalPaint(index);
  node.style.setProperty("--h", paint.hue.toFixed(1));
  node.style.setProperty("--dl", String(paint.dl));
  node.style.setProperty("--c", String(paint.chroma));
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

var MAX_MATRIX_ROWS = 64;

function byteOrderLabel(sig) {
  return sig.littleEndian ? "Intel" : "Motorola";
}

function scalingLabel(sig) {
  var parts = [];
  if (sig.factor !== 1) parts.push("x" + trimNumber(sig.factor));
  if (sig.offset !== 0) parts.push((sig.offset > 0 ? "+" : "") + trimNumber(sig.offset));
  return parts.join(" ");
}

function trimNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

function bytesNeeded(msg) {
  var max = msg.dlc;
  msg.signals.forEach(function (sig) {
    sig.cells.forEach(function (cell) {
      if (cell.byte + 1 > max) max = cell.byte + 1;
    });
  });
  return Math.max(1, max);
}

function rangeLabel(sig) {
  if (!sig.cells.length) return "";
  var first = sig.cells[0];
  var last = sig.cells[sig.cells.length - 1];
  if (first.byte === last.byte) return "byte " + first.byte;
  return "bytes " + Math.min(first.byte, last.byte) + "\u2013" + Math.max(first.byte, last.byte);
}

/* ------------------------------------------------------------------ *
 * Proprietary B allocation grid
 *
 * J1939 Proprietary B occupies PGN 0xFF00-0xFFFF: 256 parameter groups, one
 * per manufacturer-defined message. Drawn as 16 rows (high nibble of the low
 * byte) by 16 columns (low nibble), which is how the range gets carved up
 * when you hand blocks of it to subsystems.
 * ------------------------------------------------------------------ */

var PGN_BASE = 0xff00;
var PGN_END = 0xffff;

/* Which slice of the identifier space the grid draws.
 *
 * A J1939 database carves up Proprietary B, PGN 0xFF00-0xFFFF, and that is the
 * range worth mapping. A plain CAN database has no PGNs at all: it allocates
 * 11-bit identifiers, 0x000-0x7FF, and that is the range worth mapping instead.
 * Whichever holds more of the loaded messages is picked automatically. */
var GRID_RANGES = [
  {
    id: "propb",
    label: "Proprietary B",
    note: "PGN 0xFF00\u2013FFFF",
    unit: "PGN",
    units: "PGNs",
    cols: 16,
    rows: 16,
    labelEvery: 1,
    tickEvery: 4,
    cellOf: function (msg) {
      return isProprietaryB(msg) ? msg.can.pgn - PGN_BASE : -1;
    },
    rowLabel: function (row) {
      return "FF" + row.toString(16).toUpperCase() + "x";
    },
    colLabel: function (col) {
      return col.toString(16).toUpperCase();
    },
    cellName: function (cell) {
      var pgn = PGN_BASE + cell;
      return "PGN " + pgn + " (0x" + pgn.toString(16).toUpperCase() + ")";
    },
    cellTitle: function (cell) {
      return "PGN 0x" + (PGN_BASE + cell).toString(16).toUpperCase();
    },
  },
  {
    id: "std11",
    label: "Standard 11-bit",
    note: "id 0x000\u20137FF",
    unit: "identifier",
    units: "ids",
    cols: 64,
    rows: 32,
    labelEvery: 8,
    tickEvery: 8,
    cellOf: function (msg) {
      return msg.can.extended ? -1 : msg.can.id;
    },
    rowLabel: function (row) {
      return "0x" + (row << 6).toString(16).toUpperCase().padStart(3, "0");
    },
    colLabel: function (col) {
      return col.toString(16).toUpperCase().padStart(2, "0");
    },
    cellName: function (cell) {
      return "id " + cell + " (0x" + cell.toString(16).toUpperCase().padStart(3, "0") + ")";
    },
    cellTitle: function (cell) {
      return "0x" + cell.toString(16).toUpperCase().padStart(3, "0");
    },
  },
];

function rangeById(id) {
  for (var i = 0; i < GRID_RANGES.length; i++) {
    if (GRID_RANGES[i].id === id) return GRID_RANGES[i];
  }
  return GRID_RANGES[0];
}

function rangeCellCount(range) {
  return range.cols * range.rows;
}

/* Grid themes. Each is a list of {hue, chroma, lightness} in oklch, one per
 * loaded file, in the order the files arrive.
 *
 * slate     the default: a neutral first file, because the first DBC loaded is
 *           usually the shared network everything else sits on top of
 * okabe     Okabe & Ito's eight-colour set, the standard palette that stays
 *           readable with protanopia, deuteranopia and tritanopia, taken in
 *           their recommended blue-then-orange order
 * carbon    IBM Carbon's categorical sequence, ordered for contrast between
 *           neighbours
 * blueprint pale drafting inks on a Prussian blue field, the cyanotype colour
 *           that gave blueprints their name
 * phosphor  a CRT terminal: dim green base, bright traces */

var GRID_THEMES = [
  {
    id: "slate",
    label: "Slate",
    paints: [
      { h: 265, c: 0.014, l: 0.7 },
      { h: 288, c: 0.145, l: 0.66 },
      { h: 158, c: 0.115, l: 0.68 },
      { h: 58, c: 0.13, l: 0.74 },
      { h: 22, c: 0.14, l: 0.66 },
      { h: 222, c: 0.13, l: 0.66 },
      { h: 330, c: 0.125, l: 0.68 },
      { h: 192, c: 0.11, l: 0.7 },
    ],
  },
  {
    id: "okabe",
    label: "Okabe\u2013Ito",
    paints: [
      { h: 250, c: 0.14, l: 0.52 },
      { h: 70, c: 0.15, l: 0.75 },
      { h: 165, c: 0.12, l: 0.6 },
      { h: 350, c: 0.1, l: 0.64 },
      { h: 235, c: 0.1, l: 0.74 },
      { h: 42, c: 0.17, l: 0.58 },
      { h: 105, c: 0.16, l: 0.9 },
      { h: 265, c: 0.01, l: 0.38 },
    ],
  },
  {
    id: "carbon",
    label: "Carbon",
    paints: [
      { h: 300, c: 0.22, l: 0.42 },
      { h: 240, c: 0.15, l: 0.65 },
      { h: 195, c: 0.06, l: 0.4 },
      { h: 5, c: 0.17, l: 0.44 },
      { h: 22, c: 0.19, l: 0.64 },
      { h: 150, c: 0.14, l: 0.52 },
      { h: 265, c: 0.2, l: 0.36 },
      { h: 85, c: 0.13, l: 0.63 },
    ],
  },
  {
    id: "blueprint",
    label: "Blueprint",
    fixed: true,
    paints: [
      { h: 215, c: 0.015, l: 0.92 },
      { h: 60, c: 0.09, l: 0.88 },
      { h: 155, c: 0.09, l: 0.86 },
      { h: 330, c: 0.09, l: 0.84 },
      { h: 25, c: 0.1, l: 0.82 },
      { h: 250, c: 0.09, l: 0.84 },
      { h: 190, c: 0.08, l: 0.88 },
      { h: 95, c: 0.1, l: 0.88 },
    ],
  },
  {
    id: "phosphor",
    label: "Phosphor",
    fixed: true,
    paints: [
      { h: 150, c: 0.05, l: 0.52 },
      { h: 145, c: 0.18, l: 0.78 },
      { h: 85, c: 0.16, l: 0.82 },
      { h: 195, c: 0.13, l: 0.78 },
      { h: 330, c: 0.15, l: 0.72 },
      { h: 25, c: 0.17, l: 0.68 },
      { h: 265, c: 0.14, l: 0.7 },
      { h: 55, c: 0.15, l: 0.86 },
    ],
  },
];

var DEFAULT_THEME = GRID_THEMES[0].id;

function themeById(id) {
  for (var i = 0; i < GRID_THEMES.length; i++) {
    if (GRID_THEMES[i].id === id) return GRID_THEMES[i];
  }
  return GRID_THEMES[0];
}

function filePaint(index, themeId) {
  var paints = themeById(themeId).paints;
  return paints[index % paints.length];
}

function applyFilePaint(node, index, themeId) {
  var paint = filePaint(index, themeId);
  node.style.setProperty("--h", String(paint.h));
  node.style.setProperty("--c", String(paint.c));
  node.style.setProperty("--l", String(paint.l));
}

/* Vector exports a placeholder message that holds signals not attached to any
 * real frame. It is not a message on the bus, so it stays out of the map. */
function isRealMessage(msg) {
  return msg.name !== "VECTOR__INDEPENDENT_SIG_MSG";
}

function isProprietaryB(msg) {
  return msg.can.extended && msg.can.pgn >= PGN_BASE && msg.can.pgn <= PGN_END;
}

function hex2(n) {
  return n.toString(16).toUpperCase().padStart(2, "0");
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function initApp(doc) {
  var els = {
    brand: doc.getElementById("brand"),
    fileCounts: doc.getElementById("fileCounts"),
    topActions: doc.getElementById("topActions"),
    filter: doc.getElementById("filter"),
    addFile: doc.getElementById("addFile"),
    panelEmpty: doc.getElementById("panelEmpty"),
    panelMap: doc.getElementById("panelMap"),
    gridTheme: doc.getElementById("gridTheme"),
    gridRange: doc.getElementById("gridRange"),
    mapTitle: doc.getElementById("mapTitle"),
    mapSub: doc.getElementById("mapSub"),
    mapEmpty: doc.getElementById("mapEmpty"),
    drop: doc.getElementById("drop"),
    status: doc.getElementById("status"),
    grid: doc.getElementById("grid"),
    mapBody: doc.querySelector(".map-body"),
    gridScroll: doc.querySelector(".grid-scroll"),
    side: doc.querySelector(".side"),
    fileLegend: doc.getElementById("fileLegend"),
    others: doc.getElementById("others"),
    othersHead: doc.getElementById("othersHead"),
    othersList: doc.getElementById("othersList"),
    othersCount: doc.getElementById("othersCount"),
    detail: doc.getElementById("detail"),
    detailTitle: doc.getElementById("detailTitle"),
    detailBody: doc.getElementById("detailBody"),
    detailClose: doc.getElementById("detailClose"),
    fileInput: doc.getElementById("fileInput"),
  };

  /* files: { name, label, db, index }
   * selected: null | { key, title, refs: [{ file, message }] } */
  var state = {
    files: [],
    selected: null,
    nextIndex: 0,
    gridTheme: DEFAULT_THEME,
    range: GRID_RANGES[0].id,
    rangePinned: false,
  };

  /* ---- status ---- */

  function setStatus(text, kind) {
    els.status.textContent = text || "";
    els.status.className = "status" + (kind ? " " + kind : "");
  }

  /* ---- file intake ---- */

  function openFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    var remaining = files.length;
    var failures = [];

    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onerror = function () {
        failures.push(file.name + ": could not be read");
        if (--remaining === 0) finish(failures);
      };
      reader.onload = function () {
        try {
          addFile(file.name, decodeDbcBytes(reader.result));
        } catch (err) {
          failures.push(file.name + ": " + (err && err.message ? err.message : "could not be parsed"));
        }
        if (--remaining === 0) finish(failures);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function finish(failures) {
    if (failures.length) {
      setStatus(failures.join("  \u00b7  "), "error");
    } else {
      setStatus("", "");
    }
    render();
  }

  function addFile(name, text) {
    var db = parseDbc(text); /* throws on a non-DBC */
    state.files.push({
      name: name,
      label: defaultLabel(name),
      db: db,
      index: state.nextIndex++,
    });
    return db;
  }

  /* "..._1159_hmi.dbc" -> "hmi"; "BBProprietaryNet-T2_1.38.X0.dbc" ->
   * "BBProprietaryNet-T2". A trailing version number is not a name. */
  function defaultLabel(name) {
    var base = name.replace(/\.dbc$/i, "");
    var parts = base.split("_").filter(Boolean);
    var tail = parts[parts.length - 1];
    if (parts.length > 1 && /^[A-Za-z]{2,10}$/.test(tail)) return tail;
    var head = parts[0] || base;
    return head.length <= 22 ? head : head.slice(0, 21) + "\u2026";
  }

  function removeFile(file) {
    state.files = state.files.filter(function (other) {
      return other !== file;
    });
    state.selected = null;
    setStatus("", "");
    render();
  }

  function reset() {
    state.files = [];
    state.selected = null;
    state.nextIndex = 0;
    els.filter.value = "";
    setStatus("", "");
    render();
  }

  /* ---- derived data ---- */

  function activeRange() {
    return rangeById(state.range);
  }

  function occupancy(range) {
    range = range || activeRange();
    var map = new Map();
    state.files.forEach(function (file) {
      file.db.messages.forEach(function (message) {
        if (!isRealMessage(message)) return;
        var cell = range.cellOf(message);
        if (cell < 0 || cell >= rangeCellCount(range)) return;
        var list = map.get(cell);
        if (!list) map.set(cell, (list = []));
        list.push({ file: file, message: message });
      });
    });
    return map;
  }

  function othersFor() {
    var range = activeRange();
    var out = [];
    state.files.forEach(function (file) {
      file.db.messages.forEach(function (message) {
        if (!isRealMessage(message)) return;
        var cell = range.cellOf(message);
        if (cell < 0 || cell >= rangeCellCount(range)) {
          out.push({ file: file, message: message });
        }
      });
    });
    out.sort(function (a, b) {
      return a.message.can.id - b.message.can.id;
    });
    return out;
  }

  /* Pick the range that actually holds the messages, unless the user has
   * chosen one. A car database has no PGNs; a J1939 database has no 11-bit
   * identifiers. Showing the wrong one means showing an empty grid. */
  function autoSelectRange() {
    if (state.rangePinned || !state.files.length) return;
    var best = state.range;
    var bestCount = -1;
    GRID_RANGES.forEach(function (range) {
      var count = 0;
      state.files.forEach(function (file) {
        file.db.messages.forEach(function (message) {
          if (!isRealMessage(message)) return;
          var cell = range.cellOf(message);
          if (cell >= 0 && cell < rangeCellCount(range)) count++;
        });
      });
      if (count > bestCount) {
        bestCount = count;
        best = range.id;
      }
    });
    state.range = best;
    if (els.gridRange) els.gridRange.value = best;
  }

  function totals() {
    var messages = 0;
    var signals = 0;
    state.files.forEach(function (file) {
      messages += file.db.messages.length;
      signals += file.db.signalCount;
    });
    return { messages: messages, signals: signals };
  }

  function matches(ref, query) {
    if (!query) return true;
    return refHaystack(ref).indexOf(query) !== -1;
  }

  function refHaystack(ref) {
    if (ref._hay) return ref._hay;
    var msg = ref.message;
    var parts = [msg.name, msg.transmitter, msg.can.hex, String(msg.can.id), ref.file.label, ref.file.name];
    if (msg.can.extended) {
      parts.push(String(msg.can.pgn), msg.can.pgnHex, "sa" + msg.can.sourceAddress);
    }
    if (msg.comment) parts.push(msg.comment.text);
    msg.signals.forEach(function (sig) {
      parts.push(sig.name);
      if (sig.unit) parts.push(sig.unit);
    });
    ref._hay = parts.join(" ").toLowerCase();
    return ref._hay;
  }

  /* ---- top-level render ---- */

  function render() {
    var has = state.files.length > 0;
    els.panelEmpty.hidden = has;
    els.panelMap.hidden = !has;
    els.topActions.hidden = !has;
    if (!has) {
      els.grid.textContent = "";
      els.fileLegend.textContent = "";
      if (els.detail.open) els.detail.close();
      els.fileCounts.textContent = "";
      return;
    }

    autoSelectRange();

    var counts = totals();
    els.fileCounts.textContent =
      state.files.length +
      (state.files.length === 1 ? " file \u00b7 " : " files \u00b7 ") +
      counts.messages +
      " messages \u00b7 " +
      counts.signals +
      " signals";

    renderGrid();
    renderFileLegend();
    renderOthers();
    renderDetail();
  }

  /* ---- the allocation grid ---- */

  function renderGrid() {
    var range = activeRange();
    var query = els.filter.value.trim().toLowerCase();
    var used = occupancy(range);
    var frag = doc.createDocumentFragment();

    frag.appendChild(gridHead("", false));
    for (var col = 0; col < range.cols; col++) {
      var show = col % range.labelEvery === 0;
      frag.appendChild(gridHead(show ? range.colLabel(col) : "", col % range.tickEvery === 0));
    }

    for (var row = 0; row < range.rows; row++) {
      var label = doc.createElement("div");
      label.className = "pgn-row-label" + (row % range.tickEvery === 0 ? " tick" : "");
      label.textContent = range.rowLabel(row);
      frag.appendChild(label);

      for (var c = 0; c < range.cols; c++) {
        var cell = row * range.cols + c;
        frag.appendChild(pgnCell(range, cell, used.get(cell), query));
      }
    }

    els.grid.style.setProperty("--cols", String(range.cols));
    els.grid.style.setProperty("--rows", String(range.rows));
    els.grid.dataset.range = range.id;
    els.grid.textContent = "";
    els.grid.appendChild(frag);

    els.mapTitle.textContent = range.label + " allocation";
    els.mapSub.textContent =
      range.note +
      ". Rows down the side, columns across the top. Click a claimed " +
      range.unit +
      " for its layout.";
    els.mapEmpty.hidden = used.size > 0;
    queueFit();
  }

  function gridHead(text, tick) {
    var cell = doc.createElement("div");
    cell.className = "pgn-col-head" + (tick ? " tick" : "");
    cell.textContent = text;
    return cell;
  }

  function pgnCell(range, slot, refs, query) {
    var label = range.cellName(slot);

    if (!refs || !refs.length) {
      var free = doc.createElement("div");
      free.className = "pgn free";
      free.title = label + " \u2014 free";
      return free;
    }

    var cell = doc.createElement("button");
    cell.type = "button";
    cell.className = "pgn used";
    cell.dataset.pgn = String(slot);
    applyFilePaint(cell, refs[0].file.index, state.gridTheme);

    var owners = uniqueFiles(refs);
    if (owners.length > 1) cell.classList.add("shared");

    var names = refs.map(function (ref) {
      return ref.message.name + " (" + ref.file.label + ")";
    });
    cell.title = label + "\n" + names.join("\n");
    cell.setAttribute("aria-label", label + ", " + names.join(", "));

    if (query && !refs.some(function (ref) { return matches(ref, query); })) {
      cell.classList.add("dim");
    }
    if (state.selected && state.selected.key === "pgn:" + range.id + ":" + slot) {
      cell.classList.add("selected");
    }

    cell.addEventListener("click", function () {
      select("pgn:" + range.id + ":" + slot, range.cellTitle(slot), refs);
    });
    return cell;
  }

  function uniqueFiles(refs) {
    var seen = [];
    refs.forEach(function (ref) {
      if (seen.indexOf(ref.file) === -1) seen.push(ref.file);
    });
    return seen;
  }

  /* Solve the cell size against the box the grid actually gets, rather than
   * guessing how tall the surrounding chrome is. The grid's height is linear
   * in the cell size, so one measured sample gives the exact answer. */
  var MAX_CELL = { propb: 64, std11: 24 };
  /* Below this a cell stops reading as a cell. If the map cannot fit at this
   * size the content column scrolls, which beats an unreadable grid. */
  var MIN_CELL = 11;

  function solveCell(range) {
    var probe = els.grid.querySelector(".pgn");
    if (!probe) return null;
    var sample = probe.getBoundingClientRect().width;
    if (!sample) return null;

    var gridBox = els.grid.getBoundingClientRect();
    /* Everything in the grid that is not a row of cells: the header row and
     * the gaps. Constant, so one sample gives the exact answer. */
    var overheadH = gridBox.height - range.rows * sample;
    var overheadW = gridBox.width - range.cols * sample;

    var frame = els.gridScroll.offsetHeight - els.grid.offsetHeight;
    var legend = els.side ? els.side.offsetHeight : 0;
    var bodyGap = parseFloat(getComputedStyle(els.mapBody).rowGap) || 0;

    var availH = els.mapBody.clientHeight - legend - bodyGap - frame;
    var availW = els.mapBody.clientWidth - frame;

    var byHeight = (availH - overheadH) / range.rows;
    var byWidth = (availW - overheadW) / range.cols;
    return Math.max(MIN_CELL, Math.floor(Math.min(byHeight, byWidth, MAX_CELL[range.id] || 64)));
  }

  /* Each pass measures the layout it just produced, so two or three are enough
   * to settle even when the legend rewraps as the grid changes width. */
  function fitGrid() {
    if (!els.mapBody || els.panelMap.hidden) return;
    var range = activeRange();
    var previous = null;
    for (var pass = 0; pass < 4; pass++) {
      var cell = solveCell(range);
      if (cell === null || cell === previous) break;
      previous = cell;
      els.grid.style.setProperty("--cell", cell + "px");
    }
  }

  var fitQueued = false;
  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(function () {
      fitQueued = false;
      fitGrid();
    });
  }

  window.addEventListener("resize", queueFit);

  /* ---- file legend ---- */

  function renderFileLegend() {
    var used = occupancy();
    var perFile = new Map();
    used.forEach(function (refs) {
      uniqueFiles(refs).forEach(function (file) {
        perFile.set(file, (perFile.get(file) || 0) + 1);
      });
    });

    var frag = doc.createDocumentFragment();
    state.files.forEach(function (file) {
      frag.appendChild(fileLegendRow(file, perFile.get(file) || 0));
    });

    var free = doc.createElement("span");
    free.className = "file-chip free-chip";
    var freeSwatch = doc.createElement("span");
    freeSwatch.className = "file-swatch";
    free.appendChild(freeSwatch);
    var freeText = doc.createElement("span");
    freeText.className = "file-label-static";
    freeText.textContent = "Free \u00b7 " + (rangeCellCount(activeRange()) - used.size);
    free.appendChild(freeText);
    frag.appendChild(free);

    els.fileLegend.textContent = "";
    els.fileLegend.appendChild(frag);
  }

  function fileLegendRow(file, count) {
    var chip = doc.createElement("span");
    chip.className = "file-chip";
    applyFilePaint(chip, file.index, state.gridTheme);

    var swatch = doc.createElement("span");
    swatch.className = "file-swatch";
    chip.appendChild(swatch);

    var input = doc.createElement("input");
    input.className = "file-label";
    input.value = file.label;
    input.size = Math.max(4, file.label.length);
    input.setAttribute("aria-label", "Label for " + file.name);
    input.title = file.name;
    input.addEventListener("input", function () {
      file.label = input.value;
      input.size = Math.max(4, input.value.length);
    });
    input.addEventListener("change", render);
    chip.appendChild(input);

    var meta = doc.createElement("span");
    meta.className = "file-count";
    meta.textContent = count + " " + (count === 1 ? activeRange().unit : activeRange().units);
    chip.appendChild(meta);

    var remove = doc.createElement("button");
    remove.type = "button";
    remove.className = "file-remove";
    remove.textContent = "\u00d7";
    remove.title = "Remove " + file.name + " from the map";
    remove.setAttribute("aria-label", "Remove " + file.name);
    remove.addEventListener("click", function () {
      removeFile(file);
    });
    chip.appendChild(remove);

    return chip;
  }

  /* ---- messages outside Proprietary B ---- */

  function renderOthers() {
    var query = els.filter.value.trim().toLowerCase();
    var others = othersFor().filter(function (ref) {
      return matches(ref, query);
    });

    els.others.hidden = others.length === 0;
    if (!others.length) {
      els.othersList.textContent = "";
      return;
    }
    if (query) els.others.open = true;

    els.othersHead.textContent = "Outside " + activeRange().label;
    els.othersCount.textContent = others.length + " message" + (others.length === 1 ? "" : "s");

    var frag = doc.createDocumentFragment();
    others.forEach(function (ref) {
      frag.appendChild(otherChip(ref));
    });
    els.othersList.textContent = "";
    els.othersList.appendChild(frag);
  }

  function otherChip(ref) {
    var msg = ref.message;
    var key = "msg:" + ref.file.index + ":" + msg.rawId + ":" + msg.name;

    var chip = doc.createElement("button");
    chip.type = "button";
    chip.className = "other-chip";
    applyFilePaint(chip, ref.file.index, state.gridTheme);
    if (state.selected && state.selected.key === key) chip.classList.add("selected");

    var swatch = doc.createElement("span");
    swatch.className = "file-swatch";
    chip.appendChild(swatch);

    var id = doc.createElement("span");
    id.className = "mono other-id";
    id.textContent = msg.can.extended ? msg.can.pgnHex : msg.can.hex;
    chip.appendChild(id);

    var name = doc.createElement("span");
    name.className = "other-name";
    name.textContent = msg.name;
    chip.appendChild(name);

    chip.title = msg.name + " \u00b7 " + msg.can.hex + " \u00b7 " + ref.file.label;
    chip.addEventListener("click", function () {
      select(key, msg.name, [ref]);
    });
    return chip;
  }

  /* ---- selection ---- */

  function select(key, title, refs) {
    if (state.selected && state.selected.key === key) {
      state.selected = null;
    } else {
      state.selected = { key: key, title: title, refs: refs, signal: null };
    }
    render();
  }

  function renderDetail() {
    if (!state.selected) {
      els.detailBody.textContent = "";
      els.detailTitle.textContent = "";
      if (els.detail.open) els.detail.close();
      return;
    }

    var selected = state.selected;
    els.detailTitle.textContent = selected.title;
    els.detailBody.textContent = "";
    selected.refs.forEach(function (ref) {
      els.detailBody.appendChild(renderMessageCard(ref));
    });

    if (!els.detail.open) {
      els.detail.showModal();
      els.detailBody.scrollTop = 0;
    }
  }

  function closeDetail() {
    if (!state.selected) return;
    state.selected = null;
    render();
  }

  /* ---- message card (matrix + signal list + source) ---- */

  function renderMessageCard(ref) {
    var msg = ref.message;
    var card = doc.createElement("section");
    card.className = "card";

    card.appendChild(renderCardHeader(ref));

    var body = doc.createElement("div");
    body.className = "card-body";
    body.appendChild(renderMatrix(msg));
    body.appendChild(renderSignalList(msg));
    card.appendChild(body);

    var source = doc.createElement("div");
    source.className = "source";
    source.hidden = true;
    card.appendChild(source);
    card._source = source;

    card.addEventListener("click", function (event) {
      var target = event.target.closest("[data-sig]");
      if (!target || !card.contains(target)) return;
      toggleSignal(card, msg, target.dataset.sig);
    });

    return card;
  }

  function renderCardHeader(ref) {
    var msg = ref.message;
    var head = doc.createElement("header");
    head.className = "card-head";

    var title = doc.createElement("h3");
    title.className = "msg-name";
    title.textContent = msg.name;
    head.appendChild(title);

    var chips = doc.createElement("div");
    chips.className = "chips";

    var origin = chip(ref.file.label, "origin", ref.file.name);
    applyFilePaint(origin, ref.file.index, state.gridTheme);
    chips.appendChild(origin);

    chips.appendChild(chip(msg.can.hex, "mono strong", "CAN identifier"));
    chips.appendChild(chip(msg.can.extended ? "29-bit" : "11-bit", "", "Identifier width"));
    if (msg.can.extended) {
      chips.appendChild(chip("PGN " + msg.can.pgn, "mono", "Parameter group number (" + msg.can.pgnHex + ")"));
      chips.appendChild(chip("P" + msg.can.priority, "mono", "Priority"));
      chips.appendChild(chip("SA " + msg.can.sourceAddress, "mono", "Source address"));
      if (msg.can.destinationAddress !== undefined) {
        chips.appendChild(chip("DA " + msg.can.destinationAddress, "mono", "Destination address"));
      }
    }
    chips.appendChild(chip(msg.dlc + " B", "mono", "Data length"));
    chips.appendChild(chip(msg.transmitter, "muted", "Transmitter"));
    head.appendChild(chips);

    if (msg.comment) {
      var note = doc.createElement("p");
      note.className = "msg-comment";
      note.textContent = msg.comment.text;
      head.appendChild(note);
    }
    return head;
  }

  function chip(text, className, title) {
    var span = doc.createElement("span");
    span.className = "chip" + (className ? " " + className : "");
    span.textContent = text;
    if (title) span.title = title;
    return span;
  }

  /* ---- the byte x bit matrix ---- */

  function renderMatrix(msg) {
    var wrap = doc.createElement("div");
    wrap.className = "matrix-wrap";

    var grid = doc.createElement("div");
    grid.className = "matrix";
    grid.setAttribute("role", "presentation");

    grid.appendChild(headerCell(""));
    for (var col = 0; col < 8; col++) grid.appendChild(headerCell(String(7 - col)));

    var totalBytes = bytesNeeded(msg);
    var rows = Math.min(totalBytes, MAX_MATRIX_ROWS);
    var owners = ownerMap(msg, rows);
    var labelled = Object.create(null);

    for (var byte = 0; byte < rows; byte++) {
      var gutter = doc.createElement("div");
      gutter.className = "gutter";
      gutter.textContent = String(byte);
      gutter.title = "Byte " + byte + (byte >= msg.dlc ? " (beyond DLC)" : "");
      if (byte >= msg.dlc) gutter.classList.add("over");
      grid.appendChild(gutter);

      var col2 = 0;
      while (col2 < 8) {
        var bit = byte * 8 + (7 - col2);
        var here = owners[bit] || [];
        var span = 1;
        /* Unassigned bits stay as single cells so their bit number shows. */
        if (here.length) {
          while (col2 + span < 8 && sameOwners(owners[byte * 8 + (7 - (col2 + span))] || [], here)) {
            span++;
          }
        }
        grid.appendChild(makeRun(msg, here, byte, col2, span, labelled));
        col2 += span;
      }
    }

    wrap.appendChild(grid);

    if (totalBytes > rows) {
      var note = doc.createElement("p");
      note.className = "matrix-note";
      note.textContent = "Showing bytes 0\u2013" + (rows - 1) + " of " + totalBytes + ".";
      wrap.appendChild(note);
    }
    return wrap;
  }

  function headerCell(text) {
    var cell = doc.createElement("div");
    cell.className = "bit-head";
    cell.textContent = text;
    return cell;
  }

  function ownerMap(msg, rows) {
    var owners = Object.create(null);
    msg.signals.forEach(function (sig) {
      sig.cells.forEach(function (cell) {
        if (cell.byte >= rows) return;
        (owners[cell.bit] || (owners[cell.bit] = [])).push(sig);
      });
    });
    return owners;
  }

  function sameOwners(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function makeRun(msg, sigs, byte, col, span, labelled) {
    var bitHigh = byte * 8 + (7 - col);
    var bitLow = bitHigh - (span - 1);

    if (!sigs.length) {
      var empty = doc.createElement("div");
      empty.className = "cell empty";
      if (byte >= msg.dlc) empty.classList.add("over");
      empty.textContent = String(bitHigh);
      empty.title = "Bit " + bitHigh + " \u2014 unassigned";
      return empty;
    }

    var sig = sigs[0];
    var run = doc.createElement("button");
    run.type = "button";
    run.className = "cell sig";
    run.style.gridColumn = "span " + span;
    run.style.setProperty("--span", String(span));
    run.dataset.sig = sig.id;
    run.dataset.span = String(span);
    applyPaint(run, sig.index);

    /* Name it once per message — a 17-byte signal repeating its own name down
     * every row is noise, and the colour already carries the identity. */
    var label = doc.createElement("span");
    label.className = "cell-label";
    if (!labelled[sig.id]) {
      label.textContent = sig.name;
      labelled[sig.id] = true;
    }
    run.appendChild(label);

    var detail =
      sig.name +
      " \u2014 bits " +
      bitLow +
      "\u2013" +
      bitHigh +
      ", " +
      sig.length +
      "-bit " +
      byteOrderLabel(sig) +
      " starting at " +
      sig.startBit;

    if (sigs.length > 1) {
      run.classList.add("overlap");
      detail +=
        " (overlaps " +
        sigs
          .slice(1)
          .map(function (s) {
            return s.name;
          })
          .join(", ") +
        ")";
    }

    run.title = detail;
    run.setAttribute("aria-label", detail + ". Show DBC source.");
    return run;
  }

  /* ---- signal list ---- */

  function renderSignalList(msg) {
    var legend = doc.createElement("div");
    legend.className = "legend";

    if (!msg.signals.length) {
      var none = doc.createElement("p");
      none.className = "legend-empty";
      none.textContent = "No signals defined for this message.";
      legend.appendChild(none);
      return legend;
    }

    msg.signals.forEach(function (sig) {
      legend.appendChild(renderSignalRow(sig));
    });
    return legend;
  }

  function renderSignalRow(sig) {
    var row = doc.createElement("div");
    row.className = "legend-row";

    var button = doc.createElement("button");
    button.type = "button";
    button.className = "legend-main";
    button.dataset.sig = sig.id;
    applyPaint(button, sig.index);

    var swatch = doc.createElement("span");
    swatch.className = "swatch";
    swatch.setAttribute("aria-hidden", "true");
    button.appendChild(swatch);

    var text = doc.createElement("span");
    text.className = "legend-text";

    var nameLine = doc.createElement("span");
    nameLine.className = "legend-name";
    nameLine.textContent = sig.name;
    if (sig.mux) {
      var mux = doc.createElement("span");
      mux.className = "badge";
      mux.textContent = sig.isMultiplexor && sig.mux === "M" ? "mux" : sig.mux;
      mux.title =
        sig.mux === "M"
          ? "Multiplexor signal"
          : "Multiplexed \u2014 present when the multiplexor is " + sig.muxValue;
      nameLine.appendChild(mux);
    }
    text.appendChild(nameLine);

    var facts = doc.createElement("span");
    facts.className = "legend-facts mono";
    facts.appendChild(
      fact(sig.startBit + "|" + sig.length + "@" + (sig.littleEndian ? "1" : "0") + (sig.signed ? "-" : "+"))
    );
    facts.appendChild(fact(byteOrderLabel(sig)));
    facts.appendChild(fact(sig.signed ? "signed" : "unsigned"));
    if (rangeLabel(sig)) facts.appendChild(fact(rangeLabel(sig)));
    var scale = scalingLabel(sig);
    if (scale) facts.appendChild(fact(scale));
    if (sig.unit) facts.appendChild(fact(sig.unit));
    text.appendChild(facts);

    if (sig.comment) {
      var note = doc.createElement("span");
      note.className = "legend-comment";
      note.textContent = sig.comment.text;
      text.appendChild(note);
    }

    button.appendChild(text);
    row.appendChild(button);

    if (sig.values && sig.values.length) {
      var details = doc.createElement("details");
      details.className = "values";
      var summary = doc.createElement("summary");
      summary.textContent = sig.values.length + " values";
      details.appendChild(summary);
      var list = doc.createElement("dl");
      list.className = "value-list mono";
      sig.values.forEach(function (pair) {
        var dt = doc.createElement("dt");
        dt.textContent = String(pair.value);
        var dd = doc.createElement("dd");
        dd.textContent = pair.label;
        list.appendChild(dt);
        list.appendChild(dd);
      });
      details.appendChild(list);
      row.appendChild(details);
    }

    return row;
  }

  function fact(text) {
    var span = doc.createElement("span");
    span.textContent = text;
    return span;
  }

  /* ---- signal selection + DBC source panel ---- */

  function toggleSignal(card, msg, sigId) {
    var alreadyOpen = card.classList.contains("has-selection") && card.querySelector('.selected[data-sig]');
    var sameSignal = alreadyOpen && alreadyOpen.dataset.sig === sigId;

    Array.prototype.forEach.call(els.detailBody.querySelectorAll(".card"), function (other) {
      clearSelection(other);
      other.classList.remove("has-selection");
      if (other._source) {
        other._source.hidden = true;
        other._source.textContent = "";
      }
    });

    if (sameSignal) return;

    var sig = msg.signals.find(function (s) {
      return s.id === sigId;
    });
    if (!sig) return;

    card.querySelectorAll('[data-sig="' + cssEscape(sigId) + '"]').forEach(function (node) {
      node.classList.add("selected");
    });
    card.classList.add("has-selection");

    renderSource(card._source, msg, sig);
    card._source.hidden = false;
  }

  function clearSelection(card) {
    card.querySelectorAll(".selected").forEach(function (node) {
      node.classList.remove("selected");
    });
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
    return value.replace(/["\\]/g, "\\$&");
  }

  function sourceLines(msg, sig) {
    var out = [];
    out.push({ kind: "BO_", text: msg.line });
    if (msg.comment) out.push({ kind: "CM_ BO_", text: msg.comment.line });
    out.push({ kind: "SG_", text: sig.line });
    if (sig.comment) out.push({ kind: "CM_ SG_", text: sig.comment.line });
    if (sig.valueLine) out.push({ kind: "VAL_", text: sig.valueLine });
    return out;
  }

  function renderSource(panel, msg, sig) {
    panel.textContent = "";

    var head = doc.createElement("div");
    head.className = "source-head";

    var title = doc.createElement("span");
    title.className = "source-title";
    title.textContent = "DBC source \u00b7 ";
    var sigName = doc.createElement("span");
    sigName.className = "mono";
    sigName.textContent = sig.name;
    title.appendChild(sigName);
    head.appendChild(title);

    var actions = doc.createElement("div");
    actions.className = "source-actions";

    var copy = doc.createElement("button");
    copy.type = "button";
    copy.className = "ghost";
    copy.textContent = "Copy";
    copy.addEventListener("click", function () {
      var text = sourceLines(msg, sig)
        .map(function (entry) {
          return entry.text;
        })
        .join("\n");
      copyText(text).then(
        function () {
          flash(copy, "Copied");
        },
        function () {
          flash(copy, "Press \u2318C");
        }
      );
    });
    actions.appendChild(copy);

    var close = doc.createElement("button");
    close.type = "button";
    close.className = "ghost";
    close.textContent = "Close";
    close.addEventListener("click", function () {
      toggleSignal(panel.closest(".card"), msg, sig.id);
    });
    actions.appendChild(close);

    head.appendChild(actions);
    panel.appendChild(head);

    var pre = doc.createElement("pre");
    pre.className = "source-body";
    sourceLines(msg, sig).forEach(function (entry) {
      var row = doc.createElement("div");
      row.className = "source-line";
      var tag = doc.createElement("span");
      tag.className = "source-tag";
      tag.textContent = entry.kind;
      var code = doc.createElement("code");
      code.textContent = entry.text;
      row.appendChild(tag);
      row.appendChild(code);
      pre.appendChild(row);
    });
    panel.appendChild(pre);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error("clipboard unavailable"));
  }

  function flash(button, message) {
    var original = button.textContent;
    button.textContent = message;
    button.disabled = true;
    setTimeout(function () {
      button.textContent = original;
      button.disabled = false;
    }, 1200);
  }

  /* ---- wiring ---- */

  els.drop.addEventListener("click", function () {
    els.fileInput.click();
  });
  els.drop.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.fileInput.click();
    }
  });

  els.fileInput.addEventListener("change", function () {
    openFiles(els.fileInput.files);
    els.fileInput.value = "";
  });

  els.addFile.addEventListener("click", function () {
    els.fileInput.click();
  });

  GRID_THEMES.forEach(function (theme) {
    var option = doc.createElement("option");
    option.value = theme.id;
    option.textContent = theme.label;
    els.gridTheme.appendChild(option);
  });
  els.gridTheme.value = state.gridTheme;
  els.panelMap.dataset.gridTheme = state.gridTheme;
  GRID_RANGES.forEach(function (range) {
    var option = doc.createElement("option");
    option.value = range.id;
    option.textContent = range.label;
    els.gridRange.appendChild(option);
  });
  els.gridRange.value = state.range;
  els.gridRange.addEventListener("change", function () {
    state.range = rangeById(els.gridRange.value).id;
    state.rangePinned = true;
    state.selected = null;
    render();
  });

  els.gridTheme.addEventListener("change", function () {
    state.gridTheme = themeById(els.gridTheme.value).id;
    els.panelMap.dataset.gridTheme = state.gridTheme;
    render();
  });

  els.filter.addEventListener("input", function () {
    renderGrid();
    renderOthers();
  });

  els.brand.addEventListener("click", function () {
    if (state.files.length) reset();
  });

  ["dragenter", "dragover"].forEach(function (type) {
    doc.addEventListener(type, function (event) {
      if (!event.dataTransfer) return;
      event.preventDefault();
      els.drop.classList.add("drag");
      doc.body.classList.add("dragging");
    });
  });
  ["dragleave", "dragend"].forEach(function (type) {
    doc.addEventListener(type, function (event) {
      if (event.relatedTarget) return;
      els.drop.classList.remove("drag");
      doc.body.classList.remove("dragging");
    });
  });
  doc.addEventListener("drop", function (event) {
    event.preventDefault();
    els.drop.classList.remove("drag");
    doc.body.classList.remove("dragging");
    var dropped = Array.prototype.filter.call(
      (event.dataTransfer && event.dataTransfer.files) || [],
      function (file) {
        return /\.dbc$/i.test(file.name);
      }
    );
    if (!dropped.length) {
      setStatus("Drop one or more .dbc files.", "error");
      return;
    }
    openFiles(dropped);
  });

  els.detailClose.addEventListener("click", closeDetail);

  /* The dialog also closes itself — via Escape or a form method — so the
   * close event, not the button, is what clears the selection. */
  els.detail.addEventListener("close", closeDetail);

  /* Escape unwinds one layer at a time: an open DBC source panel first, the
   * dialog second. */
  els.detail.addEventListener("cancel", function (event) {
    var openSource = els.detailBody.querySelector(".card .source:not([hidden])");
    if (!openSource) return;
    event.preventDefault();
    var button = openSource.closest(".card").querySelector(".selected[data-sig]");
    if (button) button.click();
  });

  els.detail.addEventListener("click", function (event) {
    var box = els.detail.getBoundingClientRect();
    var outside =
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom;
    if (outside) els.detail.close();
  });

  render();

  /* Small hook so the map can be exercised without a file picker —
   * used by the screenshot harness. */
  /* Same failure surface as dropping the file: an inline error, not a throw. */
  function loadGuarded(name, text) {
    try {
      addFile(name, text);
      setStatus("", "");
      render();
      return true;
    } catch (err) {
      setStatus(name + ": " + (err && err.message ? err.message : "could not be parsed"), "error");
      render();
      return false;
    }
  }

  return {
    load: function (name, text) {
      state.files = [];
      state.nextIndex = 0;
      state.selected = null;
      return loadGuarded(name, text);
    },
    add: loadGuarded,
    reset: reset,
    setRange: function (id) {
      state.range = rangeById(id).id;
      state.rangePinned = true;
      els.gridRange.value = state.range;
      render();
    },
  };
}

if (typeof document !== "undefined") {
  window.dbcViewer = initApp(document);
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    signalBitOrder: signalBitOrder,
    signalCells: signalCells,
    bitToCell: bitToCell,
    decodeCanId: decodeCanId,
    parseDbc: parseDbc,
    decodeDbcBytes: decodeDbcBytes,
    signalPaint: signalPaint,
    isProprietaryB: isProprietaryB,
    GRID_RANGES: GRID_RANGES,
    rangeById: rangeById,
    rangeCellCount: rangeCellCount,
    PGN_BASE: PGN_BASE,
    PGN_END: PGN_END,
  };
}
