import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MONITOR_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/codex-review-loop/scripts/monitor.sh");
const REVIEWER = "chatgpt-codex-connector[bot]";

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
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function removeState(path) {
  try { unlinkSync(path); } catch { /* already stopped */ }
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
    ctx?.ui?.setStatus?.("codex-review-loop", undefined);
    return;
  }
  const label = `${state.owner}/${state.name}#${state.pr}`;
  const link = hyperlink(label, state.url);
  ctx?.ui?.setStatus?.("codex-review-loop", `Codex monitor: ${state.status} · ${link}`);
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

export { hyperlink, parseCommand, processAlive, readState, statePath };

export default function codexReviewLoopExtension(pi) {
  let active = null;

  const status = (ctx) => {
    if (!active) return null;
    if (!processAlive(active.pid)) {
      active = { ...active, status: "stopped" };
      syncStatus(ctx, active);
      return active;
    }
    return active;
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
        child.unref();

        const url = `https://github.com/${owner}/${name}/pull/${pr}`;
        active = { pid: child.pid, pr, owner, name, url, cwd: repoCwd, log, statePath: path, status: "running", reviewer: REVIEWER };
        saveState(path, active);
        pi.appendEntry("codex-review-loop", { action: "start", ...active });
        syncStatus(ctx, active);
        notify(ctx, `Codex monitor started for ${owner}/${name}#${pr}.\nLog: ${log}`, "info");
      } catch (error) {
        notify(ctx, `Could not start Codex monitor: ${error.message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    syncStatus(ctx, active);
  });

  pi.on("session_shutdown", async () => {
    if (active) stopState(active, active.statePath);
    active = null;
  });
}
