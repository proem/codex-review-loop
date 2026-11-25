---
name: codex-review-loop
description: "Handle Codex GitHub PR review comments: monitor Codex findings, make justified fixes, resolve or defer threads, and stop safely instead of chasing endless nitpicks. Use when the user asks to watch Codex review, iterate on Codex PR feedback, or keep an eye on a PR and fix Codex findings. Also use to wait for Codex approval. Supports Pi, Claude Code, Codex CLI, and other host agents."
---

# Codex GitHub Review Loop

Handle Codex review comments on a GitHub PR. Monitor Codex findings, make justified fixes, and resolve or defer threads. **Stop at a safe point**: Codex's 👍, or a severity floor you judge. At the floor only non-regression nitpicks remain. Archive them as follow-ups and close out. Stopping authority is yours, not Codex's.

## When this applies

This workflow applies to Codex GitHub PR reviews only. The default monitor and protocol below target the Codex GitHub connector.

### Mandatory prerequisite: install the Codex GitHub App

Before starting the workflow, the target GitHub account or organization **must have the ChatGPT Codex Connector installed and authorized for the target repository**:

[Install ChatGPT Codex Connector](https://github.com/apps/chatgpt-codex-connector)

In the GitHub App installation flow, choose the target account or organization. Select **Only select repositories**, and grant access to the repository being reviewed. A posted `@codex review` comment is not proof that the App is installed. Any user can post that comment even when Codex has no access.

Verify the prerequisite before starting the monitor:

```bash
gh api repos/<owner>/<repo>/installation
```

If this command returns an authorization or installation error, stop and report that the Codex GitHub App is not available for this repository. If a test `@codex review` produces no `chatgpt-codex-connector[bot]` reaction, review, or comment, stop and report the same. Do not keep posting repeated trigger comments.

- The repo has `chatgpt-codex-connector[bot]` configured. Check `gh api repos/<owner>/<repo>/pulls/$PR/reviews` for prior reviews from that user.
- The PR is open and the user wants Codex to gate the merge.
- The user has authorized you to push commits to the PR branch.

## Main workflow (agent-neutral host layer)

This workflow is host-agent neutral. Use it with Pi, Claude Code, Codex CLI, or another agent. Agent-specific execution details are optional conveniences only.

1. Establish the repository, PR, head branch, Codex reviewer identity, changed paths, CI requirements, and push or merge authorization.
2. Verify the mandatory Codex GitHub App installation and repository authorization. Then verify GitHub authentication, `gh`, `jq`, the monitor, and reviewer availability. Stop and report missing prerequisites.
3. Record the baseline head SHA, CI state, existing reviews, unresolved threads, and latest reviewer activity. An old approval or quiet monitor is not approval for a new head.
4. Start one Codex monitor. It must observe Codex reviews, unresolved findings, Codex comments, approval signals, CI, and terminal errors such as quota blocks.
5. Wait while the reviewer processes the current head. Do not push during an in-flight review.
6. Read and triage every finding. Judge severity, changed-path relevance, regression ownership, and actionability.
7. Fix only justified findings. Reproduce with a focused test when practical. Make the smallest correct change, verify it, and commit with traceability. Push once, then wait for the next review.
8. **Close every review round completely.** After each new Codex review, enumerate every unresolved thread. For each actionable finding, fix it, verify it, and push the fix. Then mark that exact thread resolved. Do not stop after resolving an earlier round. A later review can create new unresolved threads.
9. Archive deferred findings honestly. Use one aggregate follow-up issue when needed, reply with its link and rationale, then resolve the deferred thread.
10. Stop on reviewer approval, the severity floor, a scaled round cap, an operational block, or a human decision. A round cap never overrides a critical finding or confirmed regression.
11. Report the final head SHA, CI state, blockers, deferred findings, monitor state, and merge eligibility. Merge only with explicit user authorization and passing safety gates. Stop and clean up the monitor.

The agent owns triage and stopping decisions. Reviewer labels and approval signals are evidence, not authority.

### Mandatory review-round closeout

Before you report the loop complete, run a fresh query for all Codex review threads. Verify that every thread is resolved or explicitly archived with a rationale. A new commit can trigger a new Codex review and create new threads. Those findings belong to the new round, and you must process them before completion. Never report “fixed” or “done” based only on the previous round's threads.

For every thread fixed in the current round, the required order is:

```text
read finding → make fix → run verification → push commit → resolve exact thread → query again
```

If the new query shows unresolved Codex threads, the workflow remains open. Continue the loop or report the exact blocker. Do not leave newly generated actionable comments unresolved.

## The Codex protocol (default reviewer implementation)

- Codex auto-reviews on PR open, draft→ready transitions, new commits to the head branch, or `@codex review` comments.
- While processing it leaves an `eyes` reaction on the PR issue.
- **If it has suggestions** → it posts a review with inline comments tagged P0 / P1 / P2 / P3.
- **If it has nothing to add** → it reacts with `+1` (👍) — that's the approval signal.
- Each new push to the PR head normally re-triggers a review automatically. **In practice this is unreliable** (quota / capacity / flakiness): Codex routinely leaves a new commit with **no reaction at all**. Do not spam `@codex review`, and do not trust auto-review. The monitor below **detects a green, unreviewed head and posts one `@codex review` for it automatically** (see Setup). That is the fix for the recurring failure where the loop stalls silently. Only a human poking it ("is it done yet?") unsticks that stall.
- **If a trigger leaves no Codex reaction at all** (no `eyes`, no `+1`, no reaction on the PR or trigger comment), treat that as a likely code-review quota/capacity failure. Do not treat it as approval. The self-healing monitor issues exactly one `@codex review` per unreviewed head. The bot can then start (`eyes`) or return an explicit quota/usage message. Do not keep pinging beyond that one automated nudge. If it stays silent, report the loop **blocked, needs a human**.
- **If Codex DOES reply with an explicit usage/quota-limit message** instead of eyes/review, that is a terminal state, different from silence and more definite. It can arrive almost immediately after the very first push: a real run got it 29 seconds after push, before any nudge. The monitor detects this reply mechanically and exits the watch itself (`[BLOCKED:QUOTA]`). Do not rely on noticing a generic `comment ...` line and deciding to stop on your own. A real deployment sat on exactly that for **3 hours**, until a human had to ask "is it done yet?".

## Stopping authority — it's yours, not Codex's

Codex can always surface one more nitpick. If its 👍 is the *only* exit, the loop may never converge. Worse, you get baited into **changing things you must not change, just to manufacture a commit that re-triggers a review and earns the 👍**. That is an anti-pattern (below). You hold the stopping authority.

**Three legal exits — any one stops the loop:**

1. **Codex 👍** — cleanest, prefer it.
2. **Severity floor reached** — no unresolved **P0**, **no unresolved P1 on the changed path**, *and* no "regression introduced by *your* change", whatever tag it carries. Everything left is a generic refactor, an unrelated P1, pre-existing debt, or a style nitpick. Archive those as follow-up issues and close out, **without waiting for the 👍**. An unrelated P1 outside your change is deferred, not a blocker. This matches the precise test and the decision table.
3. **Round cap (backstop)** — for the pathological case below.

**Floor — the precise test** (tag is the default tier, "is it *your* fault?" is the final verdict):
- Any **P0** unresolved → not at the floor, keep going.
- A **P1** on your change's path, or any-tag finding that is a **regression you introduced** → treat as must-fix, not at the floor.
- Everything else (non-regression P2/P3: generic refactor, pre-existing issues, style): **do not fix it in this PR**, archive it.

**Round cap**: "a round" is one full `codex review → you fix → push` cycle. Set the cap **scaled to the task at hand**: the size of the diff, how many files or subsystems it spans, and how many findings Codex raised in round one. **The default is 3**: as low as 1–2 for a tiny change, higher for a large refactor. Judge it; do not hardcode one number. When the cap is hit and you are still not at the floor, or have no 👍:
- Still an **unresolved P0, an unresolved P1 on the changed path, or a confirmed regression of yours** → **never merge**. Stop and report "loop blocked, needs a human", listing the blockers. This safety gate is welded shut; an explicit merge intent does not override it.
- **Only non-regression nitpicks left** (Codex just keeps re-filing and won't close out) → treat as floor reached, archive everything and close out.

**Why the floor and cap exist (the deadlock)**: you decline and resolve every non-regression P3 without a push. No new commit means Codex never auto-re-reviews, so the 👍 never comes. A thread you declined often gets **re-filed verbatim** next round. The floor exit cuts that tug-of-war. Once you have judged a finding non-regression and archived it with a paper trail, you close out. You do not manufacture a fix to chase its 👍.

## Setup — arm the Codex monitor

The monitor watches five things in **one GraphQL query per cycle**: Codex's reviews, fresh inline findings (unresolved review threads), its PR-issue comments (e.g. the quota/usage reply in the no-reaction fallback), the PR's 👍 reaction, and CI. Do NOT use the per-surface REST version. Separate calls for reviews/comments/inline/checks, plus an N+1 reactions loop every 30s, burn the 5000/hr REST quota in minutes and start 403-ing (observed live). GraphQL has its own point budget, and one query covers every surface.

**The monitor must self-heal, not just watch.** Codex's auto-review-on-push is unreliable. It routinely leaves a new commit with no reaction at all. A plain watcher only reports events that *happen*. When Codex stays silent, it emits nothing, and **silence is indistinguishable from "still processing"**. So the loop stalls invisibly, until a human notices ("is it done yet?"). The script below closes that gap. Every cycle it also checks whether the **current head commit is CI-green but unreviewed**: no `eyes`, no 👍, and the latest Codex review timestamp predates the head. Once a short grace has elapsed, it **auto-posts exactly one `@codex review` for that commit**. It then records the SHA, so it never nudges the same head twice. Reactions are PR-level and sticky. So "has Codex reviewed *this* head?" is decided by the **review timestamp vs the head commit time**, never by a stale 👍. This is the one legitimate `@codex review` automation. Bounded to one per unreviewed head, it is not spam.

**The monitor must also self-terminate on a quota block, not just self-heal.** A nudge assumes Codex is merely *behind*. A usage-limit reply means it *cannot* review at all until quota resets, which is hours away, not another poll cycle. Treating that reply as one more routine `comment ...` line cost a real run **3 hours** of silent waiting. On one production PR the quota reply arrived 29 seconds after push, and nobody acted on it until the user asked. The script also checks every cycle for a Codex PR-issue comment that matches the real, observed wording: "usage limits for code reviews" / "codex usage dashboard". On a match, it prints an unmissable `[BLOCKED:QUOTA]` line and **exits the script**. That ends the Monitor watch itself, and does not leave a stdout line to be missed.

## Agent integrations (nice to have)

The workflow above is the source of truth. These sections only describe convenient ways to run the monitor in specific hosts.

### Pi

Pi does not provide Claude Code's `persistent: true` Monitor task. Run the
bundled script as a separate background process and redirect its output to a
log file that Pi can read:

```bash
skill_dir="<skill-directory>"
state_dir="${TMPDIR:-/tmp}/codex-review-loop-pr-123"
mkdir -p "$state_dir"

PR=123 OWNER=acme NAME=widgets \
  nohup bash "$skill_dir/scripts/monitor.sh" \
  > "$state_dir/monitor.log" 2>&1 &

echo $! > "$state_dir/monitor.pid"
```

Replace the example PR, owner, repository, and skill directory values. The
monitor emits the event lines documented below. Read `monitor.log` after
startup and after each relevant event. No new output is not an approval
signal.

On Windows, run this command in Git Bash or WSL. The script requires Bash,
`gh`, `jq`, and process substitution.

### Claude Code

Use a persistent background task or shell process if available. Keep the same
monitor log, event handling, stopping gates, and cleanup rules. Do not treat a
Claude Code task's continued existence as evidence that the reviewer is still
working. Inspect the reviewer's timestamps and the monitor output.

### Codex CLI

Run the monitor as a separate shell process or through the CLI's background
command facility. Keep the monitor PID and log path in the session context.
The Codex CLI driving this workflow is the host agent. The GitHub Codex
connector being monitored is a separate reviewer. Do not confuse it
with the host agent.

### Other agents

Use the same `monitor.sh` contract when the agent can run Bash, `gh`, and
`jq`. Otherwise implement an equivalent watcher that preserves the event
contract and bounded one-nudge-per-head behavior. Do not weaken the stopping
gates to fit a host-specific task API.

Exit / event signals. Note that the GraphQL login format is inconsistent across fields. `reviews.author.login` / `reviewThreads[].comments[].author.login` / `comments[].author.login` are the bare `chatgpt-codex-connector`. `reactionGroups[].users.nodes[].login` carries a `[bot]` suffix, `chatgpt-codex-connector[bot]`. This is confirmed live: a real 👍 reaction sat undetected because an exact-match filter missed it. The reaction check above uses `startswith("chatgpt-codex-connector")` specifically to cover both forms. Do not "simplify" it back to an exact match:
- `[new] reaction +1 chatgpt-codex-connector[bot]` → the 👍 approval signal.
- `[new] reaction eyes chatgpt-codex-connector[bot]` → Codex is processing (in-flight). Wait. Do not push, and do not post a fallback `@codex review`.
- `[new] open-thread <databaseId> chatgpt-codex-connector <path>:<line>` → a fresh Codex finding. The `<databaseId>` is the comment id to plug into the Fix-workflow read/resolve queries.
- `[new] comment chatgpt-codex-connector <text>` → a Codex PR-issue comment (e.g. the quota/usage-limit reply in the no-reaction fallback). This keeps that fallback path observable.
- `[new] ci <STATE>` → CI rollup changed (`SUCCESS` / `FAILURE` / `PENDING`).
- `[nudge] auto @codex review — head <sha> …` → the self-heal fired. The head was green and unreviewed past the grace, so the monitor asked Codex to review it, once for that SHA. If the following cycles still show no `eyes` or review, the loop is **blocked, needs a human**, not approved. The monitor won't re-nudge the same head, so do not sit waiting on it.
- `[BLOCKED:QUOTA] Codex hit its review usage limit …` → **the monitor has already exited**. This is not a routine `[new]` line: the script detected Codex's usage-limit reply and terminated itself mechanically, so this is not left for you to notice among ordinary polling output. Stop **immediately, in the same turn**. Do not push another commit to re-trigger a review (quota doesn't reset on a retry). Do not re-arm the monitor. Do not wait out whatever `timeout_ms` you set. Report to the user right away. CI state and unresolved-thread count are unaffected by this. If the PR is otherwise at the floor (see Stopping authority) and CI is green, surface that as a real option. A merge without Codex's verdict is a decision for the user to make. Do not default into it silently, and do not keep the user waiting hours on either (see the incident below).
The jq filters to `chatgpt-codex-connector`(`[bot]`) only, so your own thread replies and reviews never echo back as noise. CI, `[nudge]`, and `[BLOCKED:QUOTA]` are the only unauthored signals.
Poll at 60s. GraphQL's 5000/hr point budget makes one query/cycle effectively free. Tune `GRACE` (default 120s) to how long you will let a green head sit before nudging. Lower it toward 0 to nudge as soon as CI goes green with no `eyes`.

## Decision rules per Codex finding

| Codex tag | Default action |
|---|---|
| **P0** | Fix immediately in this PR. Blocks merge. |
| **P1** | Fix in this PR if it touches the same code path as the original change. Otherwise file a follow-up issue and reply on the thread with the issue link. |
| **P2 / P3** | Default **archive, don't fix**. Correctness regression of *your* change → fix. Generic refactor / pre-existing debt / style nitpick → roll into the follow-up issue, reply with the link, resolve thread, **don't touch it in this PR**. Floor definition: see **Stopping authority**. |
| `eyes` reaction only | Codex is still processing the latest commit. Don't push more changes yet — let it land its verdict. (The monitor won't nudge while `eyes` is in flight.) |
| No Codex reaction after a push | Auto-review is unreliable; a green head with no `eyes`/👍 and no review newer than it is a **stall, not an approval**. The self-healing monitor posts one `@codex review` for that head automatically after `GRACE`. If it still goes silent afterward, report the loop **blocked, needs a human** — don't keep waiting or re-nudging. |
| Codex replies with a usage/quota-limit message | **Terminal — mechanically detected, not left for you to notice.** The monitor matches this reply and **exits itself** (`[BLOCKED:QUOTA]`), whether it arrives from the first push-triggered auto-review or from the self-heal nudge. The moment you see that line, stop and report to the user in the same turn — a stray `@codex review` won't reset the quota, and the block does not resolve within the loop's polling timescale (hours, not another 60s cycle). |

**Tag is the default tier; "is this *your* regression?" is the final verdict.** Anything non-regression gets archived, whether tagged P1 or P3. For the stopping point of the whole loop, see **Stopping authority**.

**Never** push another commit while a Codex review is in-flight (you'll thrash the loop). Wait for either a new inline comment or the 👍.

## Fix workflow (per Codex finding)

1. Read the full finding text via GraphQL. The truncated monitor line is not enough. Stay on GraphQL, so a drained REST quota mid-loop cannot block you:
   ```bash
   gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$p){ reviewThreads(first:60){ nodes{ comments(first:1){ nodes{ databaseId path line body } } } } } } }' -f o="$OWNER" -f n="$NAME" -F p="$PR" \
     --jq '.data.repository.pullRequest.reviewThreads.nodes[].comments.nodes[0] | select(.databaseId==<id>) | .body'
   ```
2. **Evaluate** with the table above. If you're fixing, brief the user on what you're about to change before writing code.
3. **TDD**: write the failing test that reproduces the exact case Codex described. Verify RED, implement the minimal fix, verify GREEN, then run the full suite.
4. Commit with a message that references the Codex finding (`fix(...): … addresses Codex review on PR #N (path:line)`).
5. Push to the same PR branch.
6. **Resolve the review thread** via GraphQL. Codex tracks state per thread, and an open thread re-surfaces in the next review:
   ```bash
   tid=$(gh api graphql -f query='query { repository(owner:"OWNER",name:"REPO") { pullRequest(number:N) { reviewThreads(first:20) { nodes { id isResolved comments(first:1) { nodes { databaseId } } } } } } }' \
     --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | select(.comments.nodes[0].databaseId == <comment_id>) | .id')
   gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"$tid\"}) { thread { isResolved } } }"
   ```
7. Wait for the monitor's next event. The new commit will trigger an automatic `eyes` reaction, then a follow-up review.

## Exit condition

**Stopping authority** decides the exit, through its three content-readiness gates (A and B below). There is also one operational interrupt (C). It is not about the content at all; it is about Codex being unable to render a verdict. Once a gate fires, close out:

**A. Codex 👍** — the monitor emits `[new] reaction +1 chatgpt-codex-connector[bot]`. It reads the PR-level `reactionGroups`, where Codex posts its approval. Unlike other fields, `reactionGroups` logins carry a `[bot]` suffix, so the reaction filter must match on it (see Setup). This is the cleanest exit.

**B. Floor / round-cap reached** — you close out proactively:
1. **Open one aggregate follow-up issue**, not one per nitpick, to avoid issue spam. Use a title like `Follow-ups from Codex review on PR #N`. In the body, list each finding with `path:line` and a short quote of Codex's text. Label it `codex-followup`.
2. For each corresponding review thread: reply with the issue link (state it's **deferred**, not silently dropped) → GraphQL `resolveReviewThread`.
3. Leave one PR summary comment: what was deferred and to which issue.
4. **Report to the user and stop here.**

**C. Quota-blocked (`[BLOCKED:QUOTA]`, the monitor already self-terminated)** — this is neither the 👍 exit nor a floor you judged. Codex simply cannot render a verdict right now. Unlike A and B, this is **never** something you decide on your own. It always ends in reporting to the user, never a silent auto-merge:
1. **Report immediately**, in the turn the `[BLOCKED:QUOTA]` line appears, or the monitor's own completion. State what happened, the exact Codex reply, and the PR's current state: CI status and unresolved-thread count. The quota block does not affect those two, and they are worth surfacing.
2. **Ask, do not assume.** This has more than one reasonable answer, and the user's context decides it: how much they trust this diff, and how urgent it is. The options are three. Merge now without a Codex pass, but only if CI is green, the same P0/P1-on-path safety gates below hold, and the user says so. Or wait for quota to reset, then re-run the loop. Or have the user eyeball the diff.
3. **Do not re-arm the same monitor to keep waiting.** Quota resets are not on this loop's polling timescale. A fresh monitor makes sense only once the user tells you to retry, e.g. after they upgraded or added credits, or enough time has passed.

**Merging is opt-in, not the default.** This applies to gates A and B; gate C always stops at reporting (see above). The skill's applicability only requires authorization to *push commits*. That is **not** authorization to merge. Take the final squash-merge step **only if the user armed the loop with an explicit merge intent**, e.g. ("merge it once it's done" / "fix it up and merge" / "full-auto merge" / "merge when green"). Otherwise stop after step 3 and hand the merge call back to the user.

**If you do merge (explicit intent given), these safety gates are welded shut — never skipped:**
- **CI all green** (no failing / pending check-runs);
- **no unresolved P0, and no unresolved P1 on the changed path.**
Either one fails → **do not merge**, stop and report.

Then stop the monitor process (harmless no-op if it already exited itself
on `[BLOCKED:QUOTA]`):

```bash
if [ -f "$state_dir/monitor.pid" ]; then
  kill "$(cat "$state_dir/monitor.pid")" 2>/dev/null || true
  rm -f "$state_dir/monitor.pid"
fi
```

## Anti-patterns

- ❌ Commenting `@codex review` after every push *by hand*. The monitor already posts one automatically, and only when a green head has actually gone unreviewed past `GRACE`. Manual pinging on top of that is the spam the bot penalizes. The self-heal's one-nudge-per-head is the sanctioned exception, not a licence to keep pinging.
- ❌ **Passively waiting on a silent monitor**. This is the failure this skill was hardened against: sitting idle because "no event arrived", when Codex never reviewed the head and never will without a nudge. The self-healing monitor exists so silence resolves itself. If you wonder "why is it quiet", the head is probably stalled. Check `review timestamp vs head time`; do not wait for the user to ask.
- ❌ Pushing a second fix before Codex verdict on the first lands. The bot may attribute its review to the wrong commit.
- ❌ **Changing a nitpick you already judged "non-regression, archive it" just to earn the 👍**. Manufacturing a needless commit to re-trigger a review feeds the infinite loop. Floor reached → archive and close out, do not push.
- ❌ **Re-evaluating a non-regression finding just because Codex re-filed it next round**. A re-file does not make it your regression. Archive it once; later re-files count toward the round cap, not toward another fix.
- ❌ Silently resolving a thread as if you fixed it. If you did not fix it, the resolve must be preceded by a reply that points to the follow-up issue (honest archive). Never a quiet resolve that pretends it is done.
- ❌ Idling on the 👍 when the floor is already reached (no unresolved P0, no P1 on the changed path, no regression of yours, CI green). That is the loop that never ends. The mirror error: do not self-approve a merge with "it's only P3" while a P0 or a P1-on-changed-path is open, or CI is red.
- ❌ Leaving the monitor running after merge. Stop the background process and remove its PID file explicitly.
- ❌ Treating `eyes` as approval. It only means "I see new activity"; `+1` is approval.
- ❌ **Sitting on a `[BLOCKED:QUOTA]` line as if it were routine polling noise**, or on an un-noticed quota-limit comment from an older monitor without this check. It is a terminal state that does not resolve on the loop's timescale. Report to the user in the same turn you see it. Do not keep the monitor running. Do not push a commit hoping to re-trigger a review. Do not silently decide to merge or not merge on the user's behalf. That decision has more than one right answer, and it is theirs to make.

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

The **self-healing monitor** (auto-nudge on a green, unreviewed head) was added after the loop repeatedly stalled across two later PRs. Codex kept leaving fix commits with no reaction, and the plain watcher stayed silent. The loop only advanced when the human asked "is it done yet?". Baking stall detection and one-nudge-per-head into the monitor removed the human from that recovery path.

The **quota-block auto-exit** (`[BLOCKED:QUOTA]`) was added after a real run. Codex replied to the very first push-triggered review with an explicit usage-limit message 29 seconds after push. The monitor only logged it as a generic `comment ...` line and kept polling for its full timeout. Nobody acted on it for 3 hours, until the human asked "is it done yet?" again. The failure mode was structurally identical to the earlier stall: a signal present in the output, but not mechanically forcing a stop. Here it was on the *reply* side instead of the *silence* side. So it got the same fix: detect it in the script, not in the human's attention. This time the script exits the watch entirely rather than merely nudging, because there is nothing left for the loop to retry.
