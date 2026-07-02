# LabscriptAI OT outbox wake — independent review (GLM-5.2)

Date: 2026-07-01
Reviewer: GLM-5.2 (independent; distinct from GPT-5.5 acceptance)
Repo: `/Users/gaoyuan/Documents/test/Flexagent/labscriptai-ot`
Scope: verify the Top 3 GPT-5.5 gaps were truly closed by the fix worker, run the full suite, and smoke-check five-adapter name consistency.
Constraints honored: read-only + only this md written; no source edits, no commit/push.

## 1. Conclusion (one sentence)

**PASS** — the three GPT-5.5 acceptance gaps are all genuinely closed, the five adapter names are consistent across the operator surface, and the full `servers/opentrons-mcp` test suite is green at 300/300; the acceptance moves from **PARTIAL → PASS**.

## 2. Top 3 gap verification

| # | GPT-5.5 gap | Evidence checked | Status |
|---|---|---|---|
| 1 | `GETTING_STARTED.md` unattended wake was three-host only; no single canonical five-host path | Section renamed to `Unattended wake (five-host self-watch)` (L521); step 2 says "delivers to all five adapters by default" and runs `arm-runtime-watch.sh` with no per-host override (L537–543); host table lists Cursor / Claude Code / Codex / Pi (experimental) / OpenCode (experimental) with link to `outbox-wake-pi-opencode.md` (L547–553); adapter delivery table includes `piagent` and `opencode` (L478–479); `OPENTRONS_NOTIFY_ADAPTERS` override documented (L542). Grep: no `three-host`/`three hosts`/`three adapters` strings remain in the four target files. | CLOSED |
| 2 | `arm-runtime-watch.sh` created only 3 dirs and hardcoded `--notify-adapters cursor,claudecode,codex` (appended, overriding docs) | `NOTIFY_ADAPTERS="${OPENTRONS_NOTIFY_ADAPTERS:-cursor,claudecode,codex,piagent,opencode}"` (L11); `mkdir -p` creates all five dirs `cursor claudecode codex piagent opencode` (L17–18); monitor invoked with `--notify-adapters "$NOTIFY_ADAPTERS"` — a single variable, no hardcoded append (L33); printed adapter list `$ADAPTER_DIR/{cursor,claudecode,codex,piagent,opencode}/...` matches runtime (L57); override documented (L60). Script reads only the env var; it does not parse a CLI `--notify-adapters`, so the doc examples using `OPENTRONS_NOTIFY_ADAPTERS=...` can no longer be silently overridden. | CLOSED |
| 3 | `install-labscriptai-ot.sh` created only 3 adapter dirs and printed "Unattended wake (three hosts)"; Pi/OpenCode not surfaced | `mkdir -p` creates all five dirs including `piagent` and `opencode` (L15–17); footer reads `Unattended wake (five hosts):` with `arm-runtime-watch.sh` command + `docs/GETTING_STARTED.md#unattended-wake-five-host-self-watch` anchor (L56–58); `Pi / OpenCode (experimental):` block points to both READMEs and `docs/outbox-wake-pi-opencode.md` (L60–63). No "three hosts" text remains. | CLOSED |

## 3. Five-adapter name consistency (smoke)

Default adapter string read from `arm-runtime-watch.sh` L11: `cursor,claudecode,codex,piagent,opencode`

| File | Where the five names appear | Matches default |
|---|---|---|
| `scripts/arm-runtime-watch.sh` | L11 default, L17–18 mkdir, L57 printed list, L67 in-agent example | yes |
| `docs/GETTING_STARTED.md` | L475–479 adapter table, L547–553 host table | yes |
| `install-labscriptai-ot.sh` | L15–17 mkdir | yes |
| `docs/outbox-wake-pi-opencode.md` | L21 mailbox path, L35 default comment, L47 direct monitor example, L73 cross-ref | yes |

`OPENTRONS_NOTIFY_ADAPTERS` override documented in all three operator files (`GETTING_STARTED.md` L542, `arm-runtime-watch.sh` L60, `outbox-wake-pi-opencode.md` L36/L73). No conflicting per-host `--notify-adapters` CLI arg is passed to `arm-runtime-watch.sh` anywhere (the Pi/OpenCode examples use the env override, which the script honors).

## 4. Full test result

Command (from `servers/opentrons-mcp`):

```bash
node --test
```

| Metric | Value |
|---|---:|
| tests | 300 |
| pass | 300 |
| fail | 0 |
| skipped | 0 |
| todo | 0 |
| cancelled | 0 |
| suites | 1 |
| duration_ms | 4414.358 |
| exit code | 0 |

Pass rate: **300/300 = 100%**. The targeted consume (14) + runtime-outbox (5) = 19 tests reported by the fix worker are included in this 300.

## 5. Comparison with GPT-5.5 acceptance (PARTIAL → ?)

| Dimension | GPT-5.5 (before fix) | GLM-5.2 (this review) |
|---|---|---|
| Overall verdict | PARTIAL | **PASS** |
| Gap 1 — five-host GETTING_STARTED | Open: section was three-host only, step 2 said "all three adapters" | Closed: five-host section, all-five default, Pi/OpenCode experimental + linked, override documented |
| Gap 2 — arm-runtime-watch.sh five-host-ready | Open: 3 dirs only, hardcoded `--notify-adapters cursor,claudecode,codex` appended (overrode docs) | Closed: 5 dirs, single overridable `NOTIFY_ADAPTERS` var defaulting to all five, no hardcoded append |
| Gap 3 — installer five-host surfacing | Open: 3 dirs only, footer said "three hosts", Pi/OpenCode not surfaced | Closed: 5 dirs, footer says "five hosts" + anchor, Pi/OpenCode READMEs + doc linked |
| Full suite | 300 pass / 0 fail | 300 pass / 0 fail (unchanged green; fix was docs/scripts only) |
| Fix-worker targeted re-test | 19/19 (14 consume + 5 runtime-outbox) | Confirmed included in 300/300 full suite |

## 6. Notes / non-blocking observations

- The vision Python deps warning reported by GPT-5.5 (`ultralytics`/`opencv`/`pillow` not importable) is unrelated to outbox wake and was not re-checked here; it remains a pre-live-vision item, not a wake-path gap.
- `docs/outbox-wake-pi-opencode.md` is marked experimental throughout (Pi MCP community extension; OpenCode plugin API volatility) — appropriate and consistent with GETTING_STARTED.
- No source code was modified; no commits or pushes were made.

## 7. Return summary

- Conclusion (one sentence): **PASS — all three GPT-5.5 gaps are genuinely closed and the full suite is green.**
- Full pass rate: **300/300 (100%)**.
- Top 3 all closed: **yes** (Gap 1, 2, 3 all CLOSED).
