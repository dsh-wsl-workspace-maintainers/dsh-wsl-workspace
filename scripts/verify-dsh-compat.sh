#!/usr/bin/env bash
# Compatibility verification of dsh-wsl-workspace against specific
# @deepseek-ai/dsh releases (the DSH-Store fixed-Commit evidence).
#
# Everything runs isolated: DSH_HOME is redirected to a fresh temp tree and
# each instance gets its own port, so the live installation is never touched.
# For every version the script records:
#   1. install   — `dsh plugin --profile web add dsh-wsl-workspace` succeeds
#   2. start     — the web server boots with the plugin and the plugin's
#                  POST /wsl-workspace/api answers (route registered)
#   3. uninstall — `dsh plugin --profile web remove dsh-wsl-workspace`
#                  succeeds and the route disappears after a re-boot
# A version is "compatible" only when all three hold; the verdict lines are
# appended to <base>/verdicts.txt and every log is kept under <base>.
#
#   scripts/verify-dsh-compat.sh 0.1.0-rc.8 0.1.1-rc.1 0.1.1-rc.2
set -uo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <dsh-version> [more versions...]" >&2
  exit 2
fi

BASE="${TEMP:-/tmp}/dsh-compat-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BASE"
# Where the evidence lives, announced before any work, so the line is in the log no matter which
# exit is taken below. compat.yml used to hard-code a second spelling of this directory
# (`COMPAT_BASE_WIN: C:\Users\runneradmin\AppData\Local\Temp\compat-work`) beside the
# `TEMP: /tmp/compat-work` that produced it, with nothing checking the two agree — and
# `upload-artifact` with a non-matching path warns instead of failing, so every version's evidence
# could vanish while the step stayed green. The job now reads this line and uploads what it names.
# It cannot be an end-of-script echo: the two RED exits below (empty verdicts, a non-PASS verdict)
# are the exact frames whose evidence has to be collected, and they never reached that line
# (frame 36744046100 — upload-artifact then matched nothing and errored).
echo "compat-base: $BASE"
PORT="${COMPAT_PORT:-3091}"
PLUGIN_API="http://127.0.0.1:${PORT}/wsl-workspace/api"
WEB_URL="http://127.0.0.1:${PORT}/"
# What `plugin add` installs: by default the registry package name (maintainer
# release flow). CI points PLUGIN_REF at a locally built tarball so an
# unpublished commit is never tested against an older published artifact.
PLUGIN_NAME="dsh-wsl-workspace"
PLUGIN_REF="${PLUGIN_REF:-$PLUGIN_NAME}"

wait_ready() { # wait_ready <boot-log> [tries] — the web server answers HTTP at all.
  # Readiness is liveness, not auth: 0.2.0-rc gates `/` behind a browser
  # token handshake (401 anonymous, 303 → ./ with the query dropped), so an
  # HTML-content probe can never settle. The plugin's own health is asserted
  # separately by api_code below; here any HTTP response counts.
  local tries="${2:-60}" code
  for _ in $(seq 1 "$tries"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 2 "$WEB_URL" 2>/dev/null)"
    code="${code:-000}"
    if [ "$code" != "000" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

api_code() { # api_code <method> <params-json>
  # curl already prints 000 for a failed connect with -w; only default the
  # never-printed case (curl died before writing) — otherwise the caller
  # reads "000000".
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 5 -X POST "$PLUGIN_API" \
    -H 'Content-Type: application/json' \
    -d "{\"method\":\"$1\",\"params\":$2}" 2>/dev/null)"
  printf '%s' "${code:-000}"
}

for VERSION in "$@"; do
  echo "=============================================================="
  echo " verifying @deepseek-ai/dsh@$VERSION"
  echo "=============================================================="
  WORK="$BASE/$VERSION"
  mkdir -p "$WORK/pkg" "$WORK/dsh-home"
  DSH_HOME="$(cygpath -w "$WORK/dsh-home")"
  export DSH_HOME

  echo "[install] npm i @deepseek-ai/dsh@$VERSION"
  if ! (cd "$WORK/pkg" \
        && npm init -y >/dev/null 2>&1 \
        && npm i "@deepseek-ai/dsh@$VERSION" --no-audit --no-fund >/dev/null 2>&1); then
    echo "  ✖ harness installation failed"
    # $VERSION, not $Version: under `set -u` an unbound name aborts the whole script at this
    # line, so the failure verdict was never written and every later version in the same call
    # went dark instead of being recorded.
    echo "$VERSION INSTALL_FAIL unknown" >> "$BASE/verdicts.txt"
    continue
  fi
  BIN="$WORK/pkg/node_modules/@deepseek-ai/dsh/lib/bin.js"

  # If PLUGIN_REF names a directory, stage it INSIDE the case's pkg tree
  # first: `plugin add` creates a pnpm link whose realpath is the source
  # directory, and node resolves the plugin's optional peers by walking up
  # from that realpath — only next to the dsh install are they reachable.
  ADD_REF="$PLUGIN_REF"
  SRC_UNIX="$(cygpath -u "$PLUGIN_REF" 2>/dev/null || printf '%s' "$PLUGIN_REF")"
  if [ -d "$SRC_UNIX" ]; then
    DEST="$WORK/pkg/node_modules/dsh-wsl-workspace"
    rm -rf "$DEST"
    mkdir -p "$WORK/pkg/node_modules"
    cp -r "$SRC_UNIX" "$DEST" || { echo "  ✖ staging the plugin source into the case tree failed"; echo "$VERSION STAGE_FAIL unknown" >> "$BASE/verdicts.txt"; continue; }
    ADD_REF="$(cygpath -w "$DEST")"
  fi

  echo "[install] dsh plugin --profile web add $ADD_REF"
  if ! node "$BIN" plugin --profile web add "$ADD_REF" > "$WORK/plugin-add.log" 2>&1; then
    echo "  ✖ plugin add failed (see $WORK/plugin-add.log)"
    echo "$VERSION PLUGIN_ADD_FAIL unknown" >> "$BASE/verdicts.txt"
    continue
  fi
  grep -q 'dsh-wsl-workspace' "$WORK/dsh-home/profiles/web/package.json" \
    && echo "  ✔ profile manifest carries the plugin"

  echo "[start] booting web on :$PORT"
  node "$BIN" web --port "$PORT" --no-open > "$WORK/boot-with-plugin.log" 2>&1 &
  SERVER_PID=$!
  if ! wait_ready "$WORK/boot-with-plugin.log" 60; then
    echo "  ✖ server did not serve the web UI"
    kill "$SERVER_PID" 2>/dev/null
    echo "$VERSION BOOT_FAIL unknown" >> "$BASE/verdicts.txt"
    continue
  fi
  echo "  ✔ web UI is up"
  # the plugin route registers while the server is still coming up — poll
  # for its 200 instead of taking one shot that races plugin loading
  CODE=000
  for _ in $(seq 1 20); do
    CODE="$(api_code listDistros '{}')"
    [ "$CODE" = "200" ] && break
    sleep 2
  done
  if [ "$CODE" = "200" ]; then
    echo "  ✔ plugin route answers 200 (plugin loaded and registered)"
  else
    echo "  ✖ plugin route answered $CODE (expected 200)"
    kill "$SERVER_PID" 2>/dev/null
    echo "$VERSION ROUTE_FAIL unknown" >> "$BASE/verdicts.txt"
    continue
  fi
  # The asserted pass needs two things the manual Windows runbook created implicitly: a
  # distribution name that exists on this runner, and its fixture directories. compat.yml
  # provisions Ubuntu-24.04 via Vampire/setup-wsl (set as default) but exports no
  # WSL_COMPAT_DISTRO, so host-api.mjs's 'Ubuntu' default opened a share root that does not
  # exist -> `UNKNOWN: unknown error, mkdir '\\wsl.localhost\Ubuntu\tmp\dsh-wsl-compat\.agents'`
  # (errno -4094, frame 36739213446, all three matrix entries). Read the name from the machine
  # Read the name from the machine
  # instead of guessing it a second time, and create the Linux-side directories through
  # wsl.exe before anything tries to reach them over 9P. The manual sweep keeps the port in
  # runtime.json (Prepare-Case.ps1:106); this path kept it in $PORT and wrote nothing, so emit
  # the same manifest shape rather than invent a second one.
  node -e 'const {writeFileSync}=require("node:fs");writeFileSync(process.argv[1],JSON.stringify({port:Number(process.argv[2]),version:process.argv[3],runId:process.argv[4],commit:process.argv[5]},null,2))' \
    "$WORK/runtime.json" "$PORT" "$VERSION" "$(git rev-parse --short HEAD)"
  COMPAT_DISTRO="${WSL_COMPAT_DISTRO:-$(wsl.exe -l -q 2>/dev/null | tr -d '\0' \
    | sed '/^\s*$/d' | grep -i -m1 ubuntu || true)}"
  if [ -z "$COMPAT_DISTRO" ]; then
    echo "  ! no WSL distribution found for the asserted API pass — NOT VERIFIED"
    echo "$VERSION HOST_API_NOT_VERIFIED unknown" >> "$BASE/verdicts.txt"
  else
    # The Linux-side fixture root is deliberately NOT passed through an environment variable.
    # On a Windows bash runner MSYS rewrites a POSIX-looking value to an absolute Windows path,
    # and that value then gets pasted straight after the distro name by the drivers:
    # `\\wsl.localhost\Ubuntu-24.04C:\Users\RUNNER~1\AppData\Local\Temp\dsh-wsl-compat\.agents`
    # (frame 36744046100, errno -4094). The drivers' own in-code default `/tmp/dsh-wsl-compat`
    # never passes through the shell, so it cannot be mangled; matrix entries run sequentially,
    # and `mkdir -p` plus the driver's own `rm -rf` keep the shared tree clean between them.
    COMPAT_LINUX=/tmp/dsh-wsl-compat
    wsl.exe -d "$COMPAT_DISTRO" -- bash -c \
      "mkdir -p '$COMPAT_LINUX/.agents' '$COMPAT_LINUX/dsh-win-fixture'" >/dev/null 2>&1 || true
    HOST_API_LOG="$WORK/host-api.log"
    if WSL_COMPAT_DISTRO="$COMPAT_DISTRO" WSL_COMPAT_USER="${WSL_COMPAT_USER:-root}" \
       node scripts/compatibility/host-api.mjs "$WORK/runtime.json" > "$HOST_API_LOG" 2>&1; then
      # Success is carried by the script's own exit: if any later stage passes and this one was
      # the only thing that could fail, the loop reaches the end for this version and the PASS
      # verdict is written by the existing tail. A separate `… PASS` line in a side file would be
      # a decoration — nothing reads it, and the final contract is `verdicts.txt` only.
      echo "  ✔ asserted API pass $(tail -1 "$HOST_API_LOG")"
    else
      echo "  ✖ asserted API pass failed: $(tail -1 "$HOST_API_LOG")"
      sed 's/^/      /' "$HOST_API_LOG" | tail -15
      kill "$SERVER_PID" 2>/dev/null
      echo "$VERSION HOST_API_FAIL unknown" >> "$BASE/verdicts.txt"
      continue
    fi
  fi
  # An outcome, not only a route: the probe above answers HTTP, which a profile whose
  # variant generation died on its very first source also did (issue #47 — every route
  # served, no wsl-* variant existed). The plugin now logs one count line per boot, so
  # the matrix asserts it. A missing line is NOT VERIFIED rather than a pass: the
  # release may predate the line, and "we could not read it" is not "it was fine".
  VARIANTS_LINE="$(grep -o 'WSL preset variants: [0-9]*/[0-9]* registered' "$WORK/boot-with-plugin.log" | tail -1)"
  V_GOT="$(printf '%s' "$VARIANTS_LINE" | sed -n 's|.*variants: \([0-9]*\)/[0-9]* registered.*|\1|p')"
  V_EXPECT="$(printf '%s' "$VARIANTS_LINE" | sed -n 's|.*variants: [0-9]*/\([0-9]*\) registered.*|\1|p')"
  if [ -z "$VARIANTS_LINE" ]; then
    echo "  ! no variant-outcome line in the boot log — NOT VERIFIED"
    echo "$VERSION VARIANTS_NOT_VERIFIED unknown" >> "$BASE/verdicts.txt"
  elif [ "$V_EXPECT" = "0" ]; then
    # Nothing on the roster to derive a variant from is a broken fixture, not a
    # compatible release: every shipped profile carries at least one mode preset.
    echo "  ! the booted roster offered no source preset (0/0) — NOT VERIFIED"
    echo "$VERSION VARIANTS_NOT_VERIFIED unknown" >> "$BASE/verdicts.txt"
  elif [ "$V_GOT" != "$V_EXPECT" ]; then
    echo "  ✖ variant generation published $V_GOT of $V_EXPECT sources: $(tail -1 "$WORK/boot-with-plugin.log")"
    kill "$SERVER_PID" 2>/dev/null
    echo "$VERSION VARIANTS_FAIL unknown" >> "$BASE/verdicts.txt"
    continue
  else
    echo "  ✔ $VARIANTS_LINE"
  fi
  grep -i 'dsh-wsl-workspace.*\(error\|fail\)' "$WORK/boot-with-plugin.log" \
    && echo "  ✖ plugin errors found in the boot log" \
    && { kill "$SERVER_PID" 2>/dev/null; echo "$VERSION LOG_ERRORS unknown" >> "$BASE/verdicts.txt"; continue; }
  echo "  ✔ no plugin errors in the boot log"
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  sleep 2

  echo "[uninstall] dsh plugin --profile web remove dsh-wsl-workspace"
  if ! node "$BIN" plugin --profile web remove dsh-wsl-workspace > "$WORK/plugin-remove.log" 2>&1; then
    echo "  ✖ plugin remove failed (see $WORK/plugin-remove.log)"
    echo "$VERSION REMOVE_FAIL unknown" >> "$BASE/verdicts.txt"
    continue
  fi
  echo "  ✔ removed"
  node "$BIN" web --port "$PORT" --no-open > "$WORK/boot-without-plugin.log" 2>&1 &
  SERVER_PID=$!
  if ! wait_ready "$WORK/boot-without-plugin.log" 60; then
    echo "  ✖ server did not come back after removal"
    kill "$SERVER_PID" 2>/dev/null
    echo "$VERSION REBOOT_FAIL unknown" >> "$BASE/verdicts.txt"
    continue
  fi
  CODE="$(api_code listDistros '{}')"
  if [ "$CODE" != "200" ]; then
    echo "  ✔ plugin route gone after removal ($CODE) — clean uninstall"
    echo "$VERSION PASS compatible" >> "$BASE/verdicts.txt"
  else
    echo "  ✖ plugin route still present after removal"
    echo "$VERSION REMOVE_INCOMPLETE unknown" >> "$BASE/verdicts.txt"
  fi
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
done

echo "=============================================================="
# The guard runs before the cat: this script is `set -uo pipefail`, so reading a verdicts
# file that was never created (every version aborted before its first write) died here on a
# missing-file error and the honest verdict block below never ran.
if [ ! -s "$BASE/verdicts.txt" ]; then
  echo "verify-dsh-compat: RED — verdicts.txt is missing or empty (no version reached a verdict)" >&2
  exit 1
fi
echo " verdicts ($BASE/verdicts.txt):"
cat "$BASE/verdicts.txt"

# The verdicts are the contract: only `PASS compatible` is green. Without
# this exit the caller always saw rc 0 — the frame-1 compat matrix was
# three PLUGIN_ADD_FAIL lines under a green checkmark.
if grep -qv ' PASS compatible$' "$BASE/verdicts.txt"; then
  echo "verify-dsh-compat: RED — at least one verdict is not 'PASS compatible'" >&2
  exit 1
fi
echo "verify-dsh-compat: OK — $(wc -l < "$BASE/verdicts.txt") verdict(s), all PASS compatible"
