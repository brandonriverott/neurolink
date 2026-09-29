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
| `neurons/llm-hermes.sh`, `neurons/llm-luna.sh` | Model wrappers the neurons call instead of `claude -p` |
| `config.mjs` | Loads your private settings |

## Setup

1. Node (tested on v24) and the one dependency: `npm install`
2. `cp neurolink.config.example.json neurolink.config.json` and fill in your values
   (vault path, your name, folder → brain-region rules, private names to exclude, log folder).
   `neurolink.config.json` is gitignored — keep it that way. Nothing starts without it, and a broken
   file stops the engine rather than running without your privacy filter.
3. Build the index: `node rag-index.mjs --full`
4. Start the server: `node rag-server.mjs`, then open `http://127.0.0.1:8920`
5. Health: `node health.mjs` · Trace-Miner self-check: `node neurons/trace-miner.mjs --selftest`
6. Neurons: `NEUROLINK_CLAUDE_CMD="$PWD/neurons/llm-hermes.sh" node neurons/run-neuron.mjs pattern`
   (use an absolute path — the model call runs from `/tmp`; `--dry` on trace-miner prints proposals and writes nothing)

## Scheduling (macOS launchd)

Put one plist per job in `~/Library/LaunchAgents/` (and a copy in `ops/launchd/` — `health.mjs` checks
they are all loaded). Your plists contain your paths; like everything not on the `.gitignore` allow-list,
they are never committed.

| Label | Runs | When |
|---|---|---|
| `com.neurolink.ragserver` | `node rag-server.mjs` | `RunAtLoad` + `KeepAlive` |
| `com.neurolink.refresh` | `node refresh.mjs` | `StartInterval` 3600 |
| `com.neurolink.neuron` | `node neurons/run-neuron.mjs reflect` | `QueueDirectories` = your `reflectQueue` (keep it outside `~/Desktop`: launchd cannot watch there) |
| `com.neurolink.selftest` | `node neurons/run-neuron.mjs selftest` | daily |
| `com.neurolink.trace-miner` | `node neurons/trace-miner.mjs` | daily |
| `com.neurolink.health` | `node health.mjs` | `StartInterval` 21600 |

Set `NEUROLINK_CLAUDE_CMD` in the neuron and trace-miner plists to the wrapper you use. Give `/usr/local/bin/node`
Full Disk Access if your vault is under `~/Desktop` or `~/Documents`.

## Privacy rules

- Never commit `neurolink.config.json`, the index (`rag-index*.json`), `vault-data.js`, logs, or anything under your vault.
- `privateNamePattern` keeps matching notes out of the index, the brain map and every neuron prompt.
- `/chat` and the reranker send vault text to a model; `listenHosts` must never include `0.0.0.0`.
