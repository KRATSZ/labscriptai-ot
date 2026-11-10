import path from "node:path";

// Only the single-line strings and first array item needed by setup checks.
// This is not a general TOML document parser. Literal strings preserve slashes;
// basic strings decode TOML escapes (including eight-digit Unicode escapes).
const STRING = String.raw`("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')`;
const SPACE_OR_COMMENT = String.raw`(?:\s|#[^\r\n]*(?:\r?\n|$))*`;

function decodeString(token) {
  const value = token.slice(1, -1);
  if (token.startsWith("'")) return value;
  const escapes = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  return value.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, escape) => {
    if (Object.hasOwn(escapes, escape)) return escapes[escape];
    if (/^(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})$/.test(escape)) {
      const point = Number.parseInt(escape.slice(1), 16);
      if (point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) return String.fromCodePoint(point);
    }
    throw new Error(`Invalid TOML string escape: \\${escape}`);
  });
}

function extract(text, key, prefix) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^[ \\t]*${escapedKey}[ \\t]*=[ \\t]*${prefix}${STRING}`, "m"));
  return match ? decodeString(match[1]) : null;
}

export function extractTomlString(text, key) {
  return extract(text, key, "");
}

export function extractTomlArrayFirstString(text, key) {
  return extract(text, key, `\\[${SPACE_OR_COMMENT}`);
}

export function sameAbsolutePath(actual, expected, paths = path) {
  if (typeof actual !== "string" || !paths.isAbsolute(actual)) return false;
  const normalize = value => {
    const normalized = paths.normalize(value).replace(/[\\/]+$/, "");
    return paths === path.win32 ? normalized.toLowerCase() : normalized;
  };
  return normalize(actual) === normalize(expected);
}
