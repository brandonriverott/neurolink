#!/bin/bash
# llm-luna.sh — drop-in stand-in for `claude -p "<prompt>"` that reasons on Luna
# (gpt-5.6-luna) through the Codex CLI's ChatGPT login. No API key, no Claude login.
# The neurons call it as: $NEUROLINK_CLAUDE_CMD -p "<prompt>"  → final message on stdout.
# ponytail: one model, one flag set; add a provider switch only if a second backend is needed.
set -euo pipefail
[ "${1:-}" = "-p" ] && shift
prompt="${1:-}"
[ -n "$prompt" ] || { echo "usage: $0 -p <prompt>" >&2; exit 2; }
out="$(mktemp -t llm-luna-out)"
log="${NEUROLINK_LUNA_LOG:-$HOME/Library/Logs/llm-luna.log}"
trap 'rm -f "$out"' EXIT
export AGENT_WORKFLOW_SKIP=1   # keep the workflow checkpoint hook out of a headless model call
printf '%s' "$prompt" | codex exec -m "${NEUROLINK_LUNA_MODEL:-gpt-5.6-luna}" -s read-only --skip-git-repo-check -C /tmp --color never -o "$out" - >>"$log" 2>&1 \
  || { echo "llm-luna: codex exec failed (see $log)" >&2; exit 1; }
[ -s "$out" ] || { echo "llm-luna: empty reply (see $log)" >&2; exit 1; }
cat "$out"
