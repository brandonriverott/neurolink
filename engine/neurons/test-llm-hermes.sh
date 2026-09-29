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

fake 'printf "max_iterations_reached"; echo "provider blew up" >&2; exit 3'   # reply has no trailing newline on purpose
failed_call failure
grep -q 'rc=3' "$tmp/err" || fail "stderr lacks the exit code"
grep -Eq 'llm-hermes: FAILED rc=3 after [0-9]+s' "$NEUROLINK_HERMES_LOG" || fail "log lacks 'FAILED rc=3 after <n>s'"
grep -q 'provider blew up' "$NEUROLINK_HERMES_LOG" || fail "log lacks Hermes's stderr"
one_start_one_end failure
"$here/llm-hermes.sh" -p hi >/dev/null 2>&1   # a second failure: the first reply must not run into its start line
[ "$(grep -c '^max_iterations_reached$' "$NEUROLINK_HERMES_LOG")" = 2 ] || fail "Hermes's reply glued onto another log line"

fake 'exit 0'
failed_call empty
grep -Eq 'llm-hermes: EMPTY reply \(rc=0\) after [0-9]+s' "$NEUROLINK_HERMES_LOG" || fail "empty reply not logged with duration"
one_start_one_end empty

echo "PASS: llm-hermes.sh logging"
