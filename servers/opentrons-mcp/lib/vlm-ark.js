import fs from "fs";
import path from "path";

import {
  buildDeckPhotoAnalysisPrompt,
  buildImageDataUrl,
  extractAssistantText,
  parseAssistantJson,
} from "./siliconflow.js";

const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_ARK_MODEL_ENDPOINT = "ep-20260716144817-n6rgn";

function loadEnvFileValue(envVarName, envFilePath = null) {
  if (process.env[envVarName]) {
    return process.env[envVarName];
  }
  const candidates = [];
  if (envFilePath) {
    candidates.push(path.resolve(envFilePath));
  }
  const pluginRoot = process.env.OPENTRONS_PLUGIN_ROOT;
  if (pluginRoot) {
    candidates.push(path.join(path.resolve(pluginRoot), ".venv", ".env"));
  }
  for (const filePath of candidates) {
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }
    try {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (match && match[1] === envVarName) {
          return match[2].replace(/^['"]|['"]$/g, "");
        }
      }
    } catch {
      // continue
    }
  }
  return null;
}

export function resolveArkApiKey({ apiKey = null } = {}) {
  return apiKey || loadEnvFileValue("ARK_API_KEY") || null;
}

export function resolveArkModelEndpoint({ modelEndpoint = null } = {}) {
  return (
    modelEndpoint ||
    process.env.ARK_MODEL_ENDPOINT ||
    loadEnvFileValue("ARK_MODEL_ENDPOINT") ||
    DEFAULT_ARK_MODEL_ENDPOINT
  );
}

export function resolveArkBaseUrl({ baseUrl = null } = {}) {
  return baseUrl || process.env.ARK_BASE_URL || loadEnvFileValue("ARK_BASE_URL") || DEFAULT_ARK_BASE_URL;
}

export function buildArkResponsesBody({
  modelEndpoint,
  imageDataUrl,
  prompt,
  maxOutputTokens = 2048,
} = {}) {
  if (!modelEndpoint) {
    throw new Error("Ark model endpoint is required.");
  }
  if (!imageDataUrl) {
    throw new Error("imageDataUrl is required.");
  }
  if (!prompt) {
    throw new Error("prompt is required.");
  }

  return {
    model: modelEndpoint,
    max_output_tokens: maxOutputTokens,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: imageDataUrl,
          },
          {
            type: "input_text",
            text: prompt,
          },
        ],
      },
    ],
  };
}

export function extractArkResponseText(responseJson) {
  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];
  const textParts = [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === "output_text" && block.text) {
          textParts.push(block.text);
        }
      }
    }
  }
  if (textParts.length > 0) {
    return textParts.join("\n");
  }
  return extractAssistantText(responseJson);
}

export async function callArkResponses({
  apiKey,
  baseUrl = DEFAULT_ARK_BASE_URL,
  body,
} = {}) {
  if (!apiKey) {
    throw new Error("Ark API key is required. Pass api_key or set ARK_API_KEY.");
  }
  const url = `${String(baseUrl).replace(/\/$/, "")}/responses`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    responseJson = null;
  }

  if (!response.ok) {
    throw new Error(
      `Ark request failed: ${response.status} ${response.statusText}${
        responseText ? ` - ${responseText}` : ""
      }`,
    );
  }

  return {
    json: responseJson,
    requestId: responseJson?.id || response.headers.get("x-request-id") || null,
  };
}

export async function analyzeImageWithArk({
  imagePath,
  apiKey = null,
  baseUrl = null,
  modelEndpoint = null,
  prompt = null,
  expectedLayout = null,
  maxOutputTokens = 2048,
} = {}) {
  const { dataUrl, imagePath: resolvedImage, mimeType } = buildImageDataUrl(imagePath);
  const resolvedApiKey = resolveArkApiKey({ apiKey });
  const resolvedModel = resolveArkModelEndpoint({ modelEndpoint });
  const resolvedBaseUrl = resolveArkBaseUrl({ baseUrl });
  const resolvedPrompt = buildDeckPhotoAnalysisPrompt({
    prompt,
    expectedLayout,
  });
  const body = buildArkResponsesBody({
    modelEndpoint: resolvedModel,
    imageDataUrl: dataUrl,
    prompt: resolvedPrompt,
    maxOutputTokens,
  });
  const response = await callArkResponses({
    apiKey: resolvedApiKey,
    baseUrl: resolvedBaseUrl,
    body,
  });
  const assistantText = extractArkResponseText(response.json);
  const parsed = parseAssistantJson(assistantText);

  return {
    image_path: resolvedImage,
    mime_type: mimeType,
    provider: "ark",
    model_endpoint: resolvedModel,
    resolved_model: response.json?.model || resolvedModel,
    request_id: response.requestId,
    prompt: resolvedPrompt,
    parsed_result: parsed,
    raw_text: assistantText,
    usage: response.json?.usage || null,
    status: response.json?.status || null,
  };
}
