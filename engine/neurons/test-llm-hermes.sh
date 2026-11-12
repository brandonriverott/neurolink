#!/bin/bash
# test-llm-hermes.sh — checks llm-hermes.sh with a fake `hermes`; never calls a real model.
# Run: bash neurons/test-llm-hermes.sh   (exits non-zero on the first broken invariant)
# Proves, per call: exactly one start line and one ok / FAILED / EMPTY line, each with the duration; a failure exits
# exactly 1 with a stderr message that starts "llm-hermes:" and carries the rc and seconds, and Hermes's reply and
# stderr land in the log; success prints the reply.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export NEUROLINK_HERMES_LOG="$tmp/log" NEUROLINK_HERMES_BIN="$tmp/fake-hermes"
fail() { echo "FAIL: $*" >&2; exit 1; }
fake() { printf '#!/bin/bash\n%s\n' "$1" >"$NEUROLINK_HERMES_BIN"; chmod +x "$NEUROLINK_HERMES_BIN"; : >"$NEUROLINK_HERMES_LOG"; }
count() { grep -Ec "$1" "$NEUROLINK_HERMES_LOG"; }
one_start_one_end() { [ "$(count 'llm-hermes: provider=')" = 1 ] || fail "$1: want exactly one start line"
  [ "$(count 'llm-hermes: (ok|FAILED|EMPTY)')" = 1 ] || fail "$1: want exactly one ok/FAILED/EMPTY line"; }
failed_call() { "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err"; [ $? = 1 ] || fail "$1: want exit code exactly 1"
  [ "$(head -c 11 "$tmp/err")" = "llm-hermes:" ] || fail "$1: stderr must start 'llm-hermes:'"
  grep -Eq 'after [0-9]+s' "$tmp/err" || fail "$1: stderr lacks the duration"; }

fake 'echo "all good"'
out="$("$here/llm-hermes.sh" -p hi 2>"$tmp/err")" || fail "success case exited non-zero"
[ "$out" = "all good" ] || fail "success case printed '$out'"
grep -Eq 'llm-hermes: ok [0-9]+s$' "$NEUROLINK_HERMES_LOG" || fail "success not logged as 'ok <n>s'"
one_start_one_end success

# T1 — assert the built args contain the documented --source tool tag and isolated zero-tool flags.
# The fake Hermes captures the exact args it was invoked with ("$@") to a file and enforces
# gateway_chat.py's --safe-mode contract (--run-budget is unsupported; -m is required).
export TEST_ARGS_FILE="$tmp/args"
fake 'printf "%s " "$@" >"$TEST_ARGS_FILE"; echo >>"$TEST_ARGS_FILE"
case " $* " in *" --safe-mode "*)
  case " $* " in *" --run-budget "*) echo "Error: Unsupported gateway CLI options: --run-budget" >&2; exit 2;; esac
  case " $* " in *" -m "*|*" --model "*) ;; *) echo "Error: --safe-mode requires -m" >&2; exit 2;; esac
;; esac
echo "all good"'
"$here/llm-hermes.sh" -p hi >/dev/null 2>"$tmp/err" || fail "T1: tag-probe exited non-zero"
grep -Eq -- '(^| )--source tool( |$)' "$TEST_ARGS_FILE" || fail "T1: built args lack '--source tool'"
grep -Eq -- '(^| )--safe-mode( |$)' "$TEST_ARGS_FILE" || fail "T4: built args lack '--safe-mode'"
grep -Eq -- '(^| )-t context_engine( |$)' "$TEST_ARGS_FILE" || fail "T4: built args lack '-t context_engine'"
! grep -Eq -- '(^| )-t clarify( |$)' "$TEST_ARGS_FILE" || fail "T4: built args still pass '-t clarify'"
! grep -Eq -- '(^| )--run-budget( |$)' "$TEST_ARGS_FILE" || fail "T4: built args pass '--run-budget' under --safe-mode"

# T5 — explicit empty provider+model falls back from --safe-mode (which forbids reading config.yaml)
# to --ignore-rules -t context_engine,no_mcp so Hermes can read its configured /model without MCP/built-in tools.
NEUROLINK_HERMES_PROVIDER="" NEUROLINK_HERMES_MODEL="" "$here/llm-hermes.sh" -p hi >/dev/null 2>"$tmp/err" || fail "T5: empty-model fallback exited non-zero"
! grep -Eq -- '(^| )--safe-mode( |$)' "$TEST_ARGS_FILE" || fail "T5: empty-model fallback must not pass '--safe-mode'"
! grep -Eq -- '(^| )(-m|--provider)( |$)' "$TEST_ARGS_FILE" || fail "T5: empty-model fallback must omit -m/--provider"
grep -Eq -- '(^| )--ignore-rules( |$)' "$TEST_ARGS_FILE" || fail "T5: empty-model fallback lacks '--ignore-rules'"
grep -Eq -- '(^| )-t context_engine,no_mcp( |$)' "$TEST_ARGS_FILE" || fail "T5: empty-model fallback lacks '-t context_engine,no_mcp'"

fake 'printf "max_iterations_reached"; echo "provider blew up" >&2; exit 3'   # reply has no trailing newline on purpose
failed_call failure
# T3 — a failed call must not emit Hermes's reply to the caller: the caller's
# captured stdout file ($tmp/out, from this first failed_call) stays empty.
# A reply leaking to stdout on failure is exactly the round-4 mutant T3 closes.
[ ! -s "$tmp/out" ] || fail "T3: caller stdout not empty on failed call (reply leaked)"
grep -q 'rc=3' "$tmp/err" || fail "stderr lacks the exit code"
grep -Eq 'llm-hermes: FAILED rc=3 after [0-9]+s' "$NEUROLINK_HERMES_LOG" || fail "log lacks 'FAILED rc=3 after <n>s'"
grep -q 'provider blew up' "$NEUROLINK_HERMES_LOG" || fail "log lacks Hermes's stderr"
one_start_one_end failure
"$here/llm-hermes.sh" -p hi >/dev/null 2>&1   # a second failure: the first reply must not run into its start line
[ "$(grep -c '^max_iterations_reached$' "$NEUROLINK_HERMES_LOG")" = 2 ] || fail "Hermes's reply glued onto another log line"

# T2 — fake exits 1 with no stdout: wrapper exits 1, logs FAILED, records rc=1.
fake 'exit 1'
failed_call t2
grep -q 'rc=1' "$tmp/err" || fail "T2: stderr lacks the exit code rc=1"
grep -Eq 'llm-hermes: FAILED rc=1 after [0-9]+s' "$NEUROLINK_HERMES_LOG" || fail "T2: log lacks 'FAILED rc=1 after <n>s'"
one_start_one_end t2

fake 'exit 0'
failed_call empty
grep -Eq 'llm-hermes: EMPTY reply \(rc=0\) after [0-9]+s' "$NEUROLINK_HERMES_LOG" || fail "empty reply not logged with duration"
one_start_one_end empty

# T6 — whitespace/newline-only stdout on rc=0 (GatewayChatView prints "\n" when text is empty)
# must also be treated as EMPTY reply, exit 1, and emit nothing to caller stdout.
fake 'printf "\n  \t\n"'
failed_call whitespace_empty
[ ! -s "$tmp/out" ] || fail "T6: caller stdout not empty on whitespace-only reply"
grep -Eq 'llm-hermes: EMPTY reply \(rc=0\) after [0-9]+s' "$NEUROLINK_HERMES_LOG" || fail "T6: whitespace-only reply not logged as EMPTY"
one_start_one_end whitespace_empty

echo "PASS: llm-hermes.sh logging"
