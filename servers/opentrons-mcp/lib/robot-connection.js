import fs from "node:fs";
import path from "node:path";
import { atomicWrite, dataHome } from "../../../scripts/runtime-paths.mjs";

// User-wide, outside versioned plugin caches and per-experiment PLUGIN_DATA.
export function robotConnectionPath() {
  if (process.env.OPENTRONS_CONNECTION_FILE?.trim()) {
    return path.resolve(process.env.OPENTRONS_CONNECTION_FILE.trim());
  }
  return path.join(dataHome(), "robot-connection.json");
}

export function normalizeRobotAddress(address) {
  if (typeof address !== "string" || !address.trim()) {
    throw new Error("robot_ip must be a non-empty robot IP, hostname or HTTP(S) base URL.");
  }
  const value = address.trim();
  const hasScheme = /^https?:\/\//i.test(value);
  const url = new URL(hasScheme ? value : `http://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("robot_ip must be a robot IP, hostname or HTTP(S) base URL without credentials, path or query.");
  }
  const explicitPort = /^(\[[^\]]+\]|[^:/]+):\d+\/?$/.test(value);
  if (!hasScheme && !explicitPort) url.port = process.env.OPENTRONS_PORT || "31950";
  return url.origin;
}

function readConfig(file) {
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const address = config.robot_ip || (config.host
      ? `${config.scheme || "http"}://${config.host}:${config.port || 31950}` : null);
    if (!address) throw new Error("Missing robot address");
    return { ...config, robot_ip: normalizeRobotAddress(address) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read saved robot connection at ${file}. Provide robot_ip to replace it. ${error.message}`);
  }
}

export function resolveRobotConnection(robotIp) {
  if (robotIp !== undefined && robotIp !== null) {
    return { robot_ip: normalizeRobotAddress(robotIp), source: "argument" };
  }
  if (process.env.OPENTRONS_HOST?.trim()) {
    return { robot_ip: normalizeRobotAddress(process.env.OPENTRONS_HOST), source: "environment" };
  }
  const saved = readConfig(robotConnectionPath());
  if (saved) return { robot_ip: saved.robot_ip, source: "saved" };
  return null;
}

export function requireRobotAddress(robotIp) {
  const connection = resolveRobotConnection(robotIp);
  if (!connection) {
    throw new Error("No saved robot connection. Provide robot_ip once (or set OPENTRONS_HOST); it is saved after a successful connection and reused in future chats.");
  }
  return connection.robot_ip;
}

export function rememberRobotAddress(robotIp) {
  const address = normalizeRobotAddress(robotIp);
  const file = robotConnectionPath();
  let previous = null;
  try { previous = readConfig(file); } catch { /* An explicit address repairs a corrupt file. */ }
  if (previous?.robot_ip === address) return;
  const url = new URL(address);
  atomicWrite(file, `${JSON.stringify({
    robot_ip: address,
    host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    scheme: url.protocol.slice(0, -1),
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`);
}

export function robotConnectionSummary(robotIp) {
  try {
    return { robot_ip: null, source: null, ...resolveRobotConnection(robotIp), config_path: robotConnectionPath() };
  } catch (error) {
    return { robot_ip: null, config_path: robotConnectionPath(), error: error.message };
  }
}
