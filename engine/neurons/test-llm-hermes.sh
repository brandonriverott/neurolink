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

# T5 (Test 1) — empty model fails closed before calling Hermes: exit 2, stub never invoked,
# one start line and one FAILED line in the log, one-line stderr reason naming model, empty stdout.
# Provider empty with model set stays allowed under --safe-mode (omitting --provider).
NEUROLINK_HERMES_PROVIDER="" "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err" || fail "T5: empty-provider with model set exited non-zero"
grep -Eq -- '(^| )--safe-mode( |$)' "$TEST_ARGS_FILE" || fail "T5: empty-provider call lacks '--safe-mode'"
grep -Eq -- '(^| )-t context_engine( |$)' "$TEST_ARGS_FILE" || fail "T5: empty-provider call lacks '-t context_engine'"
! grep -Eq -- '(^| )--provider( |$)' "$TEST_ARGS_FILE" || fail "T5: empty-provider call must omit '--provider'"
grep -Eq -- '(^| )-m gpt-6-luna-900k( |$)' "$TEST_ARGS_FILE" || fail "T5: empty-provider call lacks '-m gpt-6-luna-900k'"

rm -f "$tmp/t5-invoked"
fake "printf invoked >'$tmp/t5-invoked'; echo should-not-run"
for empty_case in model_only both whitespace; do
  : >"$NEUROLINK_HERMES_LOG"
  case "$empty_case" in
    model_only) NEUROLINK_HERMES_MODEL="" "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err"; rc=$? ;;
    both)       NEUROLINK_HERMES_PROVIDER="" NEUROLINK_HERMES_MODEL="" "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err"; rc=$? ;;
    whitespace) NEUROLINK_HERMES_MODEL="   " "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err"; rc=$? ;;
  esac
  [ "$rc" = 2 ] || fail "T5 ($empty_case): want exit 2, got $rc"
  [ ! -e "$tmp/t5-invoked" ] || fail "T5 ($empty_case): stub was invoked on empty model"
  [ ! -s "$tmp/out" ] || fail "T5 ($empty_case): caller stdout not empty"
  one_start_one_end "t5_$empty_case"
  grep -Eq 'llm-hermes: FAILED ' "$NEUROLINK_HERMES_LOG" || fail "T5 ($empty_case): log lacks FAILED line"
  [ "$(wc -l <"$tmp/err" | tr -d ' ')" = 1 ] || fail "T5 ($empty_case): want one-line stderr reason"
  [ "$(head -c 11 "$tmp/err")" = "llm-hermes:" ] || fail "T5 ($empty_case): stderr must start 'llm-hermes:'"
  grep -qi 'model' "$tmp/err" || fail "T5 ($empty_case): stderr must say a model must be named"
done

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

# T7 (Test 2) — wall-clock timeout: stub sleeps longer than a 2-second NEUROLINK_HERMES_TIMEOUT;
# wrapper exits 1 within a few seconds, logs the timeout FAILED line with duration, prints one-line
# timeout stderr reason, and writes nothing to stdout.
fake '/bin/sleep 5; echo "late reply"'
t0=$SECONDS
NEUROLINK_HERMES_TIMEOUT=2 "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err"
rc=$?
elapsed=$((SECONDS - t0))
[ "$rc" = 1 ] || fail "T7: want exit 1 on timeout, got $rc"
[ "$elapsed" -lt 5 ] || fail "T7: wrapper did not enforce 2s timeout (elapsed ${elapsed}s)"
[ ! -s "$tmp/out" ] || fail "T7: caller stdout not empty on timeout"
one_start_one_end timeout
grep -Eq 'llm-hermes: FAILED .*timed out after [0-9]+s' "$NEUROLINK_HERMES_LOG" || fail "T7: log lacks timeout FAILED line with duration"
[ "$(wc -l <"$tmp/err" | tr -d ' ')" = 1 ] || fail "T7: want one-line stderr reason on timeout"
[ "$(head -c 11 "$tmp/err")" = "llm-hermes:" ] || fail "T7: stderr must start 'llm-hermes:'"
grep -Eq 'timed out after [0-9]+s' "$tmp/err" || fail "T7: stderr lacks 'timed out after <n>s'"

# T8 (Test 3) — descendant cleanup on timeout AND when wrapper itself receives TERM or INT:
# stub spawns a background child and a SIGTERM-ignoring grandchild (whose intermediate parent
# dies on TERM) that would write marker files after the 1s timeout; after wrapper returns and
# a short wait, no marker exists.
marker_child="$tmp/descendant-child"
marker_grandchild="$tmp/descendant-grandchild"
rm -f "$marker_child" "$marker_grandchild"
fake "( /bin/sleep 2; printf leaked >'$marker_child' ) &
/bin/sh -c \"( trap '' TERM; /bin/sleep 2; printf leaked >'$marker_grandchild' ) & /bin/sleep 10\" &
/bin/sleep 10"
NEUROLINK_HERMES_TIMEOUT=1 "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err"
rc=$?
[ "$rc" = 1 ] || fail "T8: want exit 1 on timeout with descendants, got $rc"
[ ! -s "$tmp/out" ] || fail "T8: caller stdout not empty on descendant timeout"
one_start_one_end descendant_timeout
/bin/sleep 2
[ ! -e "$marker_child" ] || fail "T8: direct child survived timeout and wrote marker file"
[ ! -e "$marker_grandchild" ] || fail "T8: reparented grandchild survived timeout and wrote marker file"

for sig in TERM INT; do
  sig_marker="$tmp/sig-descendant-$sig"
  sig_ready="$tmp/sig-ready-$sig"
  sig_pidfile="$tmp/sig-hermes-pid-$sig"
  rm -f "$sig_marker" "$sig_ready" "$sig_pidfile"
  fake "printf '%s\n' \"\$\$\" >'$sig_pidfile'
( trap '' TERM; /bin/sleep 2; printf leaked >'$sig_marker' ) &
printf ready >'$sig_ready'
/bin/sleep 10"
  sig_t0=$SECONDS
  {
    set -m
    NEUROLINK_HERMES_TIMEOUT=30 "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err" &
    wpid=$!
    set +m
  } 2>/dev/null
  for _ in $(seq 1 40); do [ -e "$sig_ready" ] && break; /bin/sleep 0.05; done
  [ -e "$sig_ready" ] || { builtin kill -KILL "$wpid" 2>/dev/null; fail "T8 ($sig): stub never became ready"; }
  builtin kill -"$sig" "$wpid" 2>/dev/null || fail "T8 ($sig): failed to signal wrapper"
  wait "$wpid" 2>/dev/null; wrc=$?
  sig_elapsed=$((SECONDS - sig_t0))
  [ "$wrc" != 0 ] || fail "T8 ($sig): wrapper exited 0 when killed with $sig"
  [ "$sig_elapsed" -lt 5 ] || fail "T8 ($sig): wrapper did not stop promptly on $sig (${sig_elapsed}s)"
  [ ! -s "$tmp/out" ] || fail "T8 ($sig): caller stdout not empty when killed with $sig"
  one_start_one_end "sig_$sig"
  grep -Eq "llm-hermes: FAILED interrupted \($sig\) after [0-9]+s" "$NEUROLINK_HERMES_LOG" || fail "T8 ($sig): log lacks interrupted FAILED line"
  ! builtin kill -0 "$(cat "$sig_pidfile")" 2>/dev/null || fail "T8 ($sig): Hermes still running after wrapper received $sig"
  /bin/sleep 2
  [ ! -e "$sig_marker" ] || fail "T8 ($sig): Hermes descendant survived after wrapper received $sig"
done

# T9 (Test 4) — invalid NEUROLINK_HERMES_TIMEOUT (0, abc, empty string set explicitly, negative, float):
# rejected before Hermes is called with exit 2, stub never invoked, stdout empty.
rm -f "$tmp/t9-invoked"
fake "printf invoked >'$tmp/t9-invoked'; echo should-not-run"
for bad_timeout in "0" "00" "abc" "" "-5" "1.5"; do
  : >"$NEUROLINK_HERMES_LOG"
  NEUROLINK_HERMES_TIMEOUT="$bad_timeout" "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err"
  rc=$?
  [ "$rc" = 2 ] || fail "T9 ('$bad_timeout'): want exit 2, got $rc"
  [ ! -e "$tmp/t9-invoked" ] || fail "T9 ('$bad_timeout'): stub was invoked on invalid timeout"
  [ ! -s "$tmp/out" ] || fail "T9 ('$bad_timeout'): caller stdout not empty"
  one_start_one_end "t9_$bad_timeout"
  grep -Eq 'llm-hermes: FAILED ' "$NEUROLINK_HERMES_LOG" || fail "T9 ('$bad_timeout'): log lacks FAILED line"
  [ "$(wc -l <"$tmp/err" | tr -d ' ')" = 1 ] || fail "T9 ('$bad_timeout'): want one-line stderr reason"
  [ "$(head -c 11 "$tmp/err")" = "llm-hermes:" ] || fail "T9 ('$bad_timeout'): stderr must start 'llm-hermes:'"
done

# Regression guard, not a red-first test (Finding C, coordinator decision).
# T10 (Test 5) — a normal fast call still passes with the timeout machinery active (both default
# 150s and explicit NEUROLINK_HERMES_TIMEOUT=5), returns promptly without leaking stderr, and
# builds isolated zero-tool args (--safe-mode, -t context_engine, --source tool; no --run-budget or -t clarify).
rm -f "$TEST_ARGS_FILE"
fake 'printf "%s " "$@" >"$TEST_ARGS_FILE"; echo >>"$TEST_ARGS_FILE"
case " $* " in *" --safe-mode "*)
  case " $* " in *" --run-budget "*) echo "Error: Unsupported gateway CLI options: --run-budget" >&2; exit 2;; esac
  case " $* " in *" -m "*|*" --model "*) ;; *) echo "Error: --safe-mode requires -m" >&2; exit 2;; esac
;; esac
echo "fast ok"'
fast_t0=$SECONDS
fast_out="$(NEUROLINK_HERMES_TIMEOUT=5 "$here/llm-hermes.sh" -p hi 2>"$tmp/err")" || fail "T10: fast call with timeout machinery exited non-zero"
fast_elapsed=$((SECONDS - fast_t0))
[ "$fast_out" = "fast ok" ] || fail "T10: fast call printed '$fast_out'"
[ "$fast_elapsed" -lt 3 ] || fail "T10: fast call waited for timeout (${fast_elapsed}s)"
[ ! -s "$tmp/err" ] || fail "T10: fast call leaked stderr '$(cat "$tmp/err")'"
one_start_one_end fast_with_timeout
grep -Eq 'llm-hermes: ok [0-9]+s$' "$NEUROLINK_HERMES_LOG" || fail "T10: fast call not logged as 'ok <n>s'"
grep -Eq -- '(^| )--safe-mode( |$)' "$TEST_ARGS_FILE" || fail "T10: built args lack '--safe-mode'"
grep -Eq -- '(^| )-t context_engine( |$)' "$TEST_ARGS_FILE" || fail "T10: built args lack '-t context_engine'"
grep -Eq -- '(^| )--source tool( |$)' "$TEST_ARGS_FILE" || fail "T10: built args lack '--source tool'"
! grep -Eq -- '(^| )--run-budget( |$)' "$TEST_ARGS_FILE" || fail "T10: built args contain '--run-budget'"
! grep -Eq -- '(^| )-t clarify( |$)' "$TEST_ARGS_FILE" || fail "T10: built args contain '-t clarify'"

# T11 (Finding A) — sibling survives: start the wrapper as a process-group leader with a 1s
# timeout and a stub that sleeps; start an unrelated sleep in the same process group; after the
# wrapper times out the unrelated sleep is still alive, then clean it up.
t11_ready="$tmp/t11-ready"
rm -f "$t11_ready" "$tmp/out" "$tmp/err"
fake "printf ready >'$t11_ready'
/bin/sleep 10"
/usr/bin/python3 - "$here/llm-hermes.sh" "$t11_ready" "$tmp/out" "$tmp/err" <<'PY' || fail "T11: unrelated sibling in wrapper process group did not survive timeout"
import os, subprocess, sys, time

wrapper, ready_path, out_path, err_path = sys.argv[1:5]
env = dict(os.environ, NEUROLINK_HERMES_TIMEOUT="1")
sib = None
with open(out_path, "wb") as out_f, open(err_path, "wb") as err_f:
    wproc = subprocess.Popen(
        ["/bin/bash", wrapper, "-p", "hi"],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=out_f,
        stderr=err_f,
        preexec_fn=lambda: os.setpgid(0, 0),
    )
    try:
        deadline = time.time() + 3.0
        while time.time() < deadline and not os.path.exists(ready_path):
            time.sleep(0.02)
        if not os.path.exists(ready_path):
            raise SystemExit("stub never became ready")
        sib = subprocess.Popen(
            ["/bin/sleep", "30"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=lambda: os.setpgid(0, wproc.pid),
        )
        assert os.getpgid(wproc.pid) == wproc.pid
        assert os.getpgid(sib.pid) == wproc.pid
        rc = wproc.wait(timeout=10)
        time.sleep(0.1)
        sib_rc = sib.poll()
        if rc != 1:
            raise SystemExit(f"want wrapper rc=1, got {rc}")
        if sib_rc is not None:
            raise SystemExit(f"sibling sleep died with {sib_rc}")
    finally:
        if wproc.poll() is None:
            wproc.kill()
            wproc.wait()
        if sib is not None and sib.poll() is None:
            sib.terminate()
            try:
                sib.wait(timeout=5)
            except subprocess.TimeoutExpired:
                sib.kill()
                sib.wait()
PY
[ ! -s "$tmp/out" ] || fail "T11: caller stdout not empty on timeout"
one_start_one_end t11_sibling_survives
grep -Eq 'llm-hermes: FAILED .*timed out after [0-9]+s' "$NEUROLINK_HERMES_LOG" || fail "T11: log lacks timeout FAILED line"

# T12 (Finding B) — new-session child is stopped: stub starts a child in a new session that
# would write a marker after 3s while the stub itself stays alive; wrapper timeout 1s; after
# the wrapper returns and a 4s wait the marker does not exist.
t12_marker="$tmp/t12-setsid-marker"
t12_ready="$tmp/t12-setsid-ready"
t12_pidfile="$tmp/t12-setsid-pid"
rm -f "$t12_marker" "$t12_ready" "$t12_pidfile" "$tmp/out" "$tmp/err"
fake "/usr/bin/python3 -c '
import os, pathlib, time
os.setsid()
pathlib.Path(\"$t12_pidfile\").write_text(str(os.getpid()))
pathlib.Path(\"$t12_ready\").write_text(\"ready\")
time.sleep(3)
pathlib.Path(\"$t12_marker\").write_text(\"leaked\")
' >/dev/null 2>&1 </dev/null &
for _ in \$(seq 1 100); do [ -e '$t12_ready' ] && break; /bin/sleep 0.02; done
exec /bin/sleep 10"
NEUROLINK_HERMES_TIMEOUT=1 "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err"
rc=$?
[ "$rc" = 1 ] || fail "T12: want exit 1 on timeout, got $rc"
[ ! -s "$tmp/out" ] || fail "T12: caller stdout not empty on timeout"
one_start_one_end t12_setsid_child
/bin/sleep 4
if [ -e "$t12_pidfile" ]; then builtin kill -KILL "$(cat "$t12_pidfile")" 2>/dev/null || true; fi
[ ! -e "$t12_marker" ] || fail "T12: new-session child survived timeout and wrote marker"

# T13 — grandchild is stopped: stub starts a child that starts a grandchild that would write a
# marker after 3s while stub and child stay alive; after 1s timeout and a 4s wait the marker
# does not exist.
t13_marker="$tmp/t13-grandchild-marker"
t13_ready="$tmp/t13-grandchild-ready"
t13_pids="$tmp/t13-pids"
rm -f "$t13_marker" "$t13_ready" "$t13_pids" "$tmp/out" "$tmp/err"
fake "/usr/bin/python3 -c '
import os, pathlib, subprocess, time
os.setsid()
g = subprocess.Popen([
    \"/usr/bin/python3\", \"-c\",
    \"import pathlib, time; pathlib.Path(\\\"$t13_ready\\\").write_text(\\\"ready\\\"); time.sleep(3); pathlib.Path(\\\"$t13_marker\\\").write_text(\\\"leaked\\\")\"
], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pathlib.Path(\"$t13_pids\").write_text(f\"{os.getpid()} {g.pid}\")
time.sleep(10)
' >/dev/null 2>&1 </dev/null &
for _ in \$(seq 1 100); do [ -e '$t13_ready' ] && break; /bin/sleep 0.02; done
exec /bin/sleep 10"
NEUROLINK_HERMES_TIMEOUT=1 "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err"
rc=$?
[ "$rc" = 1 ] || fail "T13: want exit 1 on timeout, got $rc"
[ ! -s "$tmp/out" ] || fail "T13: caller stdout not empty on timeout"
one_start_one_end t13_grandchild
/bin/sleep 4
if [ -e "$t13_pids" ]; then builtin kill -KILL $(cat "$t13_pids") 2>/dev/null || true; fi
[ ! -e "$t13_marker" ] || fail "T13: grandchild survived timeout and wrote marker"

# T14 — signal path: wrapper receives TERM while stub with a new-session child is running;
# after a 4s wait the marker does not exist, and the log has the single FAILED interrupted line.
t14_marker="$tmp/t14-sig-marker"
t14_child_ready="$tmp/t14-child-ready"
t14_stub_ready="$tmp/t14-stub-ready"
t14_pidfile="$tmp/t14-sig-pid"
rm -f "$t14_marker" "$t14_child_ready" "$t14_stub_ready" "$t14_pidfile" "$tmp/out" "$tmp/err"
fake "/usr/bin/python3 -c '
import os, pathlib, time
os.setsid()
pathlib.Path(\"$t14_pidfile\").write_text(str(os.getpid()))
pathlib.Path(\"$t14_child_ready\").write_text(\"ready\")
time.sleep(3)
pathlib.Path(\"$t14_marker\").write_text(\"leaked\")
' >/dev/null 2>&1 </dev/null &
for _ in \$(seq 1 100); do [ -e '$t14_child_ready' ] && break; /bin/sleep 0.02; done
printf ready >'$t14_stub_ready'
exec /bin/sleep 10"
NEUROLINK_HERMES_TIMEOUT=30 "$here/llm-hermes.sh" -p hi >"$tmp/out" 2>"$tmp/err" &
t14_wpid=$!
for _ in $(seq 1 100); do [ -e "$t14_stub_ready" ] && break; /bin/sleep 0.02; done
[ -e "$t14_stub_ready" ] || { builtin kill -KILL "$t14_wpid" 2>/dev/null || true; fail "T14: stub never became ready"; }
/bin/sleep 0.05
builtin kill -TERM "$t14_wpid" 2>/dev/null || fail "T14: failed to send TERM to wrapper"
wait "$t14_wpid" 2>/dev/null; t14_rc=$?
[ "$t14_rc" = 143 ] || fail "T14: want exit 143 on TERM, got $t14_rc"
[ ! -s "$tmp/out" ] || fail "T14: caller stdout not empty when killed with TERM"
one_start_one_end t14_signal_term
[ "$(count 'llm-hermes: FAILED interrupted \(TERM\) after [0-9]+s$')" = 1 ] || fail "T14: want single FAILED interrupted (TERM) log line"
/bin/sleep 4
if [ -e "$t14_pidfile" ]; then builtin kill -KILL "$(cat "$t14_pidfile")" 2>/dev/null || true; fi
[ ! -e "$t14_marker" ] || fail "T14: new-session child survived wrapper TERM and wrote marker"

# Regression guard for the documented stop contract, NOT a red-first test.
# T15 proves the SUPPORTED stop path (SIGTERM to the wrapper) still stops the
# descendant tree when the launcher started the wrapper with SIGINT and SIGHUP
# set to SIG_IGN. With those two signals ignored at launch, non-interactive
# Bash cannot install traps for them (a documented limit of Bash, not fixed
# here), but TERM stays catchable and must still work. This guard is expected
# to PASS on the pre-change wrapper c6b6df9a60aa434e057fedb304d5f8ded814f3ee
# too; it deliberately does NOT assert that an ignored INT/HUP stops anything.
# (No characterization test of the ignored-signal limit is added: such a test
#  must not fail the suite if Bash behavior differs, so it is skipped, as the
#  brief prefers. T15 only asserts the SUPPORTED TERM path still works.)
t15_marker="$tmp/t15-sig-marker"
t15_ready="$tmp/t15-child-ready"
t15_pidfile="$tmp/t15-sig-pid"
rm -f "$t15_marker" "$t15_ready" "$t15_pidfile" "$tmp/out" "$tmp/err"
fake "/usr/bin/python3 -c 'import os, pathlib, sys, time; os.setsid(); pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); pathlib.Path(sys.argv[2]).touch(); time.sleep(3); pathlib.Path(sys.argv[3]).touch()' '$t15_pidfile' '$t15_ready' '$t15_marker' >/dev/null 2>&1 </dev/null &
exec /bin/sleep 10"
/usr/bin/python3 - "$here/llm-hermes.sh" "$t15_ready" "$tmp/out" "$tmp/err" <<'PY' || fail "T15: SUPPORTED TERM stop path did not survive an ignored INT/HUP launch"
import os, signal, subprocess, sys, time

wrapper, ready_path, out_path, err_path = sys.argv[1:5]
env = dict(os.environ, NEUROLINK_HERMES_TIMEOUT="30")

def ignore_int_hup():
    # Leave SIGINT/SIGHUP ignored for the wrapper. Non-interactive Bash then
    # inherits SIG_IGN and cannot reinstall traps for those signals; TERM is
    # left catchable. This is exactly the documented "best effort" launch case.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

with open(out_path, "wb") as out_f, open(err_path, "wb") as err_f:
    wproc = subprocess.Popen(
        ["/bin/bash", wrapper, "-p", "hi"],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=out_f,
        stderr=err_f,
        preexec_fn=ignore_int_hup,
    )
    try:
        deadline = time.time() + 5.0
        while time.time() < deadline and not os.path.exists(ready_path):
            time.sleep(0.02)
        if not os.path.exists(ready_path):
            raise SystemExit("T15: new-session child never became ready")
        time.sleep(0.05)
        os.kill(wproc.pid, signal.SIGTERM)
        rc = wproc.wait(timeout=10)
        if rc != 143:
            raise SystemExit("T15: want wrapper exit 143 on TERM, got %s" % rc)
    finally:
        if wproc.poll() is None:
            wproc.kill()
            wproc.wait()
PY
[ ! -s "$tmp/out" ] || fail "T15: caller stdout not empty when killed with TERM"
one_start_one_end t15_ignored_int_hup_term
[ "$(count 'llm-hermes: FAILED interrupted [(]TERM[)] after [0-9]+s$')" = 1 ] || fail "T15: want single FAILED interrupted (TERM) log line"
/bin/sleep 4
if [ -e "$t15_pidfile" ]; then builtin kill -KILL "$(cat "$t15_pidfile")" 2>/dev/null || true; fi
[ ! -e "$t15_marker" ] || fail "T15: new-session child survived wrapper TERM (ignored INT/HUP launch) and wrote marker"
echo "T15: PASS (regression guard: SUPPORTED TERM stop path survives ignored SIGINT/SIGHUP launch)"

echo "PASS: llm-hermes.sh logging"
