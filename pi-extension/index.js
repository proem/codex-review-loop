import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MONITOR_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/codex-review-loop/scripts/monitor.sh");
const REVIEWER = "chatgpt-codex-connector[bot]";
const STATUS_KEY = "zz-codex-review-loop";

function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function parsePullRequestUrl(value) {
  const match = String(value || "").match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  return match ? { owner: match[1], name: match[2], pr: match[3] } : null;
}

function parseCommand(text) {
  const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
  const [action = "status", ...rest] = parts;
  if (!["start", "stop", "status"].includes(action)) return { action: "invalid", value: action };
  const repoFlag = rest.indexOf("--repo");
  const repo = repoFlag >= 0 ? rest[repoFlag + 1] || "" : "";
  const positional = repoFlag >= 0 ? rest.filter((_part, index) => index !== repoFlag && index !== repoFlag + 1) : rest;
  const reference = parsePullRequestUrl(positional[0]);
  return reference ? { action, ...reference, repo } : { action, pr: positional[0] || "", repo };
}

function statePath(cwd, pr) {
  const key = createHash("sha256").update(`${cwd}\0${pr}`).digest("hex").slice(0, 16);
  return join(tmpdir(), `pi-codex-review-loop-${key}.json`);
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function validatePrIdentifier(value) {
  return /^(?:[1-9]\d*)$/.test(String(value || ""));
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function removeState(path) {
  try { unlinkSync(path); } catch { /* already stopped */ }
}

function normalizePath(value) {
  return resolve(String(value || "")).replaceAll("\\", "/").toLowerCase();
}

function findPersistedState(cwd, repository) {
  try {
    const normalizedCwd = normalizePath(cwd);
    return readdirSync(tmpdir())
      .filter((name) => name.startsWith("pi-codex-review-loop-") && name.endsWith(".json"))
      .map((name) => join(tmpdir(), name))
      .map((path) => ({ path, state: readState(path) }))
      .filter(({ state }) => state && processAlive(state.pid)
        && (normalizePath(state.cwd) === normalizedCwd
          || (repository && state.owner === repository.owner && state.name === repository.name)))
      .sort((a, b) => (b.state.startedAt || "").localeCompare(a.state.startedAt || ""))[0]?.state || null;
  } catch {
    return null;
  }
}

function notify(ctx, message, level = "info") {
  ctx?.ui?.notify?.(message, level);
}

function hyperlink(label, url) {
  if (!url) return label;
  return `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\`;
}

function syncStatus(ctx, state) {
  if (!state) {
    ctx?.ui?.setStatus?.(STATUS_KEY, undefined);
    return;
  }
  const label = `${state.owner}/${state.name}#${state.pr}`;
  const link = hyperlink(label, state.url);
  const signal = state.codexSignal || "—";
  ctx?.ui?.setStatus?.(STATUS_KEY, `Codex ${signal} · ${link}`);
}

async function readCodexSignal(state) {
  const query = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reactionGroups{content users(first:20){nodes{login}}} reviews(last:20){nodes{author{login} state submittedAt}} comments(last:20){nodes{author{login} createdAt}}}}}`;
  const { stdout } = await run("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `o=${state.owner}`, "-f", `n=${state.name}`, "-F", `p=${state.pr}`], { cwd: state.cwd });
  const pr = JSON.parse(stdout).data.repository.pullRequest;
  const fromCodex = (login) => login?.startsWith("chatgpt-codex-connector");
  const reaction = (content) => pr.reactionGroups.some((group) => group.content === content && group.users.nodes.some((user) => fromCodex(user.login)));
  const reviews = pr.reviews.nodes.filter((review) => fromCodex(review.author?.login));
  const comments = pr.comments.nodes.filter((comment) => fromCodex(comment.author?.login));
  let signal = "—";
  if (reaction("THUMBS_UP")) signal = "👍";
  else if (reaction("EYES")) signal = "👀";
  else if (reviews.length || comments.length) signal = "💬";
  const activity = [...reviews.map((review) => review.submittedAt), ...comments.map((comment) => comment.createdAt)].sort().at(-1) || "";
  return { signal, activity };
}

async function assertGitRepository(cwd) {
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim() || cwd;
  } catch {
    throw new Error(`Current directory is not a Git repository: ${cwd}. Open Pi in the target repository, or use /codex-review-loop start [PR] --repo C:/path/to/repository.`);
  }
}

async function resolvePullRequest(cwd, requested) {
  if (requested) return requested;
  const { stdout } = await run("gh", ["pr", "view", "--json", "number", "--jq", ".number"], { cwd });
  const pr = stdout.trim();
  if (!pr) throw new Error("No open pull request found for the current branch.");
  return pr;
}

async function resolveRepository(cwd) {
  const { stdout } = await run("gh", ["repo", "view", "--json", "owner,name", "--jq", ".owner.login + \"/\" + .name"], { cwd });
  const [owner, name] = stdout.trim().split("/");
  if (!owner || !name) throw new Error("Could not determine the GitHub repository.");
  return { owner, name };
}

function stopState(state, path) {
  if (state && processAlive(state.pid)) {
    try { process.kill(state.pid, "SIGTERM"); } catch { /* exited between the check and kill */ }
  }
  removeState(path);
}

export { hyperlink, normalizePath, parseCommand, processAlive, readState, statePath, validatePrIdentifier };

export default function codexReviewLoopExtension(pi) {
  let active = null;
  let logWatcher = null;
  let signalWatcher = null;

  const status = (ctx) => {
    if (!active) return null;
    if (!processAlive(active.pid)) {
      active = { ...active, status: "stopped" };
      syncStatus(ctx, active);
      return active;
    }
    return active;
  };

  const stopLogWatcher = () => {
    if (logWatcher) clearInterval(logWatcher);
    if (signalWatcher) clearInterval(signalWatcher);
    logWatcher = null;
    signalWatcher = null;
  };

  const startLogWatcher = (state, ctx) => {
    stopLogWatcher();
    let offset = Number.isInteger(state.logOffset) ? state.logOffset : 0;
    const refreshSignal = async () => {
      try {
        const previousSignal = state.codexSignal;
        const previousActivity = state.codexActivity;
        const result = await readCodexSignal(state);
        state.codexSignal = result.signal;
        state.codexActivity = result.activity;
        saveState(state.statePath, state);
        syncStatus(ctx, state);
        if (result.activity && (result.activity !== previousActivity || (!previousSignal && result.signal !== "—"))) {
          const message = `[Codex review loop] New Codex activity on ${state.owner}/${state.name}#${state.pr}: ${result.signal}. Inspect the latest GitHub review and act on justified findings.`;
          notify(ctx, message, "info");
          pi.sendUserMessage(message, { deliverAs: "followUp" });
        }
      } catch {
        // Keep the last known signal while GitHub is temporarily unavailable.
      }
    };
    refreshSignal();
    logWatcher = setInterval(() => {
      try {
        const size = statSync(state.log).size;
        if (size < offset) offset = 0;
        if (size === offset) {
          if (!processAlive(state.pid)) {
            stopLogWatcher();
            notify(ctx, `Codex monitor stopped for ${state.owner}/${state.name}#${state.pr}.`, "warning");
          }
          return;
        }
        const content = readFileSync(state.log);
        const lines = content.subarray(offset).toString("utf8").split(/\r?\n/).filter(Boolean);
        offset = content.length;
        state.logOffset = offset;
        saveState(state.statePath, state);
        for (const line of lines) {
          if (!/^\[(new|nudge|BLOCKED:QUOTA)\]/.test(line)) continue;
          const message = `[Codex review loop] ${state.owner}/${state.name}#${state.pr}: ${line}`;
          notify(ctx, message, line.startsWith("[BLOCKED") ? "error" : "info");
          pi.sendUserMessage(message, { deliverAs: "followUp" });
        }
      } catch {
        // The monitor may exit while its log is being rotated or cleaned up.
      }
    }, 1000);
    signalWatcher = setInterval(refreshSignal, 5000);
  };

  pi.registerCommand("codex-review-loop", {
    description: "Start, stop, or inspect the Codex GitHub PR review monitor",
    handler: async (args, ctx) => {
      const parsed = parseCommand(args);
      if (parsed.action === "invalid") {
        notify(ctx, "Usage: /codex-review-loop start [PR] | status | stop", "warning");
        return;
      }

      const cwd = parsed.repo || ctx.cwd || process.cwd();
      if (parsed.action === "status") {
        const current = status(ctx);
        if (!current) {
          notify(ctx, "Codex monitor: stopped", "info");
          return;
        }
        notify(ctx, `Codex monitor: ${current.status} (PR #${current.pr}, PID ${current.pid})\nLog: ${current.log}`, "info");
        return;
      }

      if (parsed.action === "stop") {
        if (active) {
          stopState(active, active.statePath);
          active = null;
          syncStatus(ctx, null);
          pi.appendEntry("codex-review-loop", { action: "stop" });
          stopLogWatcher();
          notify(ctx, "Codex monitor stopped.", "info");
        } else {
          notify(ctx, "No Codex monitor is running in this session.", "info");
        }
        return;
      }

      if (active && processAlive(active.pid)) {
        notify(ctx, `Codex monitor is already running for PR #${active.pr}.`, "warning");
        return;
      }

      try {
        const hasGithubReference = parsed.owner && parsed.name && parsed.pr;
        const repoCwd = hasGithubReference || parsed.repo ? cwd : await assertGitRepository(cwd);
        const pr = parsed.pr || await resolvePullRequest(repoCwd, parsed.pr);
        if (!validatePrIdentifier(pr)) throw new Error(`Invalid pull request number: ${pr}`);
        const { stdout: prCheck } = await run("gh", ["pr", "view", pr, "--repo", hasGithubReference ? `${parsed.owner}/${parsed.name}` : undefined].filter(Boolean), { cwd: repoCwd });
        if (!prCheck.trim()) throw new Error(`Pull request #${pr} was not found.`);
        const { owner, name } = hasGithubReference ? parsed : await resolveRepository(repoCwd);
        const path = statePath(repoCwd, pr);
        const previous = readState(path);
        if (previous && processAlive(previous.pid)) {
          active = previous;
          syncStatus(ctx, active);
          notify(ctx, `Codex monitor is already running for PR #${pr}.`, "warning");
          return;
        }

        const log = `${path}.log`;
        const logFd = openSync(log, "a");
        const child = spawn("bash", [MONITOR_SCRIPT], {
          cwd: repoCwd,
          detached: true,
          env: { ...process.env, PR: pr, OWNER: owner, NAME: name, GH_REPO: `${owner}/${name}` },
          stdio: ["ignore", logFd, logFd],
        });
        const url = `https://github.com/${owner}/${name}/pull/${pr}`;
        const startedAt = new Date().toISOString();
        const nextState = { pid: child.pid, pr, owner, name, url, cwd: repoCwd, log, statePath: path, status: "running", reviewer: REVIEWER, startedAt, logOffset: 0 };
        child.once("error", (error) => {
          if (active?.pid !== child.pid) return;
          stopLogWatcher();
          active = null;
          removeState(path);
          syncStatus(ctx, null);
          notify(ctx, `Could not start Codex monitor: ${error.message}`, "error");
        });
        child.once("spawn", () => {
          saveState(path, nextState);
          active = nextState;
          pi.appendEntry("codex-review-loop", { action: "start", ...active });
          syncStatus(ctx, active);
          startLogWatcher(active, ctx);
          notify(ctx, `Codex monitor started for ${owner}/${name}#${pr}.\nLog: ${log}`, "info");
        });
        child.unref();
      } catch (error) {
        notify(ctx, `Could not start Codex monitor: ${error.message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd || process.cwd();
    let repository = null;
    try { repository = await resolveRepository(cwd); } catch { /* non-repository session */ }
    active = findPersistedState(cwd, repository);
    if (active) {
      syncStatus(ctx, active);
      startLogWatcher(active, ctx);
    } else {
      syncStatus(ctx, null);
    }
  });

  pi.on("session_shutdown", async () => {
    stopLogWatcher();
    // Keep the detached monitor alive. An explicit /codex-review-loop stop removes it.
    active = null;
  });
}
