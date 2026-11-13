#!/bin/bash
# llm-hermes.sh — drop-in stand-in for `claude -p "<prompt>"` that reasons through Hermes,
# so the Neurolink workers use whatever provider/model/credits the owner manages in Hermes.
# The neurons call it as: $NEUROLINK_CLAUDE_CMD -p "<prompt>"  → final message on stdout.
# Route: openai-codex / GPT-6 Luna by default. A provider whose login lapses fails every call (seen 2026-09-22..28
#   on a Nous route), so check `hermes model` if all neuron runs start failing.
#   NEUROLINK_HERMES_PROVIDER  default openai-codex (set empty to omit --provider and let --safe-mode resolve auto)
#   NEUROLINK_HERMES_MODEL     default gpt-6-luna-900k (must be non-empty; empty fails closed with exit 2)
#   NEUROLINK_HERMES_TIMEOUT   default 150 (positive integer wall-clock seconds; invalid fails closed with exit 2)
# ponytail: one CLI, isolated headless one-shot (--safe-mode -t context_engine): zero tools, no plugins/MCP, no SOUL/rules/memory.
set -euo pipefail
[ "${1:-}" = "-p" ] && shift
prompt="${1:-}"
[ -n "$prompt" ] || { echo "usage: $0 -p <prompt>" >&2; exit 2; }
log="${NEUROLINK_HERMES_LOG:-$HOME/Library/Logs/llm-hermes.log}"
note() { printf '%s llm-hermes: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$log"; }
provider="${NEUROLINK_HERMES_PROVIDER-openai-codex}"
model="${NEUROLINK_HERMES_MODEL-gpt-6-luna-900k}"
case "$model" in
  *[![:space:]]*) ;;
  *)
    note "provider=${provider:-default} model=<empty>"
    note "FAILED rc=2 after 0s; a model must be named (NEUROLINK_HERMES_MODEL is empty)"
    echo "llm-hermes: a model must be named (NEUROLINK_HERMES_MODEL cannot be empty)" >&2
    exit 2
    ;;
esac
timeout_s="${NEUROLINK_HERMES_TIMEOUT-150}"
case "$timeout_s" in
  ''|*[!0123456789]*) valid_timeout=0 ;;
  *[123456789]*) [ "$timeout_s" -gt 0 ] 2>/dev/null && valid_timeout=1 || valid_timeout=0 ;;
  *) valid_timeout=0 ;;
esac
if [ "$valid_timeout" -ne 1 ]; then
  safe_timeout="${timeout_s//$'\n'/ }"
  note "provider=${provider:-default} model=$model"
  note "FAILED rc=2 after 0s; invalid NEUROLINK_HERMES_TIMEOUT=${safe_timeout:-<empty>} (must be positive integer seconds)"
  echo "llm-hermes: invalid NEUROLINK_HERMES_TIMEOUT '${safe_timeout}' (must be positive integer seconds)" >&2
  exit 2
fi
timeout_s=$((10#$timeout_s))
in=""
out=""
self_pid="$$"
parent_pid="$PPID"
child_pid=""
watchdog_pid=""
timed_out=0
started_log=0
ended_log=0
rc=0
start=$SECONDS

stop_watchdog() {
  local wpids=""
  if [ -n "$watchdog_pid" ]; then
    wpids="$(/usr/bin/pgrep -P "$watchdog_pid" 2>/dev/null || true)"
    builtin kill -TERM "$watchdog_pid" ${wpids:+$wpids} 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
    watchdog_pid=""
  fi
}

is_protected_pid() {
  case "${1:-}" in
    ''|*[!0123456789]*|0|1|"$self_pid"|"$parent_pid"|"$watchdog_pid") return 0 ;;
  esac
  return 1
}

walk_descendants() {
  local queue="$*" p="" q="" children=""
  new_pids=""
  while [ -n "$queue" ]; do
    set -- $queue
    p="$1"
    shift
    queue="$*"
    if is_protected_pid "$p"; then
      continue
    fi
    case "$recorded" in
      *" $p "*) ;;
      *)
        recorded="$recorded$p "
        new_pids="${new_pids:+$new_pids }$p"
        ;;
    esac
    children="$(/usr/bin/pgrep -P "$p" 2>/dev/null || true)"
    for q in $children; do
      if is_protected_pid "$q"; then
        continue
      fi
      case "$recorded" in
        *" $q "*) ;;
        *)
          recorded="$recorded$q "
          new_pids="${new_pids:+$new_pids }$q"
          queue="${queue:+$queue }$q"
          ;;
      esac
    done
  done
}

collect_alive_recorded() {
  local p=""
  alive=""
  for p in $recorded; do
    if is_protected_pid "$p"; then
      continue
    fi
    if builtin kill -0 "$p" 2>/dev/null; then
      alive="${alive:+$alive }$p"
    fi
  done
}

signal_recorded_pids() {
  local sig="$1" p=""
  shift
  for p in "$@"; do
    if is_protected_pid "$p"; then
      continue
    fi
    case "$recorded" in
      *" $p "*) builtin kill -"$sig" "$p" 2>/dev/null || true ;;
    esac
  done
}

# Stop only verified descendants of child_pid found by breadth-first parent-link
# walks (/usr/bin/pgrep -P). Known limit: a process that had already detached
# from the tree before the snapshot (double-forked and reparented to launchd)
# cannot be found by parent links and is not stopped.
stop_hermes_tree() {
  if [ -z "$child_pid" ] || is_protected_pid "$child_pid"; then
    return 0
  fi
  local recorded=" " new_pids="" alive="" prev_alive="" i=""

  # 1. Snapshot before any signal: breadth-first walk from child_pid.
  walk_descendants "$child_pid"

  # 2. Send TERM to every recorded PID.
  signal_recorded_pids TERM $recorded

  # 3. Short grace period (< 1s total): re-walk from alive recorded PIDs, add
  # any new descendants to the recorded set, and send them TERM too.
  for i in 1 2 3 4; do
    collect_alive_recorded
    if [ -z "$alive" ]; then
      return 0
    fi
    /bin/sleep 0.1
    collect_alive_recorded
    if [ -z "$alive" ]; then
      return 0
    fi
    walk_descendants $alive
    if [ -n "$new_pids" ]; then
      signal_recorded_pids TERM $new_pids
    fi
  done

  # 4. Send KILL to every recorded PID still alive, then one more re-walk and
  # KILL of anything new.
  collect_alive_recorded
  if [ -n "$alive" ]; then
    prev_alive="$alive"
    signal_recorded_pids KILL $alive
    walk_descendants $prev_alive
    if [ -n "$new_pids" ]; then
      signal_recorded_pids KILL $new_pids
    fi
  fi
  return 0
}

cleanup() {
  stop_watchdog
  [ -n "$child_pid" ] && stop_hermes_tree || true
  rm -f ${in:+"$in"} ${out:+"$out"}
}

on_signal() {
  local sig="$1" code="$2"
  trap '' TERM INT HUP ALRM
  {
    stop_watchdog
    [ -n "$child_pid" ] && stop_hermes_tree || true
    [ -n "$child_pid" ] && wait "$child_pid" || true
    child_pid=""
  } 2>/dev/null
  if [ "$started_log" -eq 1 ] && [ "$ended_log" -eq 0 ]; then
    ended_log=1
    secs=$((SECONDS - start))
    note "FAILED interrupted ($sig) after ${secs}s"
  fi
  exit "$code"
}

# Stop contract (timeout and signals). The SUPPORTED stop paths are a TIMEOUT
# and a SIGTERM sent to this wrapper: both snapshot the descendant tree first
# and then stop it. SIGINT and SIGHUP are best effort: they stop the tree only
# when the launcher left them catchable. If the launcher started this wrapper
# with SIGINT or SIGHUP ignored (for example nohup, or some background
# launches), non-interactive Bash inherits the ignore and cannot install a trap
# for that signal; on that signal the wrapper does not stop Hermes or its
# descendants. This is a limit of Bash, not fixed here. The known limit above
# stop_hermes_tree (a process detached before the snapshot is not found) still
# applies and is unchanged.
trap cleanup EXIT
trap 'timed_out=1' ALRM
trap 'on_signal TERM 143' TERM
trap 'on_signal INT 130' INT
trap 'on_signal HUP 129' HUP

in="$(mktemp -t llm-hermes-in)"; out="$(mktemp -t llm-hermes-out)"
export AGENT_WORKFLOW_SKIP=1              # keep the workflow checkpoint hook out of a headless model call
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN   # a Claude Code shell's overrides break Hermes's own auth
printf '%s' "$prompt" > "$in"
# --safe-mode: runs out-of-process with user config, plugins (prompt sections + plugin toolsets), MCP servers,
#   AGENTS.md/SOUL.md, memory, and skills index all disabled; requires an explicit -m model and rejects --run-budget
#   (gateway_chat.py _UNSUPPORTED).
# -t context_engine: explicit built-in configurable toolset with static tools=[] (avoids -t clarify merging plugin/MCP
#   toolsets on non-safe runs and avoids -t "" auto-enabling x_search via _composite_toolsets when xAI creds exist).
# --max-turns 3: zero tools exist, so normal completions take 1 API call; keeps headroom for a Codex reasoning_only continuation.
# --source tool: documented tag for third-party integrations (kept out of user session lists).
args=(chat --query-file "$in" --oneshot -Q --safe-mode -t context_engine --max-turns 3 --source tool)
case "$provider" in *[![:space:]]*) args+=(--provider "$provider") ;; esac
args+=(-m "$model")

# Every call logs a start line, then exactly one ok / FAILED / EMPTY line.
start=$SECONDS
note "provider=${provider:-default} model=$model"
started_log=1
{
  "${NEUROLINK_HERMES_BIN:-$HOME/.local/bin/hermes}" "${args[@]}" >"$out" 2>>"$log" </dev/null &
  child_pid=$!
  (
    trap 'pids="$(jobs -p)"; [ -n "$pids" ] && builtin kill -TERM $pids 2>/dev/null || true; exit 0' TERM INT HUP
    /bin/sleep "$timeout_s" >/dev/null 2>&1 </dev/null &
    wait $! 2>/dev/null || exit 0
    while builtin kill -ALRM "$self_pid" 2>/dev/null; do
      /bin/sleep 0.1 >/dev/null 2>&1 </dev/null &
      wait $! 2>/dev/null || exit 0
    done
  ) >/dev/null 2>&1 </dev/null &
  watchdog_pid=$!
  if [ "$timed_out" -eq 0 ]; then
    wait "$child_pid" || rc=$?
    if [ "$timed_out" -eq 0 ]; then
      child_pid=""
    fi
  fi
  trap '' ALRM
  stop_watchdog
  if [ "$timed_out" -eq 1 ]; then
    stop_hermes_tree
    if [ -n "$child_pid" ]; then
      wait "$child_pid" || true
    fi
  fi
  child_pid=""
} 2>/dev/null
secs=$((SECONDS - start))
if [ "$timed_out" -eq 1 ]; then
  ended_log=1
  note "FAILED timed out after ${secs}s (limit ${timeout_s}s); last 2000 bytes of Hermes's reply follow"
  { tail -c 2000 "$out"; echo; } >>"$log"
  echo "llm-hermes: hermes chat timed out after ${secs}s (limit ${timeout_s}s; see $log)" >&2; exit 1
fi
if [ "$rc" -ne 0 ]; then
  ended_log=1
  note "FAILED rc=$rc after ${secs}s; last 2000 bytes of Hermes's reply follow"   # keep Hermes's own reply as the failure reason
  { tail -c 2000 "$out"; echo; } >>"$log"   # echo: a reply with no trailing newline must not glue onto the next log line
  echo "llm-hermes: hermes chat failed rc=$rc after ${secs}s (see $log)" >&2; exit 1
fi
LC_ALL=C grep -q '[^[:space:]]' "$out" || { ended_log=1; note "EMPTY reply (rc=0) after ${secs}s"; echo "llm-hermes: empty reply after ${secs}s (see $log)" >&2; exit 1; }
ended_log=1
note "ok ${secs}s"
cat "$out"
