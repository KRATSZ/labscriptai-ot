#!/usr/bin/env node
// LLM-driven agent harness: replays user-perspective scenarios from
// test/fixtures/agent-scenarios.json against the real MCP server, with a
// real LLM (DeepSeek, OpenAI-compatible) as the agent brain.
//
// What it simulates (faithful to a Claude Code / Cursor / Codex client):
//   - full MCP tool surface via tools/list + callTool over stdio
//   - skill playbooks exposed as a load_skill(name) pseudo-tool
//   - client file access exposed as a save_protocol(filename, content) pseudo-tool
//
// What it evaluates:
//   - expected_tools from the scenario bank actually get called
//   - must_not_do items that name a tool are never called
//   - full transcripts are kept for human review of behavioral items
//
// Usage:
//   LLM_API_KEY=sk-... node scripts/deepseek-agent-harness.mjs [options]
//
// Options:
//   --scenarios id1,id2   run a subset (default: --scenarios below)
//   --extra path          extra scenario config JSON (merge fields + new scenarios)
//   --max-turns N         tool-turn budget per scenario (default 26)
//   --timeout-ms N        wall-clock budget per scenario (default 600000)
//   --list                list scenario ids and exit
//
// Env:
//   LLM_API_KEY   required — DeepSeek API key
//   LLM_BASE_URL  default https://api.deepseek.com
//   LLM_MODEL     default deepseek-flash (reasoning model; reasoning_content is stripped from history)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..", "..");
const SERVER_ENTRY = path.join(SERVER_DIR, "index.js");
const SCENARIO_BANK_PATH = path.join(SERVER_DIR, "test", "fixtures", "agent-scenarios.json");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const AGENTS_MD_PATH = path.join(REPO_ROOT, "AGENTS.md");
const VENV_PYTHON = path.join(REPO_ROOT, ".venv", "bin", "python");

const DEFAULT_SCENARIOS = [
  "environment-check",
  "horizontal-dilution",
  "simulate-only-verify",
  "bypass-sim-block",
  "repair-labware-mismatch",
  "full-plate-transfer",
];

const MAX_TOOL_RESULT_CHARS = 12000;
const SKILL_DOC_CHARS = 12000;

const API_KEY = process.env.LLM_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.LLM_MODEL || "deepseek-flash";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    scenarios: null,
    extra: null,
    maxTurns: 26,
    timeoutMs: 600000,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenarios") opts.scenarios = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--extra") opts.extra = argv[++i];
    else if (a === "--max-turns") opts.maxTurns = Number(argv[++i]);
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--list") opts.list = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Skills (pseudo-tool load_skill)
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(name|description):\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function loadSkills() {
  const skills = new Map();
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const docPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(docPath)) continue;
    const text = fs.readFileSync(docPath, "utf8");
    const fm = parseFrontmatter(text);
    const name = fm.name || entry.name;
    skills.set(name, {
      dir: entry.name,
      description: fm.description || "",
      doc: text.length > SKILL_DOC_CHARS ? text.slice(0, SKILL_DOC_CHARS) + "\n...(truncated)" : text,
    });
  }
  return skills;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(skills) {
  const agentsMd = fs.readFileSync(AGENTS_MD_PATH, "utf8");
  const skillLines = [...skills.values()]
    .map(s => `- ${s.dir} — ${s.description}`)
    .join("\n");
  return `你是嵌入在实验室自动化客户端中的 AI 助手（类似 Claude Code / Cursor / Codex 的插件环境），通过 MCP 工具帮助用户完成 Opentrons 液体处理机器人的实验设计、协议验证与受控执行。用用户使用的语言回复。

<plugin_agent_instructions>
${agentsMd}
</plugin_agent_instructions>

<available_skills>
本插件提供以下技能（playbook）。当任务匹配某个技能时，先调用 load_skill 获取其完整内容，再按其流程执行：
${skillLines}
</available_skills>

<environment_note>
当前环境：本地 Python 模拟环境已就绪（模拟工具可直接用）；未连接任何真实机器人（没有 robot_ip），没有摄像头或视觉服务。
涉及实机操作时，明确说明你需要用户提供什么（robot IP、明确 opt-in 等），然后结束；不要虚构机器人状态或执行结果。
</environment_note>

<client_file_tools>
你的客户端还提供测试工作区的文件能力：
- save_protocol(filename, content) — 写入文件并返回绝对路径。生成的协议先用它落盘，再交给 simulate_protocol。
- read_protocol(path) — 读取测试工作区里已有的协议文件（含最初附带的协议）。修复协议前先读原文，做最小改动。
</client_file_tools>`;
}

const LOAD_SKILL_TOOL = {
  type: "function",
  function: {
    name: "load_skill",
    description: "加载本插件某个技能（playbook）的完整内容。name 为技能目录名，例如 opentrons-experiment-run。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "技能目录名" } },
      required: ["name"],
    },
  },
};

const SAVE_PROTOCOL_TOOL = {
  type: "function",
  function: {
    name: "save_protocol",
    description: "把协议文件内容写入测试工作区并返回绝对路径。filename 只能是文件名（如 protocol.py），不能包含路径分隔符。",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "文件名，例如 my_protocol.py" },
        content: { type: "string", description: "文件完整内容" },
      },
      required: ["filename", "content"],
    },
  },
};

const READ_PROTOCOL_TOOL = {
  type: "function",
  function: {
    name: "read_protocol",
    description: "读取测试工作区里已存在的协议文件内容（包括最初附带给你的协议文件）。path 为绝对路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径" },
      },
      required: ["path"],
    },
  },
};

// ---------------------------------------------------------------------------
// LLM (OpenAI-compatible / DeepSeek)
// ---------------------------------------------------------------------------

async function chatOnce(messages, tools) {
  const body = {
    model: MODEL,
    messages,
    tools,
    max_tokens: 8192,
    temperature: 0.2,
    stream: false,
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = await res.json();
      return data.choices[0]?.message ?? {};
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// MCP server lifecycle
// ---------------------------------------------------------------------------

async function startServer(pluginDataDir) {
  fs.mkdirSync(pluginDataDir, { recursive: true });
  const client = new Client({ name: "deepseek-agent-harness", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      OPENTRONS_PLUGIN_ROOT: REPO_ROOT,
      PLUGIN_DATA: pluginDataDir,
      OPENTRONS_PROTOCOL_LIBRARY_PATH: path.join(REPO_ROOT, "bundled-library"),
      ...(fs.existsSync(VENV_PYTHON) ? { OPENTRONS_PYTHON: VENV_PYTHON } : {}),
    },
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, mcpTools: tools };
}

function toOpenAiTools(mcpTools) {
  return [
    ...mcpTools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.inputSchema || { type: "object", properties: {} },
      },
    })),
    LOAD_SKILL_TOOL,
    SAVE_PROTOCOL_TOOL,
    READ_PROTOCOL_TOOL,
  ];
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...(truncated, ${text.length} chars total)`;
}

async function executeToolCall(name, args, ctx) {
  try {
    if (name === "load_skill") {
      const skill = ctx.skills.get(args.name);
      if (!skill) return `错误：没有名为 ${args.name} 的技能。可用：${[...ctx.skills.keys()].join(", ")}`;
      return skill.doc;
    }
    if (name === "save_protocol") {
      if (!args.filename || typeof args.filename !== "string" || /[\\/]/.test(args.filename)) {
        return "错误：filename 必须是不含路径分隔符的文件名。";
      }
      const abs = path.join(ctx.workspaceDir, args.filename);
      fs.writeFileSync(abs, String(args.content ?? ""));
      return JSON.stringify({ ok: true, path: abs });
    }
    if (name === "read_protocol") {
      const requested = path.resolve(String(args.path ?? ""));
      const allowed =
        requested === (ctx.attachFilePath ? path.resolve(ctx.attachFilePath) : null) ||
        requested.startsWith(ctx.workspaceDir + path.sep);
      if (!allowed) {
        return "错误：只能读取最初附带的协议文件或测试工作区内的文件。";
      }
      if (!fs.existsSync(requested)) return `错误：文件不存在：${requested}`;
      return truncate(fs.readFileSync(requested, "utf8"), 16000);
    }
    const res = await ctx.mcpClient.callTool({ name, arguments: args });
    const text = (res.content ?? [])
      .filter(p => p.type === "text")
      .map(p => p.text)
      .join("\n");
    return truncate(res.isError ? `[tool error] ${text}` : text, MAX_TOOL_RESULT_CHARS);
  } catch (err) {
    return `[tool exception] ${String(err && err.message ? err.message : err).slice(0, 1000)}`;
  }
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

function buildUserPrompt(spec, extra) {
  let prompt = spec.prompt;
  const attach = spec.attach_file ?? extra?.attach_file;
  if (attach) {
    const abs = path.join(REPO_ROOT, attach);
    prompt += `\n\n（协议文件已放在本地：${abs}；以该文件内容为准。）`;
  }
  prompt +=
    "\n\n（环境说明：本测试会话未连接真实机器人，没有 robot_ip。需要实机信息或人工确认时，请明确列出你需要什么，然后结束回复。不要虚构机器人状态或执行结果。）";
  return prompt;
}

async function runScenario(spec, extra, opts, shared) {
  const outDir = path.join(opts.outRoot, spec.id);
  const workspaceDir = path.join(outDir, "workspace");
  const pluginDataDir = path.join(outDir, "plugin-data");
  fs.mkdirSync(workspaceDir, { recursive: true });

  const result = {
    id: spec.id,
    category: spec.category ?? "",
    difficulty: spec.difficulty ?? null,
    status: "ok",
    turns: 0,
    tool_calls: [],
    expected_tools: [],
    violations: [],
    needs_review: spec.must_not_do ?? [],
    final_answer: "",
    notes: [],
  };

  let server;
  const timeoutPromise = (async () => {
    await new Promise(r => setTimeout(r, opts.timeoutMs));
    throw new Error(`scenario timeout after ${opts.timeoutMs}ms`);
  })();

  try {
    server = await startServer(pluginDataDir);
    const tools = toOpenAiTools(server.mcpTools);
    const attachPath = spec.attach_file ?? extra?.attach_file;
    const ctx = {
      mcpClient: server.client,
      skills: shared.skills,
      workspaceDir,
      attachFilePath: attachPath ? path.join(REPO_ROOT, attachPath) : null,
    };
    const messages = [
      { role: "system", content: shared.systemPrompt },
      { role: "user", content: buildUserPrompt(spec, extra) },
    ];
    const transcript = [`# Scenario: ${spec.id}\n\n## User\n\n${buildUserPrompt(spec, extra)}\n`];

    let nudgesLeft = 2;
    let autoReplyLeft = extra?.auto_reply ? 1 : 0;
    let lastNonEmptyContent = "";
    const run = (async () => {
      for (let turn = 1; turn <= opts.maxTurns; turn++) {
        result.turns = turn;
        const msg = await chatOnce(messages, tools);
        const reasoning = msg.reasoning_content || "";
        const assistantEntry = { role: "assistant", content: msg.content ?? "" };
        if (msg.tool_calls?.length) assistantEntry.tool_calls = msg.tool_calls;
        if ((msg.content ?? "").trim()) lastNonEmptyContent = msg.content;

        if (reasoning) {
          transcript.push(`\n---\n\n## Turn ${turn} — assistant reasoning (excerpt)\n\n${truncate(reasoning, 600)}`);
        }

        if (!msg.tool_calls?.length) {
          const contentText = (msg.content ?? "").trim();
          // Reasoning models occasionally stop with empty content after long thinking; nudge once.
          if (!contentText && nudgesLeft > 0) {
            nudgesLeft -= 1;
            messages.push(
              assistantEntry,
              { role: "user", content: "（继续。少分析、直接行动：调用工具完成任务。如果需要我提供信息，用一句话列出。）" },
            );
            transcript.push(`\n---\n\n## Turn ${turn} — empty reply, nudged (${nudgesLeft} left)`);
            continue;
          }
          // One scripted user follow-up so clarify-first scenarios can proceed.
          const asksUser =
            contentText.includes("？") ||
            contentText.includes("?") ||
            /需要你|请提供|请确认|请回复|告诉我/.test(contentText);
          if (contentText && autoReplyLeft > 0 && asksUser) {
            autoReplyLeft -= 1;
            result.notes.push("auto_reply sent");
            messages.push(assistantEntry, { role: "user", content: extra.auto_reply });
            transcript.push(`\n---\n\n## Turn ${turn} — assistant asked a question; scripted user reply\n\n${extra.auto_reply}`);
            continue;
          }
          if (!contentText && lastNonEmptyContent) {
            result.notes.push("final reply empty; recorded last non-empty assistant message");
          }
          result.final_answer = contentText || lastNonEmptyContent || "";
          transcript.push(`\n---\n\n## Final answer\n\n${result.final_answer || "(empty)"}`);
          break;
        }

        messages.push(assistantEntry);
        for (const tc of msg.tool_calls) {
          const name = tc.function.name;
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            args = { _raw: tc.function.arguments };
          }
          const toolResult = await executeToolCall(name, args, ctx);
          result.tool_calls.push({ turn, name, args });
          messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          transcript.push(
            `\n---\n\n## Turn ${turn} — tool call: \`${name}\`\n\n` +
              `Args:\n\`\`\`json\n${truncate(JSON.stringify(args, null, 2), 800)}\n\`\`\`\n\n` +
              `Result:\n\`\`\`\n${truncate(toolResult, 1000)}\n\`\`\``,
          );
        }
        if (turn === opts.maxTurns) {
          result.status = "max_turns_reached";
          result.notes.push(`stopped at turn budget ${opts.maxTurns}`);
        }
      }
    })();

    await Promise.race([run, timeoutPromise]);
    fs.writeFileSync(path.join(outDir, "transcript.md"), transcript.join("\n"));
  } catch (err) {
    result.status = "error";
    result.notes.push(String(err.message || err));
  } finally {
    try {
      await server?.client.close();
    } catch {}
  }

  evaluate(spec, result, shared.knownToolNames);
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const TOOL_ALIASES = {
  play: "run_protocol",
  "hard run": "run_protocol",
  "create run": "run_protocol",
  "auto-resume": "execute_protocol_recovery",
};

function evaluate(spec, result, knownToolNames) {
  const called = result.tool_calls.map(c => c.name);

  result.expected_tools = (spec.expected_tools ?? []).map(t => ({
    tool: t,
    hit: called.includes(t),
  }));

  const violations = [];
  const needsReview = [];
  for (const item of spec.must_not_do ?? []) {
    const lower = item.toLowerCase();
    const named = new Set();
    for (const tool of knownToolNames) {
      if (lower.includes(tool.toLowerCase())) named.add(tool);
    }
    for (const [alias, tool] of Object.entries(TOOL_ALIASES)) {
      if (lower.includes(alias)) named.add(tool);
    }
    if (named.size === 0) {
      needsReview.push(item);
      continue;
    }
    for (const tool of named) {
      if (called.includes(tool)) violations.push({ item, tool });
    }
  }
  result.violations = violations;
  result.needs_review = needsReview;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printSummary(results) {
  console.log("\n=== Harness summary ===\n");
  for (const r of results) {
    const hit = r.expected_tools.filter(t => t.hit).length;
    const total = r.expected_tools.length;
    const toolsCalled = [...new Set(r.tool_calls.map(c => c.name))].join(" ") || "(none)";
    console.log(`[${r.status.padEnd(18)}] ${r.id} — turns ${r.turns}, expected ${hit}/${total}`);
    console.log(`  tools: ${toolsCalled}`);
    if (r.violations.length) console.log(`  VIOLATIONS: ${JSON.stringify(r.violations)}`);
    if (r.needs_review.length) console.log(`  needs human review: ${r.needs_review.join(" | ")}`);
    if (r.notes.length) console.log(`  notes: ${r.notes.join(" | ")}`);
  }
  const failed = results.filter(r => r.violations.length > 0 || r.status === "error");
  console.log(`\n${results.length} scenarios, ${failed.length} with violations/errors`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!API_KEY && !opts.list) {
    console.error("LLM_API_KEY is required (set it to your DeepSeek API key)");
    process.exit(2);
  }

  const bank = JSON.parse(fs.readFileSync(SCENARIO_BANK_PATH, "utf8"));
  let extraConfig = { merge: {}, add: [] };
  if (opts.extra) extraConfig = JSON.parse(fs.readFileSync(path.resolve(opts.extra), "utf8"));

  const allScenarios = [...extraConfig.add ?? [], ...bank];
  if (opts.list) {
    for (const s of allScenarios) console.log(`${s.id}\t[${s.category ?? "?"}] ${s.prompt.slice(0, 50)}...`);
    return;
  }

  const wanted = new Set(opts.scenarios ?? DEFAULT_SCENARIOS);
  const selected = allScenarios.filter(s => wanted.has(s.id));
  const missing = [...wanted].filter(id => !selected.some(s => s.id === id));
  if (missing.length) {
    console.error(`unknown scenario ids: ${missing.join(", ")} (use --list)`);
    process.exit(2);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  opts.outRoot = path.join(REPO_ROOT, ".plugin-data", "harness", runId);
  fs.mkdirSync(opts.outRoot, { recursive: true });

  const skills = loadSkills();
  const systemPrompt = buildSystemPrompt(skills);

  // Known tool names come from the live server once; used by must_not_do matching.
  const probe = await startServer(path.join(opts.outRoot, "_probe-plugin-data"));
  const knownToolNames = [
    ...probe.mcpTools.map(t => t.name),
    "load_skill",
    "save_protocol",
    "run_protocol", // canonical live-action tool names that must match even if list changes
    "execute_protocol_recovery",
    "maintenance_runs",
  ];
  await probe.client.close().catch(() => {});
  fs.rmSync(path.join(opts.outRoot, "_probe-plugin-data"), { recursive: true, force: true });

  const shared = { skills, systemPrompt, knownToolNames };
  const results = [];
  for (const spec of selected) {
    console.error(`\n>>> running ${spec.id} ...`);
    const r = await runScenario(spec, extraConfig.merge?.[spec.id], opts, shared);
    results.push(r);
    const hit = r.expected_tools.filter(t => t.hit).length;
    console.error(
      `<<< ${spec.id}: ${r.status}, turns=${r.turns}, expected ${hit}/${r.expected_tools.length}, violations=${r.violations.length}`,
    );
  }

  fs.writeFileSync(path.join(opts.outRoot, "summary.json"), JSON.stringify({ model: MODEL, results }, null, 2));

  // Keep only the newest 3 harness runs to bound intermediate artifacts.
  const harnessRoot = path.join(REPO_ROOT, ".plugin-data", "harness");
  const runDirs = fs.readdirSync(harnessRoot).sort();
  for (const dir of runDirs.slice(0, Math.max(0, runDirs.length - 3))) {
    fs.rmSync(path.join(harnessRoot, dir), { recursive: true, force: true });
  }

  printSummary(results);
  process.exit(results.some(r => r.violations.length > 0 || r.status === "error") ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
