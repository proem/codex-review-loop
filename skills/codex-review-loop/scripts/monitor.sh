#!/usr/bin/env bash
: "${PR:?PR is required}"
: "${OWNER:?OWNER is required}"
: "${NAME:?NAME is required}"
state=""; first=1; last_signal=""; nudged_sha=""; started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; GRACE="${GRACE:-120}"   # seconds a green head may sit unreviewed before we nudge
# Portable epoch: GNU date (Linux) first, BSD date (macOS) fallback.
to_epoch(){ date -u -d "$1" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null || echo 0; }
Q='query($o:String!,$n:String!,$p:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$p){
  reactionGroups{ content users(first:10){ nodes{ login } } }
  reviews(last:8){ nodes{ author{ login } submittedAt commit{ oid } } }
  reviewThreads(first:60){ nodes{ isResolved comments(first:1){ nodes{ databaseId author{ login } path line createdAt } } } }
  comments(last:8){ nodes{ author{ login } body createdAt } }
  commits(last:1){ nodes{ commit{ oid committedDate statusCheckRollup{ state } } } } } } }'
while true; do
  out=$(gh api graphql -f query="$Q" -f o="$OWNER" -f n="$NAME" -F p="$PR" 2>/dev/null || true)
  if [ -n "$out" ]; then
    cur=$(printf '%s' "$out" | jq -r '.data.repository.pullRequest as $pr
      | [$pr.reactionGroups[] | select(.content=="THUMBS_UP" or .content=="EYES") | .content as $c | .users.nodes[] | select(.login | startswith("chatgpt-codex-connector")) | "reaction \(if $c=="THUMBS_UP" then "+1" else "eyes" end) \(.login)"]
      + [$pr.reviews.nodes[] | select(.author.login=="chatgpt-codex-connector") | "review \(.author.login) \(.submittedAt)"]
      + [$pr.reviewThreads.nodes[] | select(.isResolved|not) | .comments.nodes[0] | select(.author.login=="chatgpt-codex-connector") | "open-thread \(.databaseId) \(.author.login) \(.path):\(.line)"]
      + [$pr.comments.nodes[] | select(.author.login=="chatgpt-codex-connector") | "comment chatgpt-codex-connector \(.body[0:120] | gsub("\n";" "))"]
      + ["ci \($pr.commits.nodes[0].commit.statusCheckRollup.state // "PENDING")"]
      | .[]' 2>/dev/null | sort || true)
    signal=$(printf '%s' "$out" | jq -r '.data.repository.pullRequest as $pr | if ([ $pr.reactionGroups[] | select(.content=="THUMBS_UP") | .users.nodes[] | select(.login|startswith("chatgpt-codex-connector")) ] | length) > 0 then "👍" elif ([ $pr.reactionGroups[] | select(.content=="EYES") | .users.nodes[] | select(.login|startswith("chatgpt-codex-connector")) ] | length) > 0 then "👀" elif (([$pr.reviews.nodes[] | select(.author.login=="chatgpt-codex-connector")] | length) > 0 or ([$pr.comments.nodes[] | select(.author.login=="chatgpt-codex-connector")] | length) > 0) then "💬" else "—" end')
    if [ "$signal" != "$last_signal" ]; then
      printf '%s\n' "$(jq -cn --arg signal "$signal" '{type:"signal",signal:$signal}')"
      last_signal="$signal"
    fi
    if [ "$first" = 1 ]; then
      first=0
      # Leave the current head eligible for recovery. The in-flight check below
      # suppresses a duplicate nudge when Codex is already reviewing it.
      nudged_sha=""
      printf '[init] PR #%s self-healing monitor armed (auto-nudges @codex on a green, unreviewed head)\n' "$PR"
    else
      comm -13 <(printf '%s' "$state") <(printf '%s' "$cur") | grep -v '^$' | while IFS= read -r line; do
        printf '[new] %s\n' "$line"
        printf '%s\n' "$(jq -cn --arg detail "$line" '{type:"activity",detail:$detail}')"
      done
    fi
    state="$cur"

    # --- terminal check: Codex replied with an explicit usage/quota-limit message
    # (real wording, confirmed live: "You have reached your Codex usage limits for
    # code reviews... Codex usage dashboard...") instead of eyes/review. This does
    # NOT resolve on the monitor's own timescale — quota resets are hours/a day
    # away, not another 60s poll — so waiting it out (or leaving a human to notice
    # a generic "comment ..." line among routine output) is the wrong shape. A real
    # run sat on exactly this for 3 hours before a human asked "is it done yet?"
    # (a real production PR). Detect it mechanically and EXIT the script — ending
    # the Monitor watch itself is a much harder signal to miss than one more stdout
    # line, and there is nothing more this loop can do until quota resets.
    quotaComment=$(printf '%s' "$out" | jq -r --arg started "$started_at" '[.data.repository.pullRequest.comments.nodes[] | select(.author.login=="chatgpt-codex-connector") | select(.createdAt > $started) | select(.body | test("usage limits for code reviews|codex usage dashboard"; "i"))] | last | .body // empty')
    if [ -n "$quotaComment" ]; then
      quotaMessage="Codex hit its review usage limit — the loop cannot proceed automatically until quota resets. Reply: $(printf '%s' "$quotaComment" | tr '\n' ' ' | cut -c1-200)"
      printf '[BLOCKED:QUOTA] %s\n' "$quotaMessage"
      printf '%s\n' "$(jq -cn --arg message "$quotaMessage" '{type:"quota",message:$message}')"
      exit 0
    fi

    # --- self-heal: latest commit is CI-green but Codex hasn't reviewed it → nudge once ---
    head=$(printf '%s' "$out" | jq -r '.data.repository.pullRequest.commits.nodes[0].commit.oid')
    headTime=$(printf '%s' "$out" | jq -r '.data.repository.pullRequest.commits.nodes[0].commit.committedDate')
    ci=$(printf '%s' "$out" | jq -r '.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.state // "PENDING"')
    eyes=$(printf '%s' "$out" | jq -r '[.data.repository.pullRequest.reactionGroups[] | select(.content=="EYES") | .users.nodes[] | select(.login|startswith("chatgpt-codex-connector"))] | length')
    up=$(printf '%s' "$out" | jq -r '[.data.repository.pullRequest.reactionGroups[] | select(.content=="THUMBS_UP") | .users.nodes[] | select(.login|startswith("chatgpt-codex-connector"))] | length')
    lastReview=$(printf '%s' "$out" | jq -r '[.data.repository.pullRequest.reviews.nodes[] | select(.author.login=="chatgpt-codex-connector") | .submittedAt] | last // ""')
    lastReviewHead=$(printf '%s' "$out" | jq -r '[.data.repository.pullRequest.reviews.nodes[] | select(.author.login=="chatgpt-codex-connector") | .commit.oid // ""] | last // ""')
    lastActivity=$(printf '%s' "$out" | jq -r '[.data.repository.pullRequest.reviews.nodes[] | select(.author.login=="chatgpt-codex-connector") | .submittedAt] + [.data.repository.pullRequest.comments.nodes[] | select(.author.login=="chatgpt-codex-connector") | .createdAt] + [.data.repository.pullRequest.reviewThreads.nodes[] | .comments.nodes[] | select(.author.login=="chatgpt-codex-connector") | .createdAt] | map(select(. != null and . != "")) | sort | last // ""' )
    in_flight=0
    if [ "$eyes" -gt 0 ] && [ -n "$lastActivity" ] && [[ "$lastActivity" > "$headTime" ]] && [ "$lastReviewHead" != "$head" ]; then
      in_flight=1
    fi
    elapsed=$(( $(date -u +%s) - $(to_epoch "$headTime") ))
    if [ "$ci" = "SUCCESS" ] && [ "$nudged_sha" != "$head" ] && [ "$elapsed" -ge "$GRACE" ] && [ "$lastReviewHead" != "$head" ] && [ "$in_flight" -eq 0 ] && { [ -z "$lastReview" ] || [[ "$headTime" > "$lastReview" ]]; }; then
      if [ -n "${GH_REPO:-}" ]; then
        gh pr comment "$PR" --repo "$GH_REPO" --body "@codex review" >/dev/null 2>&1
      else
        gh pr comment "$PR" --body "@codex review" >/dev/null 2>&1
      fi
      if [ $? -eq 0 ]; then
        nudged_sha="$head"
        nudgeDetail="auto @codex review — head ${head:0:8} green + unreviewed ${elapsed}s (no eyes/👍, newer than last review '${lastReview}')"
        printf '[nudge] %s\n' "$nudgeDetail"
        printf '%s\n' "$(jq -cn --arg detail "$nudgeDetail" '{type:"activity",detail:$detail}')"
      fi
    fi
  fi
  sleep 60
done
