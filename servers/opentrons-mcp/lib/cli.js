// Operator commands target PowerShell on Windows and POSIX shells elsewhere.
export function quoteCliArg(value, platform = process.platform) {
  const text = String(value);
  return "'" + text.replaceAll("'", platform === "win32" ? "''" : "'\"'\"'") + "'";
}
