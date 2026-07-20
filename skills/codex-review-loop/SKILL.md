---
name: codex-review-loop
description: Watch a GitHub PR for Codex AI review comments, author each fix in-loop, and stop at a sensible point instead of chasing Codex's nitpicks forever (Codex's 👍, or only non-regression nitpicks left → archive as follow-ups and close out). Use when the user says "watch codex's review on this PR", "wait for codex's thumbs-up", "codex review loop", "watch codex on PR", "iterate on codex feedback", "codex pr iterate", "don't let codex review forever", or when they want a PR shepherded through automated review until approved. Also use when the user opens a PR and asks "keep an eye on it and fix what comes up". Do NOT trigger when the repo has no `chatgpt-codex-connector[bot]` installed, when the user wants only human review, or when they ask to disable Codex.
---

# Codex Review Loop

Shepherd a GitHub PR through Codex AI review: monitor for new findings, author each fix in-loop, resolve threads, and **stop at a sensible point** — Codex's 👍, or a severity floor you judge (only non-regression nitpicks left → archive them as follow-ups and close out). Stopping authority is yours, not Codex's.

## When this applies

- Repo has `chatgpt-codex-connector[bot]` configured (check `gh api repos/<owner>/<repo>/pulls/$PR/reviews` for prior reviews from that user).
- PR is open and the user wants Codex to gate the merge.
- User has authorized you to push commits to the PR branch.

## The Codex protocol (from its own About text)

- Codex auto-reviews on PR open, draft→ready transitions, new commits to the head branch, or `@codex review` comments.
- While processing it leaves an `eyes` reaction on the PR issue.
- **If it has suggestions** → it posts a review with inline comments tagged P0 / P1 / P2 / P3.
- **If it has nothing to add** → it reacts with `+1` (👍) — that's the approval signal.
- Each new push to the PR head *should* re-trigger a review automatically — **but in practice this is unreliable** (quota / capacity / flakiness): Codex routinely leaves a new commit with **no reaction at all**. Don't spam `@codex review`, but don't trust auto-review either — the monitor below **detects a green, unreviewed head and posts one `@codex review` for it automatically** (see Setup). That is the fix for the recurring failure where the loop stalls silently and only a human poking it ("is it done yet?") unsticks it.
- **If a trigger leaves no Codex reaction at all** (no `eyes`, no `+1`, no reaction on the PR or trigger comment), treat that as a likely code-review quota/capacity failure rather than approval. The self-healing monitor issues exactly one `@codex review` per unreviewed head so the bot can either start (`eyes`) or return an explicit quota/usage message. Do not keep pinging beyond that one automated nudge; if it stays silent, report the loop **blocked, needs a human**.
- **If Codex DOES reply — but with an explicit usage/quota-limit message instead of eyes/review** — that is a different, more definite terminal state than silence, and it can arrive almost immediately after the very first push (a real run got it 29 seconds after push, before any nudge). The monitor detects this reply mechanically and exits the watch itself (`[BLOCKED:QUOTA]`); do not rely on noticing a generic `comment ...` line and deciding to stop on your own — a real deployment sat on exactly that for **3 hours** before a human had to ask "is it done yet?".

## Stopping authority — it's yours, not Codex's

Codex can always surface one more nitpick. If its 👍 is the *only* exit, the loop may never converge — worse, you get baited into **changing things you shouldn't, just to manufacture a commit that re-triggers a review and earns the 👍**. That's an anti-pattern (below). You hold the stopping authority.

**Three legal exits — any one stops the loop:**

1. **Codex 👍** — cleanest, prefer it.
2. **Severity floor reached** — no unresolved **P0**, **no unresolved P1 on the changed path**, *and* no "regression introduced by *your* change" (whatever tag it carries). Everything left is generic refactor / unrelated P1 / pre-existing debt / style nitpick → archive as follow-up issues and close out, **without waiting for the 👍**. (An unrelated P1 outside your change is deferred, not a blocker — matches the precise test and the decision table.)
3. **Round cap (backstop)** — for the pathological case below.

**Floor — the precise test** (tag is the default tier, "is it *your* fault?" is the final verdict):
- Any **P0** unresolved → not at the floor, keep going.
- A **P1** on your change's path, or any-tag finding that is a **regression you introduced** → treat as must-fix, not at the floor.
- Everything else (non-regression P2/P3: generic refactor, pre-existing issues, style) → **don't fix in this PR**, archive it.

**Round cap** — "a round" = one full `codex review → you fix → push` cycle. Set the cap **scaled to the task at hand** (size of the diff, how many files / subsystems it spans, how many findings Codex raised in round one; **default 3**, as low as 1–2 for a tiny change, higher for a large refactor — judge it, don't hardcode one number). When the cap is hit and you're still not at the floor / have no 👍:
- Still an **unresolved P0, an unresolved P1 on the changed path, or a confirmed regression of yours** → **never merge**. Stop and report "loop blocked, needs a human", listing the blockers. This safety gate is welded shut; an explicit merge intent does not override it.
- **Only non-regression nitpicks left** (Codex just keeps re-filing and won't close out) → treat as floor reached, archive everything and close out.

**Why the floor / cap exist (the deadlock)**: if you decline + resolve every non-regression P3 and *don't* push, no new commit means Codex never auto-re-reviews, so the 👍 never comes; and a thread you declined often gets **re-filed verbatim** next round. The floor exit cuts that tug-of-war — once you've judged a finding non-regression and archived it with a paper trail, you close out; you don't manufacture a fix to chase its 👍.

## Setup — arm the monitor

The monitor watches Codex's reviews, fresh inline findings (unresolved review threads), its PR-issue comments (e.g. the quota/usage reply in the no-reaction fallback), the PR's 👍 reaction, and CI — all in **one GraphQL query per cycle**. Do NOT use the per-surface REST version: separate calls for reviews/comments/inline/checks plus an N+1 reactions loop, every 30s, burns the 5000/hr REST quota in minutes and starts 403-ing (observed live). GraphQL has its own point budget and one query covers every surface.

**The monitor must self-heal, not just watch.** Codex's auto-review-on-push is unreliable — it routinely leaves a new commit with no reaction at all. A plain watcher only reports events that *happen*; when Codex stays silent it emits nothing, and **silence is indistinguishable from "still processing"**, so the loop stalls invisibly until a human notices ("is it done yet?"). The script below closes that gap: every cycle it also checks whether the **current head commit is CI-green but unreviewed** — no `eyes`, no 👍, and the latest Codex review timestamp predates the head — and, once a short grace has elapsed, **auto-posts exactly one `@codex review` for that commit**, then records the SHA so it never nudges the same head twice. Reactions are PR-level and sticky, so "has Codex reviewed *this* head?" is decided by the **review timestamp vs the head commit time**, never by a stale 👍. This is the one legitimate `@codex review` automation — bounded to one per unreviewed head, it is not spam.

**The monitor must also self-terminate on a quota block, not just self-heal.** A nudge assumes Codex is merely *behind*; a usage-limit reply means it *cannot* review at all until quota resets — hours away, not another poll cycle. Treating that reply as one more routine `comment ...` line to notice-and-judge cost a real run **3 hours** of silent waiting (on one production PR the quota reply arrived 29 seconds after push, and nobody acted on it until the user asked). So the script also checks every cycle for a Codex PR-issue comment matching the real, observed wording ("usage limits for code reviews" / "codex usage dashboard") and, on a match, prints an unmissable `[BLOCKED:QUOTA]` line and **exits the script** — ending the Monitor watch itself, not leaving a stdout line to be missed.

Use a `persistent: true` Monitor task:

The script lives at `scripts/monitor.sh` inside this skill directory — set `PR`, `OWNER` and `NAME` at the top of that file (or export them and drop that first line), then run it as the Monitor task's command. It emits the event lines documented right below.

Exit / event signals (note: GraphQL login format is inconsistent across fields — `reviews.author.login` / `reviewThreads[].comments[].author.login` / `comments[].author.login` are the bare `chatgpt-codex-connector`, but `reactionGroups[].users.nodes[].login` carries a `[bot]` suffix, `chatgpt-codex-connector[bot]` — confirmed live: a real 👍 reaction sat undetected because an exact-match filter missed it. The reaction check above uses `startswith("chatgpt-codex-connector")` specifically to cover both forms; don't "simplify" it back to an exact match):
- `[new] reaction +1 chatgpt-codex-connector[bot]` → the 👍 approval signal.
- `[new] reaction eyes chatgpt-codex-connector[bot]` → Codex is processing (in-flight); wait — don't push or post a fallback `@codex review`.
- `[new] open-thread <databaseId> chatgpt-codex-connector <path>:<line>` → a fresh Codex finding; the `<databaseId>` is the comment id to plug into the Fix-workflow read/resolve queries.
- `[new] comment chatgpt-codex-connector <text>` → a Codex PR-issue comment (e.g. the quota/usage-limit reply in the no-reaction fallback) — this keeps that fallback path observable.
- `[new] ci <STATE>` → CI rollup changed (`SUCCESS` / `FAILURE` / `PENDING`).
- `[nudge] auto @codex review — head <sha> …` → the self-heal fired: the head was green + unreviewed past the grace, so the monitor asked Codex to review it (once for that SHA). If the following cycles still show no `eyes` / review, the loop is **blocked, needs a human**, not approved; the monitor won't re-nudge the same head, so don't sit waiting on it.
- `[BLOCKED:QUOTA] Codex hit its review usage limit …` → **the monitor has already exited** (this is not a routine `[new]` line — the script detected Codex's usage-limit reply and terminated itself, mechanically, so this is not left for you to notice among ordinary polling output). Stop **immediately, in the same turn**: do not push another commit to re-trigger a review (quota doesn't reset on a retry), do not re-arm the monitor, do not wait out whatever `timeout_ms` you set. Report to the user right away — CI state and unresolved-thread count are unaffected by this, so if the PR is otherwise at the floor (see Stopping authority) and CI is green, surface that as a real option: merge without Codex's verdict is a decision for the user to make, not one to default into silently, and not one to keep the user waiting hours on either (see the incident below).
The jq filters to `chatgpt-codex-connector`(`[bot]`) only, so your own thread replies / reviews never echo back as noise (CI, `[nudge]`, and `[BLOCKED:QUOTA]` are the only unauthored signals).
Poll at 60s; GraphQL's 5000/hr point budget makes one query/cycle effectively free. Tune `GRACE` (default 120s) to how long you'll let a green head sit before nudging — lower it toward 0 to nudge as soon as CI goes green with no `eyes`.

## Decision rules per Codex finding

| Codex tag | Default action |
|---|---|
| **P0** | Fix immediately in this PR. Blocks merge. |
| **P1** | Fix in this PR if it touches the same code path as the original change. Otherwise file a follow-up issue and reply on the thread with the issue link. |
| **P2 / P3** | Default **archive, don't fix**. Correctness regression of *your* change → fix. Generic refactor / pre-existing debt / style nitpick → roll into the follow-up issue, reply with the link, resolve thread, **don't touch it in this PR**. Floor definition: see **Stopping authority**. |
| `eyes` reaction only | Codex is still processing the latest commit. Don't push more changes yet — let it land its verdict. (The monitor won't nudge while `eyes` is in flight.) |
| No Codex reaction after a push | Auto-review is unreliable; a green head with no `eyes`/👍 and no review newer than it is a **stall, not an approval**. The self-healing monitor posts one `@codex review` for that head automatically after `GRACE`. If it still goes silent afterward, report the loop **blocked, needs a human** — don't keep waiting or re-nudging. |
| Codex replies with a usage/quota-limit message | **Terminal — mechanically detected, not left for you to notice.** The monitor matches this reply and **exits itself** (`[BLOCKED:QUOTA]`), whether it arrives from the first push-triggered auto-review or from the self-heal nudge. The moment you see that line, stop and report to the user in the same turn — a stray `@codex review` won't reset the quota, and the block does not resolve within the loop's polling timescale (hours, not another 60s cycle). |

**Tag is the default tier; "is this *your* regression?" is the final verdict** — anything non-regression gets archived, whether tagged P1 or P3. When the loop as a whole should stop, see **Stopping authority**.

**Never** push another commit while a Codex review is in-flight (you'll thrash the loop). Wait for either a new inline comment or the 👍.

## Fix workflow (per Codex finding)

1. Read the full finding text via GraphQL (the truncated monitor line isn't enough; stay on GraphQL so a drained REST quota mid-loop can't block you):
   ```bash
   gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$p){ reviewThreads(first:60){ nodes{ comments(first:1){ nodes{ databaseId path line body } } } } } } }' -f o="$OWNER" -f n="$NAME" -F p="$PR" \
     --jq '.data.repository.pullRequest.reviewThreads.nodes[].comments.nodes[0] | select(.databaseId==<id>) | .body'
   ```
2. **Evaluate** with the table above. If you're fixing, brief the user on what you're about to change before writing code.
3. **TDD**: write the failing test that reproduces the exact case Codex described, verify RED, then implement minimal fix, verify GREEN, then full suite.
4. Commit with a message that references the Codex finding (`fix(...): … addresses Codex review on PR #N (path:line)`).
5. Push to the same PR branch.
6. **Resolve the review thread** via GraphQL — Codex tracks state per thread, leaving it open re-surfaces it in the next review:
   ```bash
   tid=$(gh api graphql -f query='query { repository(owner:"OWNER",name:"REPO") { pullRequest(number:N) { reviewThreads(first:20) { nodes { id isResolved comments(first:1) { nodes { databaseId } } } } } } }' \
     --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | select(.comments.nodes[0].databaseId == <comment_id>) | .id')
   gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"$tid\"}) { thread { isResolved } } }"
   ```
7. Wait for the monitor's next event. The new commit will trigger an automatic `eyes` reaction then a follow-up review.

## Exit condition

The exit is decided by **Stopping authority**'s three content-readiness gates (A/B below) — plus one operational interrupt (C) that isn't about the content at all, but about Codex being unable to render a verdict. Once a gate fires, close out:

**A. Codex 👍** — the monitor emits `[new] reaction +1 chatgpt-codex-connector[bot]` (it reads the PR-level `reactionGroups`, where Codex posts its approval; unlike other fields, `reactionGroups` logins carry a `[bot]` suffix — the reaction filter must match on it, see Setup). Cleanest.

**B. Floor / round-cap reached** — you close out proactively:
1. **Open one aggregate follow-up issue** (not one per nitpick — avoid issue spam): title like `Follow-ups from Codex review on PR #N`, body lists each finding + `path:line` + a short quote of Codex's text, labelled `codex-followup`.
2. For each corresponding review thread: reply with the issue link (state it's **deferred**, not silently dropped) → GraphQL `resolveReviewThread`.
3. Leave one PR summary comment: what was deferred and to which issue.
4. **Report to the user and stop here.**

**C. Quota-blocked (`[BLOCKED:QUOTA]`, the monitor already self-terminated)** — this is neither the 👍 exit nor a floor you judged; Codex simply cannot render a verdict right now, and unlike A/B it is **never** something you decide on your own — it always ends in reporting to the user, never a silent auto-merge:
1. **Report immediately**, in the turn the `[BLOCKED:QUOTA]` line (or the monitor's own completion) appears: what happened, the exact Codex reply, and the PR's current state (CI status, unresolved-thread count — these are unaffected by the quota block and worth surfacing).
2. **Ask, don't assume** — this genuinely has more than one reasonable answer and the user's context (how much they trust this diff, how urgent it is) decides it: merge now without a Codex pass (only if CI is green and the same P0/P1-on-path safety gates below hold, and the user says so), wait for quota to reset and re-run the loop, or have the user eyeball the diff themselves.
3. **Do not re-arm the same monitor to keep waiting** — quota resets are not on this loop's polling timescale; a fresh monitor only makes sense once the user tells you to retry (e.g., after they've upgraded/added credits, or enough time has passed).

**Merging is opt-in, not the default** (applies to gates A and B — gate C always stops at reporting, see above). The skill's applicability only requires authorization to *push commits* — that is **not** authorization to merge. Take the final squash-merge step **only if the user armed the loop with an explicit merge intent** ("merge it once it's done" / "fix it up and merge" / "full-auto merge" / "merge when green"). Otherwise stop after step 3 and hand the merge call back to the user.

**If you do merge (explicit intent given), these safety gates are welded shut — never skipped:**
- **CI all green** (no failing / pending check-runs);
- **no unresolved P0, and no unresolved P1 on the changed path.**
Either one fails → **do not merge**, stop and report.

Then `TaskStop` the monitor (harmless no-op if it already exited itself on `[BLOCKED:QUOTA]`):

```
TaskStop(task_id=<monitor_id>)
```

## Anti-patterns

- ❌ Commenting `@codex review` after every push *by hand* — the monitor already posts one automatically, and only when a green head has actually gone unreviewed past `GRACE`. Manual pinging on top of that is the spam the bot penalizes. (The self-heal's one-nudge-per-head is the sanctioned exception, not a licence to keep pinging.)
- ❌ **Passively waiting on a silent monitor** — the failure this skill was hardened against: sitting idle because "no event arrived," when in fact Codex never reviewed the head and never will without a nudge. The self-healing monitor exists precisely so silence resolves itself; if you ever find yourself wondering "why is it quiet," the head is probably stalled — check `review timestamp vs head time`, don't wait for the user to ask.
- ❌ Pushing a second fix before Codex verdict on the first lands — the bot may attribute its review to the wrong commit.
- ❌ **Changing a nitpick you've already judged "non-regression, archive it" just to earn the 👍** — manufacturing a needless commit to re-trigger a review is feeding the infinite loop. Floor reached → archive and close out, don't push.
- ❌ **Re-evaluating a non-regression finding just because Codex re-filed it next round** — a re-file doesn't make it your regression. Archive it once; subsequent re-files count toward the round cap, not toward another fix.
- ❌ Silently resolving a thread as if you fixed it — if you didn't fix it, the resolve must be preceded by a reply pointing to the follow-up issue (honest archive), never a quiet resolve that pretends it's done.
- ❌ Idling on the 👍 when the floor is already reached (no unresolved P0, no P1 on the changed path, no regression of yours, CI green) — that's the loop that never ends. (The mirror error: don't self-approve a merge with "it's only P3" while a P0 or a P1-on-changed-path is open, or CI is red.)
- ❌ Leaving the monitor running after merge — `TaskStop` it explicitly.
- ❌ Treating `eyes` as approval. It only means "I see new activity"; `+1` is approval.
- ❌ **Sitting on a `[BLOCKED:QUOTA]` line (or an un-noticed quota-limit comment, on an older monitor without this check) as if it were routine polling noise** — it is a terminal state that does not resolve on the loop's timescale. Report to the user in the same turn you see it; don't keep the monitor running, don't push a commit hoping to re-trigger a review, and don't silently decide to merge (or not merge) on the user's behalf — that decision has more than one right answer and is theirs to make.

## Red flags — you're being baited into an endless review

| Your thought | Reality |
|---|---|
| "No 👍 yet, so the loop can't be done." | 👍 isn't the only exit. No unresolved P0, no P1 on the changed path, no regression of yours, CI green = floor reached; you're authorized to archive and close out. |
| "I'll just fix this nitpick and push to trigger a fresh review and get the 👍." | That's changing something you shouldn't, to chase the 👍 — the engine of the infinite loop. Non-regression → archive, don't manufacture a commit. |
| "Codex re-filed this P3, so maybe I should fix it after all." | A re-file doesn't make it a regression. Archive once; the re-file counts toward the round cap. |
| "Everything left is P3, just merge it." | Archive ≠ ignore. Open the follow-up issue for the paper trail. Merging is opt-in: squash-merge **only if the loop was armed with explicit merge intent**, and only with CI green + no unresolved P0/P1-on-path — otherwise stop at archive + report. |
| "The monitor's still running / hasn't said anything new, I'll keep waiting." | Check whether it already printed `[BLOCKED:QUOTA]` and exited — a quota block is a terminal, mechanically-detected state, not something that resolves by waiting longer. If you're on an older monitor without this check, a stray `comment ...` line from Codex mentioning usage limits is the same signal; don't let it blend into routine output. |

## Real-world reference

Pattern was empirically derived running 3 fix iterations on one production PR, each closing one Codex inline finding before the next surfaced.

The **self-healing monitor** (auto-nudge on a green, unreviewed head) was added after the loop repeatedly stalled across two later PRs: Codex kept leaving fix commits with no reaction, the plain watcher stayed silent, and the loop only advanced when the human asked "is it done yet?". Baking stall-detection + one-nudge-per-head into the monitor removed the human from that recovery path.

The **quota-block auto-exit** (`[BLOCKED:QUOTA]`) was added after a real run: Codex replied to the very first push-triggered review with an explicit usage-limit message 29 seconds after push, but the monitor only logged it as a generic `comment ...` line and kept polling for its full timeout — nobody acted on it for 3 hours until the human asked "is it done yet?" again. The failure mode was structurally identical to the earlier stall (a signal present in the output but not mechanically forcing a stop), just on the *reply* side instead of the *silence* side — so it got the same fix: detect it in the script, not the human's attention, and this time exit the watch entirely rather than merely nudging, since there is nothing left for the loop to retry.
