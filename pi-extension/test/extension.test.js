import assert from "node:assert/strict";
import test from "node:test";

import { hyperlink, parseCommand, processAlive, statePath } from "../index.js";

test("parseCommand defaults to status", () => {
  assert.deepEqual(parseCommand(""), { action: "status", pr: "", repo: "" });
  assert.deepEqual(parseCommand("start 42"), { action: "start", pr: "42", repo: "" });
  assert.deepEqual(parseCommand("start 42 --repo C:/work/repo"), { action: "start", pr: "42", repo: "C:/work/repo" });
  assert.deepEqual(parseCommand("start https://github.com/proem/codex-review-loop/pull/1"), {
    action: "start", owner: "proem", name: "codex-review-loop", pr: "1", repo: "",
  });
  assert.deepEqual(parseCommand("stop"), { action: "stop", pr: "", repo: "" });
});

test("parseCommand accepts PR URL query fragments", () => {
  assert.deepEqual(parseCommand("start https://github.com/proem/codex-review-loop/pull/1?foo=bar"), {
    action: "start", owner: "proem", name: "codex-review-loop", pr: "1", repo: "",
  });
});

test("parseCommand rejects unsupported actions", () => {
  assert.deepEqual(parseCommand("restart"), { action: "invalid", value: "restart" });
});

test("statePath is stable and scoped by working directory and PR", () => {
  assert.equal(statePath("/repo", "42"), statePath("/repo", "42"));
  assert.notEqual(statePath("/repo", "42"), statePath("/repo", "43"));
  assert.notEqual(statePath("/other", "42"), statePath("/repo", "42"));
});

test("processAlive rejects invalid PIDs", () => {
  assert.equal(processAlive(undefined), false);
  assert.equal(processAlive(-1), false);
});

test("hyperlink emits an OSC 8 terminal link", () => {
  assert.equal(hyperlink("PR #42", "https://github.com/proem/codex-review-loop/pull/42"), "\u001b]8;;https://github.com/proem/codex-review-loop/pull/42\u001b\\PR #42\u001b]8;;\u001b\\");
  assert.equal(hyperlink("PR #42", ""), "PR #42");
});
