# CI speed at v0.7.7 — where the 7.9 minutes actually go

Measured on the first all-green frame of this lane, run **#169** at `976a0ba`, using the Actions API's
own timestamps (queue and run per job; the artifact logs for the per-cell readings). Nothing here is a
guess: the arithmetic is `completed_at - started_at` per job and `"ms":` readings per check.

## 1. The shape of a green frame

| Job | s | share of billed |
|---|---|---|
| real-WSL hard gates (windows + WSL1 Ubuntu, src plane) | 448 | 28% |
| real-WSL hard gates (windows + WSL1 Ubuntu, lib plane) | 444 | 28% |
| real-WSL hard gates (windows + WSL2 Ubuntu, src plane) | 331 | 21% |
| real-WSL hard gates (windows + WSL2 Ubuntu, lib plane) | 318 | 20% |
| node buckets against the pinned host tree (ubuntu) | 53 | 3% |
| gates on the committed artifact plane (ubuntu) | 18 | 1% |

Run wall clock (created → last job finished) **474 s = 7.9 min**; billed **1,612 s = 26.9 min**; the
four windows jobs are **96%** of the billed time; queue was 2–4 s, so right now nothing is waiting for
a runner. `compat-window` is a separate weekly/demand workflow and is not in this path.

Inside one WSL1 job (448 s):

| Step | s |
|---|---|
| run the src-plane gates | 286 |
| provision WSL1 Ubuntu | 103 |
| install pinned @deepseek-ai host packages | 17 |
| setup-node / npm ci / checkout | 28 |
| everything else | 14 |

Inside the gates step (276 s of measured group spans): `bash-session-real` **215 s**, `relay-real`
**30 s**, every other gate ≤ 4 s. The same two drivers on WSL2: 48 s and 30 s.

## 2. The one finding worth acting on, and its size

`bash-session-real` prints a millisecond reading for its keyboard-wait cells. On the WSL1 frame five
readings are ≥ 8 s and sum to **103.5 s** of the driver's 215 s; on the WSL2 frame the same nine
readings sum to **11.9 s**, maximum 4.0 s. The five are the cells whose assertion, on the branch where
the kernel exposes nothing to act on (`w=not-reported`, no foreground job), is *"the call ended at the
deadline it was handed, and named the reading it relied on"*:

| cell | asked | WSL1 |
|---|---|---|
| `tty:false` vetoes the re-run | 20 s | 23.7 s |
| a command waiting for the keyboard is stopped and answered | 20 s | 23.7 s |
| a wait after some output is still caught | 20 s | 23.7 s |
| a builtin that reads the terminal | 20 s | 20.7 s |
| a longer deadline does not buy a keyboard wait back | 8 s | 11.7 s |

The deadline's **length** is not what those five prove. The file already knows this: the last row's ask
is `canAct ? 60_000 : 8_000`, written that way on purpose. This branch extends the same shape to the
three 20 s cells above that do not decide `canAct` — and to two more of the same shape further down the
file (`a waiting command inside a wrapper`, `a rebuild triggered by a terminal wait`), which happened
not to be over 8 s in this frame. The one 20 s cell that *does* decide `canAct` (`starved`) is left
alone, because it is the call that discovers which arm the run is on.

Expected on the critical path: **−36 s per WSL1 job** (286 s → ~250 s, run 474 s → ~438 s). It is a
wall-clock change, not a cost change: both WSL1 jobs keep running in parallel, so nothing gets cheaper
per unit except the 72 s of windows time the two jobs stop burning.

**How this is verified:** the non-acting arm cannot be exercised on a machine whose `/proc` answers —
so the WSL1 job on this PR's own frame *is* the experiment. The acting arm was re-run locally
(`bash-session-real`, plane=src, Ubuntu/WSL2): **73/73**, unchanged.

## 3. The gate step now says who took the time

`run_one` in `ci.yml` printed `rc=` and the gate's verdict lines but no elapsed, so §1's numbers cost
downloading four log artifacts and parsing their JSON readings. Each gate now prints
`elapsed=Ns` next to its rc. Costs nothing, and the next analysis of this lane reads one step log.

## 4. Options measured but not taken, with their price

| Option | Buys | Why it is not in this PR |
|---|---|---|
| Drop the src plane on WSL1 (it is the comparison arm) | −448 s billed, −28% of the money | **zero wall-clock**: WSL1 lib is 444 s and becomes the critical path. A cost lever, and it stops catching src↔lib divergence on the kernel that already answers `/proc` differently |
| Cache `ci/deps` (the 521 host packages) | ~10–15 s per job, 4 jobs | The step is 17 s with `npm ci` from a warm `~/.npm`; the cache key must cover `ci/pinned-deps.json` too or it goes stale exactly when pins move — the failure §6.3 of the slimming analysis measured. Worth doing as its own change with the pins↔lock assertion in the same commit |
| Start the lanes without `needs: lint-build` | −18 s of wall | That 18 s is the cheap gate that stops the four windows jobs from running at all when the committed `lib/` is not what HEAD says. Trading 3.8% of wall for ~25 minutes of windows time per bad frame is a bad exchange |
| Reuse the distro listing in *pin the distro…* (it runs `wsl -l -v` twice) | ~10–15 s, but only on the WSL2 jobs | Not the critical path (WSL2 is 331 s vs 448 s); do it when touching that step for another reason |
| `relay-real`, 30 s on both planes | unknown | Not attributed yet — after §3 it will be, since the step prints its own elapsed and the driver's phases are the next thing to time. Guessing at a driver that boots two PTY relays is how you end up cutting a real wait |
| Cut cells from `bash-session-real` (73 checks, ~1.7 s of real spawn each) | seconds per check | That is coverage, and this repository's ruling is that coverage is not trimmed to make a frame faster |

## 5. Standing claim this file keeps honest

The four windows jobs exist because two kernel shapes answer the keyboard-wait question differently, and
because `lib/` is what ships. §2 shortens the waiting **only** where the wait was not the claim; the
cell that must still wait a long deadline to prove it (`a longer deadline does not buy a keyboard wait
back`) keeps its 8 s ask on that branch and its 60 s ask where the tool can act. If a future frame shows
one of the four changed cells red on WSL1 with `timedOut !== true`, that is the change being wrong, not
the runner being flaky.
