import test from "node:test";
import assert from "node:assert/strict";

import {
  buildArkDeckPhotoAnalysisPrompt,
  buildArkResponsesBody,
  extractArkMessageText,
  extractArkReasoningSummaryText,
  extractArkResponseText,
  extractLastJsonObject,
  resolveArkApiKey,
  resolveArkAssistantPayload,
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
  assert.equal(body.max_output_tokens, 4096);
});

test("buildArkDeckPhotoAnalysisPrompt requires direct JSON output", () => {
  const prompt = buildArkDeckPhotoAnalysisPrompt({
    expectedLayout: { B2: "tiprack" },
  });
  assert.match(prompt, /JSON/);
  assert.match(prompt, /不要推理过程/);
  assert.match(prompt, /B2/);
});

test("extractArkMessageText reads output_text blocks", () => {
  const text = extractArkMessageText({
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: '{"summary":"ok"}' }],
      },
    ],
  });
  assert.equal(text, '{"summary":"ok"}');
});

test("extractArkReasoningSummaryText reads reasoning summary blocks", () => {
  const text = extractArkReasoningSummaryText({
    output: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "draft {\"summary\":\"from reasoning\"}" }],
      },
    ],
  });
  assert.match(text, /from reasoning/);
});

test("extractLastJsonObject pulls trailing JSON from reasoning text", () => {
  const text = [
    "some draft notes",
    "{",
    '  "summary": "B2 has tiprack",',
    '  "needs_human_review": true',
    "}",
  ].join("\n");
  const json = extractLastJsonObject(text);
  assert.equal(json.includes('"summary": "B2 has tiprack"'), true);
  assert.deepEqual(JSON.parse(json), {
    summary: "B2 has tiprack",
    needs_human_review: true,
  });
});

test("resolveArkAssistantPayload falls back to reasoning JSON when message incomplete", () => {
  const payload = resolveArkAssistantPayload({
    status: "incomplete",
    incomplete_details: { reason: "length" },
    output: [
      {
        type: "reasoning",
        summary: [
          {
            type: "summary_text",
            text: 'draft notes\n{\n  "summary": "deck ok",\n  "observed_items": [{"slot":"B2","label":"tiprack","confidence":0.8,"evidence":"visible"}],\n  "possible_issues": [],\n  "uncertainties": [],\n  "recommended_next_actions": ["reconcile_state"],\n  "needs_human_review": true\n}',
          },
        ],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: '{"summary":"trunc' }],
      },
    ],
  });

  assert.equal(payload.text_source, "reasoning_summary_json");
  assert.equal(payload.reasoning_fallback_used, true);
  assert.equal(payload.parsed_result.summary, "deck ok");
  assert.equal(payload.parsed_result.observed_items[0].slot, "B2");
});

test("extractArkResponseText prefers message over reasoning", () => {
  const text = extractArkResponseText({
    output: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "reasoning only" }],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: '{"summary":"message wins"}' }],
      },
    ],
  });
  assert.equal(text, '{"summary":"message wins"}');
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
