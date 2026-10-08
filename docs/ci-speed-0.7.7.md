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

### 1b. The same four jobs after §2 and §3 (frame **#172**, `af71802`, success)

| | WSL1 src | WSL1 lib | WSL2 src | WSL2 lib | run wall | billed |
|---|---|---|---|---|---|---|
| #169 before | 448 s | 444 s | 331 s | 318 s | 474 s | 1,612 s |
| #172 after | **377 s** | **369 s** | 299 s | 347 s | **407 s** | 1,471 s |
| gates step | 286 → **224 s** | 275 → **216 s** | 122 → 122 s | 116 → 114 s | | |

The WSL2 columns are the control this change did not need to ask for: where the kernel gives the tool
something to act on, the gate step did **not** move (122 s → 122 s, 116 s → 114 s), which is what
"only the non-acting arm asked a shorter deadline" predicts. The WSL2 lib job's 318 → 347 s is not the
gates — it is provisioning and the steps around them; §3's per-gate line is what makes that separation
free instead of something a later reader has to reconstruct.

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

Predicted here before the frame: **−36 s per WSL1 job**, from the three tabled cells alone. Measured on
#172 (§1b): **−62 s** on WSL1 src (286 → 224 s) and **−59 s** on WSL1 lib (275 → 216 s) — the two
further-down cells did burn seconds after all, just not enough to clear 8 s individually in #169, which
is why the arithmetic under-called it. Run wall 474 → **407 s**, billed 1,612 → 1,471 s. The shape of
the saving is unchanged: it is wall-clock relief on the critical path, and 121 s of windows time per
frame, not a cheaper unit of work.

**How this is verified:** the non-acting arm cannot be exercised on a machine whose `/proc` answers —
so the WSL1 job on this PR's own frame *is* the experiment, and #172 is green with the five cells'
assertions intact. The acting arm was re-run locally (`bash-session-real`, both planes, Ubuntu/WSL2):
**73/73 and 73/73**, unchanged — and the WSL2 gate step not moving (122 s → 122 s) is the same fact
reported by a runner rather than by a laptop.

## 3. The gate step now says who took the time

`run_one` in `ci.yml` printed `rc=` and the gate's verdict lines but no elapsed, so §1's numbers cost
downloading four log artifacts and parsing their JSON readings. Each gate now prints
`elapsed=Ns` next to its rc — and it paid for itself on the very next frame: #172's WSL1 src step
attributes itself to one line, `elapsed=153s` on `bash-session-real` and `elapsed=31s` on
`relay-real`, with everything else ≤ 4 s. The next analysis of this lane reads one step log instead of
four artifacts.

## 4. Options measured but not taken, with their price

| Option | Buys | Why it is not in this PR |
|---|---|---|
| Drop the src plane on WSL1 (it is the comparison arm) | −448 s billed, −28% of the money | **zero wall-clock**: WSL1 lib is 444 s and becomes the critical path. A cost lever, and it stops catching src↔lib divergence on the kernel that already answers `/proc` differently |
| Cache `ci/deps` (the 521 host packages) | ~10–15 s per job, 4 jobs | The step is 17 s with `npm ci` from a warm `~/.npm`; the cache key must cover `ci/pinned-deps.json` too or it goes stale exactly when pins move — the failure §6.3 of the slimming analysis measured. Worth doing as its own change with the pins↔lock assertion in the same commit |
| Start the lanes without `needs: lint-build` | −18 s of wall | That 18 s is the cheap gate that stops the four windows jobs from running at all when the committed `lib/` is not what HEAD says. Trading 3.8% of wall for ~25 minutes of windows time per bad frame is a bad exchange |
| Reuse the distro listing in *pin the distro…* (it runs `wsl -l -v` twice) | ~10–15 s, but only on the WSL2 jobs | Not the critical path (WSL2 is 331 s vs 448 s); do it when touching that step for another reason |
| `relay-real`, now the second-largest gate: 31 s on WSL1 and 30 s on WSL2 (#172's own `elapsed=` line) | unknown — 124 s of billed time per frame, but it is not the critical path | **Attributed to the driver, not through it.** §3 tells us the driver costs 31 s; it does not say which of its phases does, and the driver boots two PTY relays through a 9P share whose first touch is a mount. The next change here is a phase reading inside `relay-real`, and only after that a number to move. Guessing at a wait is how you cut the one that was load-bearing |
| Cut cells from `bash-session-real` (73 checks, ~1.7 s of real spawn each) | seconds per check | That is coverage, and this repository's ruling is that coverage is not trimmed to make a frame faster |

## 5. Standing claim this file keeps honest

The four windows jobs exist because two kernel shapes answer the keyboard-wait question differently, and
because `lib/` is what ships. §2 shortens the waiting **only** where the wait was not the claim; the
cell that must still wait a long deadline to prove it (`a longer deadline does not buy a keyboard wait
back`) keeps its 8 s ask on that branch and its 60 s ask where the tool can act. If a future frame shows
one of the five changed cells red on WSL1 with `timedOut !== true`, that is the change being wrong, not
the runner being flaky. **Frame #172 tested that sentence and did not trigger it**: green on both WSL1
planes, with the same cells still reporting a timeout at the deadline they were handed and a witness
clause in the body.
