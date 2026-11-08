# Neurolink engine

The code that runs a Neurolink brain on a Mac: local search over your Obsidian vault, a live brain map,
and small "neuron" jobs that reflect on your notes and on your agents' mistakes. It never edits your notes.
It writes only its own: new pattern, link and consolidation notes under `_brain/patterns/`, review candidates
under `_claude/learning/candidates/`, trace proposals under `_claude/learning/trace-proposals/`, plus a few notes
it maintains itself (`_brain/patterns/Taste Profile.md`, `Patterns — MOC.md`, `Self-Test.md`, and a line in
`_brain/log.md` per run).

Your memory never lives here. The vault is yours; this folder holds code plus a private config file.

## What's inside
| File | What it does |
|---|---|
| `rag-server.mjs` | Search server on `http://127.0.0.1:8920` (`/search`, `/health`, `/graph`, `/chat`), serves `brain.html` |
| `rag-index.mjs`, `index-maintenance.mjs`, `live-index.mjs` | Builds and refreshes the on-device search index (MiniLM embeddings) |
| `retrieval-*.mjs`, `jev-rerank.mjs` | Ranking, evidence labels, optional reranker |
| `vault-graph.mjs`, `gen-vault-data.js`, `brain.html` | The brain map: every note a neuron, every wikilink a synapse |
| `refresh.mjs` | Hourly index refresh (daily full rebuild in the 03:00 hour) |
| `health.mjs` | 15 health checks; writes `health-status.json` |
| `neurons/run-neuron.mjs` | Pattern, Memory and Link neurons + self-test |
| `neurons/trace-miner.mjs` | Turns repeated agent failures and builder-review findings into fix proposals (review only) |
| `neurons/test-trace-miner.mjs` | Behavioural suite for the trace-miner (`node engine/neurons/test-trace-miner.mjs`) |
| `neurons/llm-hermes.sh`, `neurons/llm-luna.sh` | Model wrappers the neurons call instead of `claude -p` |
| `config.mjs` | Loads your private settings |

## Setup
1. Node (tested on v22.22.3) and the one dependency: `npm install`
2. `cp neurolink.config.example.json neurolink.config.json` and fill in your values
   (vault path, your name, folder -> brain-region rules, private names to exclude, log folder).
   `neurolink.config.json` is gitignored — keep it that way. Nothing starts without it, and a broken
   file stops the engine rather than running without your privacy filter. The example ships with **no
   review root**, so a fresh checkout sends no review text (see D1 below).
3. Build the index: `node rag-index.mjs --full`
4. Start the server: `node rag-server.mjs`, then open `http://127.0.0.1:8920`
5. Health: `node health.mjs` · Trace-Miner self-check: `node neurons/trace-miner.mjs --selftest`
   (config-free: it pins the 11 finding shapes and needs no `neurolink.config.json`).
   Full suite: `node neurons/test-trace-miner.mjs`.
6. Neurons: `NEUROLINK_CLAUDE_CMD="$PWD/neurons/llm-hermes.sh" node neurons/run-neuron.mjs pattern`
   (use an absolute path — the model call runs from `/tmp`). `trace-miner.mjs --dry` prints the inputs
   line, runs the model call, computes the drop step and prints `dry: would write N proposal(s), dropped M`
   or `dry: would skip (<reason>)`; it writes no proposal file, no status file and no receipt.
   `reviewRoots` may be `~/Documents/ChatGPT`; `loopLedgerMaxAgeDays` defaults to 21.

## Scheduling (macOS launchd)

All plists are private except the one tracked template: `ops/launchd/com.brandon.neurolink-trace-miner.plist`.
Every other launchd definition under `ops/launchd/` (including the stale `com.neurolink.trace-miner`) stays
private and is never committed. Put a copy of the plists you use in `~/Library/LaunchAgents/`
(`health.mjs` checks they are all loaded). Installing or retiring a LaunchAgent is a human step, not a
build step.

| Label | Runs | When |
|---|---|---|
| `com.neurolink.ragserver` | `node rag-server.mjs` | `RunAtLoad` + `KeepAlive` |
| `com.neurolink.refresh` | `node refresh.mjs` | `StartInterval` 3600 |
| `com.neurolink.neuron` | `node neurons/run-neuron.mjs reflect` | `QueueDirectories` = your `reflectQueue` (keep it outside `~/Desktop`: launchd cannot watch there) |
| `com.neurolink.selftest` | `node neurons/run-neuron.mjs selftest` | daily |
| `com.brandon.neurolink-trace-miner` | `node neurons/trace-miner.mjs` | daily 09:00 |
| `com.neurolink.health` | `node health.mjs` | `StartInterval` 21600 |

The tracked template hard-codes the Studio's paths on purpose; edit them for another machine. It uses
`/Users/brandon/.local/node/bin/node`, `WorkingDirectory` `/Users/brandon/.neurolink/repo/engine`,
`StartCalendarInterval` 09:00, `RunAtLoad` false, and logs to
`/Users/brandon/Library/Logs/neurolink-trace-miner.log`. Set `NEUROLINK_CLAUDE_CMD` in the neuron and
trace-miner plists to the wrapper you use. On the Studio, give `/Users/brandon/.local/node/bin/node`
Full Disk Access if the vault or reviews are under `~/Documents`; the grant is tied to the node binary and
may need renewing after a node upgrade. A status of `unreadable (EPERM)` under launchd can indicate that
node lacks Full Disk Access for `~/Documents`.

Studio install (human step, after the rollout gates below): copy the tracked plist to
`~/Library/LaunchAgents/`, then `launchctl bootstrap gui/$(id -u) <path>`, test with
`launchctl kickstart gui/$(id -u)/com.brandon.neurolink-trace-miner`, and check with
`launchctl print gui/$(id -u)/com.brandon.neurolink-trace-miner`. This runs the job under launchd, so it
tests launchd's permissions, not the terminal's.

## Privacy rules

- Never commit `neurolink.config.json`, the index (`rag-index*.json`), `vault-data.js`, logs, or anything under your vault.
- `privateNamePattern` keeps matching notes out of the index, the brain map and every neuron prompt.
  An empty pattern means no name filter at all. For the trace-miner's review scan, a match SKIPS THE
  WHOLE FILE (folder name, file name or text) — it does not redact the text.
- `/chat` and the reranker send vault text to a model; `listenHosts` must never include `0.0.0.0`.

## Trace-miner: inputs and visibility

Every run prints one `inputs:` line before the model call, e.g.
`inputs: errors.log: ok (12 clusters) · reviews /Users/brandon/Documents/ChatGPT: ok (3, 1 ignored) · reviews /nonexistent: missing /nonexistent · loop ledger: not configured · prior proposals: ok (14)`.
Each input reports one status. `ok (0)`, `none yet`, `not configured`, and an `ok` string with only
ignored / excluded / clean-PASS / older-than-limit counts are intentional. The statuses that mean the
miner **could not see** something (attention statuses) are `missing`, `unreadable`, `stale`, any `ok`
string with a nonzero `U unreadable` count, a review root whose candidate files all failed to parse
(`ok (0, N ignored)`), and an unreadable prior-proposals folder (`unreadable (<code>)`). Real error
codes are reported unchanged (`EPERM` stays `EPERM`).

When an outcome is `skipped` or `failed` and at least one input has an attention status, the miner writes
`<OUT_DIR>/<TODAY>-trace-miner-status.md` (the same proposals folder, and the run log). Its name never
matches a proposal file, so it is never read as history. Brandon finds it in the proposals folder and
the run log — the miner does not push it to him. A later `wrote` run leaves an earlier status file in
place as a historical record; its first line names the outcome it recorded. The status-file write is
caught (one stderr note, the receipt is still written, the exit code is unchanged); a proposal-file
write failure stays uncaught (non-zero exit, no receipt), as before.

`health.mjs:238` counts every `skipped` outcome as success; the miner does not change that. The status
file and the receipt `inputs` are the way to see the cause of a skip.

The ledger-shape caveat: timestamp shapes (`ts` as a number or an ISO-8601 string with a `%z` offset,
`time` as a number or ISO string, `run` as `YYYYMMDD-HHMMSS` local) were taken from
`tea-time-hub/scripts/loop.sh:159-166` and have not yet been confirmed against a real ledger file. File
mtime is never used; a row with no usable timestamp is dropped and reported. Loop rows older than
`loopLedgerMaxAgeDays` (default 21) are dropped individually.

## Trace-miner: receipt keys and caps

Receipts on `wrote`, `skipped` and `failed` carry four keys: `inputs`, `dropped`, `near`, `truncated`.
`inputs` is `{ hermes, reviews: [{root, status}], loop, prior }`; `dropped` records each discarded
repeat with its matched title, relation (`recent`/`decided`) and days; `near` records close-but-kept
titles (Jaccard 0.4 to 0.6); `truncated` lists every cap that cut something.

Caps recorded in `truncated` (exact labels): `review block 24000`, `reviews per job 2`, `reviews 20`,
`review folders 200`, `prior titles 60`. Caps that discard data but are NOT recorded in `truncated`
(documented here): 12 findings per file, 300 characters per finding, 200 parsed proposals, 10 `near`
entries, 5 banner titles, the 200-row ledger window, 15 loop clusters, the 200,000-byte review-file
limit, and the 120-character title cap. The 200-proposal cap can shorten the drop-rule history.

Every model-supplied string written to the proposal file, status file or receipt is flattened to a
single line (CR/LF/U+2028/U+2029 runs become one space, spaces collapsed, a leading `#` or
triple-backtick run escaped), so a title cannot forge a `## N.` heading or a ticked state line. Older
proposal files without that flattening can still contain a forged heading; that exposure ends when
they age out of the 30-day history.

## What the trace-miner sends to the model (D1)

The review text is sent through the existing wrapper (`llm-hermes.sh` -> `hermes chat`, provider
`openai-codex`, model `gpt-6-luna-900k` by default) — an outside model. Per review item the miner sends
the job-folder name, the normalized verdict, and up to 12 findings of at most 300 characters each,
inside a review block capped at 24,000 characters (plus the prior-proposals block of at most 60 lines).
Review text is not screened beyond the private-name filter, which SKIPS THE WHOLE FILE on a match
(it does not redact). Titles are capped at 120 characters. Sending review text is the **proposed
option, not active until Brandon records D1**; the example config ships no review root so a fresh
checkout sends none. The model child is limited to `-t clarify`, `--max-turns 3`, `--ignore-rules`;
whether that removes every tool, including MCP tools, is not verified. Which host runs the daily job is
unconfirmed; one runner only.

## Rollout gates (outside the build; owner: Brandon)

Use ONE order:
1. Merge the reviewed PR after the decisions below are recorded.
2. Reconcile the live checkout (`/Users/brandon/.neurolink/repo`) keeping its local edits; abort to
   the backup if `--selftest` fails afterwards.
3. Config edits — recorded D1 and D3. REPLACE the dead `reviewRoots` entry
   (`/Users/brandon/Documents/GitHub/tea-time-hub-v2/.jobs`, confirmed nonexistent) with
   `/Users/brandon/Documents/ChatGPT`; do not add it alongside the dead one (a lingering `missing`
   root would write a status file on every skip). Set `loopLedger` to a path that exists, or leave it
   empty.
4. The runner is identified (D4): make exactly one host the 09:00 runner.
5. If Brandon grants Full Disk Access (D2 = grant): install the plist, kickstart-test, read the log.
   If D2 = no grant: do NOT install; run the miner manually and read the status file instead.

Open decisions (Brandon): D1 send review text; D2 Full Disk Access for the node binary; D3 drop repeats
at >= 0.6 even if evidence grew; D4 which host runs the daily job. Defaults (no data sent, nothing
installed) apply only until he answers. A week after the first scheduled run, the coordinator reports
as an **observation** (no pass/fail threshold): the share of reply titles dropped, the `near` count,
and any dropped title that looks clearly different from its match.
