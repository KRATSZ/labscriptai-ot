import test from "node:test";
import assert from "node:assert/strict";

import {
  buildArkResponsesBody,
  extractArkResponseText,
  resolveArkApiKey,
  resolveArkModelEndpoint,
} from "../lib/vlm-ark.js";

test("buildArkResponsesBody uses Ark responses schema", () => {
  const body = buildArkResponsesBody({
    modelEndpoint: "ep-test",
    imageDataUrl: "data:image/png;base64,AAA",
    prompt: "你看见了什么？",
  });

  assert.equal(body.model, "ep-test");
  assert.equal(body.input[0].role, "user");
  assert.equal(body.input[0].content[0].type, "input_image");
  assert.equal(body.input[0].content[1].type, "input_text");
});

test("extractArkResponseText reads output_text blocks", () => {
  const text = extractArkResponseText({
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: '{"summary":"ok"}' }],
      },
    ],
  });
  assert.equal(text, '{"summary":"ok"}');
});

test("resolveArkModelEndpoint defaults to configured endpoint", () => {
  const original = process.env.ARK_MODEL_ENDPOINT;
  delete process.env.ARK_MODEL_ENDPOINT;
  try {
    assert.equal(resolveArkModelEndpoint({}), "ep-20260716144817-n6rgn");
  } finally {
    if (original) {
      process.env.ARK_MODEL_ENDPOINT = original;
    }
  }
});

test("resolveArkApiKey reads explicit api key", () => {
  assert.equal(resolveArkApiKey({ apiKey: "ark-test" }), "ark-test");
});
