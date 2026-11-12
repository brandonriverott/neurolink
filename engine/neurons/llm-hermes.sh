#!/bin/bash
# llm-hermes.sh — drop-in stand-in for `claude -p "<prompt>"` that reasons through Hermes,
# so the Neurolink workers use whatever provider/model/credits the owner manages in Hermes.
# The neurons call it as: $NEUROLINK_CLAUDE_CMD -p "<prompt>"  → final message on stdout.
# Route: openai-codex / GPT-6 Luna by default. A provider whose login lapses fails every call (seen 2026-09-22..28
#   on a Nous route), so check `hermes model` if all neuron runs start failing.
#   NEUROLINK_HERMES_PROVIDER  default openai-codex      NEUROLINK_HERMES_MODEL  default gpt-6-luna-900k
#   (set BOTH NEUROLINK_HERMES_PROVIDER="" and NEUROLINK_HERMES_MODEL="" to follow Hermes's own current /model choice instead;
#    that fallback uses --ignore-rules -t context_engine,no_mcp because --safe-mode refuses to read config.yaml)
# ponytail: one CLI, isolated headless one-shot (--safe-mode -t context_engine): zero tools, no plugins/MCP, no SOUL/rules/memory.
set -euo pipefail
[ "${1:-}" = "-p" ] && shift
prompt="${1:-}"
[ -n "$prompt" ] || { echo "usage: $0 -p <prompt>" >&2; exit 2; }
in="$(mktemp -t llm-hermes-in)"; out="$(mktemp -t llm-hermes-out)"
log="${NEUROLINK_HERMES_LOG:-$HOME/Library/Logs/llm-hermes.log}"
trap 'rm -f "$in" "$out"' EXIT
export AGENT_WORKFLOW_SKIP=1              # keep the workflow checkpoint hook out of a headless model call
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN   # a Claude Code shell's overrides break Hermes's own auth
printf '%s' "$prompt" > "$in"
provider="${NEUROLINK_HERMES_PROVIDER-openai-codex}"
model="${NEUROLINK_HERMES_MODEL-gpt-6-luna-900k}"
# --safe-mode: runs out-of-process with user config, plugins (prompt sections + plugin toolsets), MCP servers,
#   AGENTS.md/SOUL.md, memory, and skills index all disabled; requires an explicit -m model and rejects --run-budget
#   (gateway_chat.py _UNSUPPORTED; callers enforce 150s/180s SIGKILL timeouts externally).
# -t context_engine: explicit built-in configurable toolset with static tools=[] (avoids -t clarify merging plugin/MCP
#   toolsets on non-safe runs and avoids -t "" auto-enabling x_search via _composite_toolsets when xAI creds exist).
# --max-turns 3: zero tools exist, so normal completions take 1 API call; keeps headroom for a Codex reasoning_only continuation.
# --source tool: documented tag for third-party integrations (kept out of user session lists).
if [ -n "$model" ]; then
  args=(chat --query-file "$in" --oneshot -Q --safe-mode -t context_engine --max-turns 3 --source tool)
else
  args=(chat --query-file "$in" --oneshot -Q --ignore-rules -t context_engine,no_mcp --max-turns 3 --run-budget 150 --source tool)
fi
[ -n "$provider" ] && args+=(--provider "$provider")
[ -n "$model" ] && args+=(-m "$model")
note() { printf '%s llm-hermes: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$log"; }
# Every call logs a start line, then exactly one ok / FAILED / EMPTY line. A start line with none after it means the
# caller killed the run (the neurons' 180s SIGKILL cannot be trapped here).
note "provider=${provider:-default} model=${model:-default}"
rc=0; start=$SECONDS
"${NEUROLINK_HERMES_BIN:-$HOME/.local/bin/hermes}" "${args[@]}" >"$out" 2>>"$log" || rc=$?
secs=$((SECONDS - start))
if [ "$rc" -ne 0 ]; then
  note "FAILED rc=$rc after ${secs}s; last 2000 bytes of Hermes's reply follow"   # keep Hermes's own reply as the failure reason
  { tail -c 2000 "$out"; echo; } >>"$log"   # echo: a reply with no trailing newline must not glue onto the next log line
  echo "llm-hermes: hermes chat failed rc=$rc after ${secs}s (see $log)" >&2; exit 1
fi
LC_ALL=C grep -q '[^[:space:]]' "$out" || { note "EMPTY reply (rc=0) after ${secs}s"; echo "llm-hermes: empty reply after ${secs}s (see $log)" >&2; exit 1; }
note "ok ${secs}s"
cat "$out"
