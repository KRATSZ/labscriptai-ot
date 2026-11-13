import { rememberRobotAddress, requireRobotAddress } from "./robot-connection.js";

const configuredAuthorization = process.env.OPENTRONS_AUTHORIZATION;
// Keep tunnel credentials in the MCP process; authored protocol Python is a child process.
delete process.env.OPENTRONS_AUTHORIZATION;
const DEFAULT_VERSION_HEADER = process.env.OPENTRONS_VERSION || "4";

function safeJsonParse(text) {
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

export function normalizeBaseUrl(robotIp) {
  return requireRobotAddress(robotIp);
}

function rememberConnectedRobot(address) {
  try {
    rememberRobotAddress(address);
  } catch (error) {
    // A settings write failure must never turn completed robot motion into a
    // failed request that callers might retry.
    console.error(`Robot connected, but its address could not be saved: ${error.message}`);
  }
}

export function buildRobotUrl(robotIp, pathname, searchParams = null) {
  const url = new URL(`${normalizeBaseUrl(robotIp)}${pathname}`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export async function requestJson(method, url, { headers = {}, body = null } = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Opentrons-Version": DEFAULT_VERSION_HEADER,
        ...headers,
      },
      body,
      redirect: "error",
    });

    const contentType = response.headers.get("content-type") || "";
    const rawText = await response.text();
    let data;

    if (contentType.includes("application/json")) {
      data = safeJsonParse(rawText || "null");
    } else {
      data = rawText;
    }

    if (!response.ok) {
      const error = new Error(
        JSON.stringify(
          {
            status: response.status,
            statusText: response.statusText,
            error: data,
          },
          null,
          2,
        ),
      );
      error.response = data;
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (error) {
    if (error instanceof Error && error.message !== "fetch failed") {
      throw error;
    }

    const causeCode = error?.cause?.code || null;
    const causeMessage = error?.cause?.message || error?.message || "unknown network error";
    throw new Error(
      `Network request failed for ${method} ${url}: ${causeCode ? `${causeCode}: ` : ""}${causeMessage}`,
    );
  }
}

export async function requestBytes(method, url, { headers = {}, body = null } = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Opentrons-Version": DEFAULT_VERSION_HEADER,
        ...headers,
      },
      body,
      redirect: "error",
    });

    const contentType = response.headers.get("content-type") || "";
    const data = Buffer.from(await response.arrayBuffer());

    if (!response.ok) {
      const error = new Error(
        JSON.stringify(
          {
            status: response.status,
            statusText: response.statusText,
            error: contentType.includes("application/json")
              ? safeJsonParse(data.toString("utf8") || "null")
              : data.toString("utf8"),
          },
          null,
          2,
        ),
      );
      error.response = data;
      error.status = response.status;
      throw error;
    }

    return {
      data,
      contentType,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    if (error instanceof Error && error.message !== "fetch failed") {
      throw error;
    }

    const causeCode = error?.cause?.code || null;
    const causeMessage = error?.cause?.message || error?.message || "unknown network error";
    throw new Error(
      `Network request failed for ${method} ${url}: ${causeCode ? `${causeCode}: ` : ""}${causeMessage}`,
    );
  }
}

function authorizationHeaders(address, headers) {
  if (!configuredAuthorization || !process.env.OPENTRONS_HOST || address !== normalizeBaseUrl(process.env.OPENTRONS_HOST)) return headers;
  return { Authorization: configuredAuthorization, ...headers };
}

export async function requestRobotJson(
  method,
  robotIp,
  pathname,
  { headers = {}, body = null, searchParams = null } = {},
) {
  const address = normalizeBaseUrl(robotIp);
  const result = await requestJson(method, buildRobotUrl(address, pathname, searchParams), {
    headers: authorizationHeaders(address, headers),
    body,
  });
  rememberConnectedRobot(address);
  return result;
}

export async function requestRobotBytes(
  method,
  robotIp,
  pathname,
  { headers = {}, body = null, searchParams = null } = {},
) {
  const address = normalizeBaseUrl(robotIp);
  const result = await requestBytes(method, buildRobotUrl(address, pathname, searchParams), {
    headers: authorizationHeaders(address, headers),
    body,
  });
  rememberConnectedRobot(address);
  return result;
}
