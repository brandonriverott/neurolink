#!/bin/bash
# llm-hermes.sh — drop-in stand-in for `claude -p "<prompt>"` that reasons through Hermes,
# so the Neurolink workers use whatever provider/model/credits the owner manages in Hermes.
# The neurons call it as: $NEUROLINK_CLAUDE_CMD -p "<prompt>"  → final message on stdout.
# Route: openai-codex / GPT-6 Luna by default. A provider whose login lapses fails every call (seen 2026-09-22..28
#   on a Nous route), so check `hermes model` if all neuron runs start failing.
#   NEUROLINK_HERMES_PROVIDER  default openai-codex      NEUROLINK_HERMES_MODEL  default gpt-6-luna-900k
#   (set BOTH NEUROLINK_HERMES_PROVIDER="" and NEUROLINK_HERMES_MODEL="" to follow Hermes's own current /model choice instead)
# ponytail: one CLI, one flag set; a headless one-shot with only the clarify tool (answered headlessly by Hermes) and no SOUL/rules injected.
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
# max-turns 3: the model sometimes calls the clarify tool first; with 1 turn that ended the run as
# max_iterations_reached and failed the neuron (seen 2026-09-29).
# run-budget 150: a wall-clock budget for the conversation run only (hermes chat --help), set below the neurons'
# 180s SIGKILL (run-neuron.mjs / trace-miner.mjs callClaude) to make a mid-run kill less likely. Not a hard cap on
# total wrapper time — Hermes startup/cleanup sit outside it — so the 180s kill can still happen on a slow machine.
args=(chat --query-file "$in" --oneshot -Q --ignore-rules -t clarify --max-turns 3 --run-budget 150 --source neurolink)
[ -n "$provider" ] && args+=(--provider "$provider")
[ -n "$model" ] && args+=(-m "$model")
printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "llm-hermes: provider=${provider:-default} model=${model:-default}" >>"$log"
"${NEUROLINK_HERMES_BIN:-$HOME/.local/bin/hermes}" "${args[@]}" >"$out" 2>>"$log" \
  || { tail -c 2000 "$out" >>"$log"; echo "llm-hermes: hermes chat failed (see $log)" >&2; exit 1; }   # keep Hermes's own reply as the failure reason
[ -s "$out" ] || { echo "llm-hermes: empty reply (see $log)" >&2; exit 1; }
cat "$out"
