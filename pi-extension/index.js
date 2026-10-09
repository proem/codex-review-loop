import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
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

function isMonitorProcess(pid) {
  if (!processAlive(pid)) return false;
  try {
    const command = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { encoding: "utf8" })
      : process.platform === "darwin"
        ? execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })
        : readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return command.includes("codex-review-loop") && command.includes("monitor.sh");
  } catch {
    return false;
  }
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
  const normalized = resolve(String(value || "")).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function findPersistedState(cwd, repository) {
  try {
    const normalizedCwd = normalizePath(cwd);
    return readdirSync(tmpdir())
      .filter((name) => name.startsWith("pi-codex-review-loop-") && name.endsWith(".json"))
      .map((name) => join(tmpdir(), name))
      .map((path) => ({ path, state: readState(path) }))
      .filter(({ state }) => state && isMonitorProcess(state.pid)
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
  if (state && isMonitorProcess(state.pid)) {
    try { process.kill(state.pid, "SIGTERM"); } catch { /* exited between the check and kill */ }
  }
  removeState(path);
}

export { hyperlink, normalizePath, parseCommand, processAlive, readState, statePath, validatePrIdentifier };

export default function codexReviewLoopExtension(pi) {
  let active = null;
  let logWatcher = null;
  let livenessTimer = null;
  let watcherGeneration = 0;

  const status = (ctx) => {
    if (!active) return null;
    if (!isMonitorProcess(active.pid)) {
      active = { ...active, status: "stopped" };
      syncStatus(ctx, active);
      return active;
    }
    return active;
  };

  const stopLogWatcher = () => {
    watcherGeneration += 1;
    if (logWatcher) logWatcher.close();
    if (livenessTimer) clearInterval(livenessTimer);
    logWatcher = null;
    livenessTimer = null;
  };

  const startLogWatcher = (state, ctx) => {
    stopLogWatcher();
    const generation = watcherGeneration;
    let offset = Number.isInteger(state.logOffset) ? state.logOffset : 0;
    const consumeLog = () => {
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
        const unread = content.subarray(offset);
        const boundary = unread.lastIndexOf(10);
        if (boundary < 0) return;
        const complete = unread.subarray(0, boundary + 1);
        const lines = complete.toString("utf8").split(/\r?\n/).filter(Boolean);
        offset += complete.length;
        state.logOffset = offset;
        saveState(state.statePath, state);
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "signal") {
            state.codexSignal = event.signal;
            saveState(state.statePath, state);
            syncStatus(ctx, state);
          }
          if (event.type !== "activity" && event.type !== "quota") continue;
          const detail = event.detail || event.message || line;
          const message = `[Codex review loop] ${state.owner}/${state.name}#${state.pr}: ${detail}`;
          notify(ctx, message, event.type === "quota" ? "error" : "info");
          pi.sendMessage({ customType: "codex-review-loop-event", content: message, display: true }, { deliverAs: "steer", triggerTurn: true });
        }
      } catch {
        // The monitor may exit while its log is being rotated or cleaned up.
      }
    };
    logWatcher = watch(state.log, { persistent: false }, (_eventType) => {
      if (generation === watcherGeneration) consumeLog();
    });
    consumeLog();
    livenessTimer = setInterval(() => {
      if (generation === watcherGeneration) consumeLog();
    }, 5000);
    livenessTimer.unref?.();
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

      if (active && isMonitorProcess(active.pid)) {
        notify(ctx, `Codex monitor is already running for PR #${active.pr}.`, "warning");
        return;
      }

      try {
        const hasGithubReference = parsed.owner && parsed.name && parsed.pr;
        const repoCwd = hasGithubReference || parsed.repo ? cwd : await assertGitRepository(cwd);
        const pr = parsed.pr || await resolvePullRequest(repoCwd, parsed.pr);
        if (!validatePrIdentifier(pr)) throw new Error(`Invalid pull request number: ${pr}`);
        const { stdout: prCheck } = await run("gh", ["pr", "view", pr, "--repo", hasGithubReference ? `${parsed.owner}/${parsed.name}` : undefined, "--json", "state", "--jq", ".state"].filter(Boolean), { cwd: repoCwd });
        if (prCheck.trim() !== "OPEN") throw new Error(`Pull request #${pr} is not open.`);
        const { owner, name } = hasGithubReference ? parsed : await resolveRepository(repoCwd);
        const path = statePath(repoCwd, pr);
        const previous = readState(path);
        if (previous && isMonitorProcess(previous.pid)) {
          active = previous;
          syncStatus(ctx, active);
          notify(ctx, `Codex monitor is already running for PR #${pr}.`, "warning");
          return;
        }

        const log = `${path}.log`;
        const logFd = openSync(log, "w");
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
