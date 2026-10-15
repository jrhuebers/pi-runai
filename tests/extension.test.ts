import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/index.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function harness() {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const messages: any[] = [];
  const deliveryOptions: any[] = [];
  const events: any[] = [];
  const commands: string[][] = [];
  let cluster = "cluster-a";
  let rows = new Map<string, string>();
  let error = false;
  let settling = false;
  let logOutput = "example log";
  let captureError = false;
  let logReadError = false;
  let captureGate: Promise<void> | undefined;
  const root = mkdtempSync(join(tmpdir(), "runai-extension-"));
  const captures: string[] = [];
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    sendMessage(message: unknown, options: any) {
      if (settling && options?.triggerTurn) throw new Error("Agent is already processing a prompt");
      messages.push(message);
      deliveryOptions.push(options);
    },
    events: { emit(name: string, data: unknown) { events.push({ name, data }); } },
    async exec(_cli: string, args: string[]) {
      commands.push(args);
      let output = "";
      if (args[0] === "config") output = `Project: lab-user\nCluster: ${cluster}`;
      else if (args[0] === "list") output = "NAME STATUS AGE\n" + [...rows].map(([name, status]) => `${name} ${status} 1m`).join("\n");
      else if (args[0] === "submit") { rows.set(args[args.indexOf("--name") + 1], "Pending"); output = "Submitted successfully"; }
      else if (args[0] === "delete") rows.delete(args[2]);
      else if (args[0] === "logs") output = logOutput;
      return { stdout: output, stderr: error ? "Unauthorized" : logReadError && args[0] === "logs" ? "Pod no longer exists" : "", code: error || (logReadError && args[0] === "logs") ? 1 : 0, killed: false };
    },
  };
  extension(pi as unknown as ExtensionAPI, { capture: {
    create: (cwd, name) => {
      const directory = join(cwd, "runai-logs");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, `${name}-${randomBytes(8).toString("hex")}.out`);
      writeFileSync(file, "", { mode: 0o600, flag: "wx" });
      return file;
    },
    follow: async (job) => { captures.push(`follow:${job.id}`); },
    finish: async (job) => {
      captures.push(`finish:${job.id}`);
      if (captureError) throw new Error("synthetic capture failure");
      if (captureGate) await captureGate;
      appendFileSync(job.logPath!, logOutput);
    },
    stopAll() {}, stopJob() {},
  } });
  const ctx = { cwd: root, hasUI: false, sessionManager: { getBranch: () => entries } };
  return { handlers, tools, entries, messages, deliveryOptions, events, commands, ctx, rows, captures,
    setLogOutput: (value: string) => { logOutput = value; }, setCaptureError: (value: boolean) => { captureError = value; },
    setLogReadError: (value: boolean) => { logReadError = value; },
    setCaptureGate: (value: Promise<void>) => { captureGate = value; },
    setCluster: (value: string) => { cluster = value; }, setError: (value: boolean) => { error = value; },
    setSettling: (value: boolean) => { settling = value; },
    call: (name: string, params: any) => tools.get(name).execute("id", params, undefined, undefined, ctx),
    async start() { await handlers.get("session_start")?.({}, ctx); },
    stop() { handlers.get("session_shutdown")?.({}, ctx); rmSync(root, { recursive: true, force: true }); },
  };
}
async function settled() { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
function pollInterval() {
  const raw = Number(process.env.PI_RUNAI_POLL_INTERVAL_MS ?? 5000);
  return Number.isFinite(raw) ? Math.max(5000, raw) : 5000;
}

for (const [configured, expected] of [[undefined, 5000], ["invalid", 5000], ["1000", 5000], ["10000", 10000]] as const) {
  test(`poll interval ${configured ?? "default"} resolves to ${expected}ms`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const previous = process.env.PI_RUNAI_POLL_INTERVAL_MS;
    if (configured === undefined) delete process.env.PI_RUNAI_POLL_INTERVAL_MS;
    else process.env.PI_RUNAI_POLL_INTERVAL_MS = configured;
    const h = harness();
    try {
      await h.start();
      await h.call("runai_submit", { name: "job", image: "ubuntu" });
      h.rows.set("job", "Succeeded");
      t.mock.timers.tick(expected - 1);
      await settled();
      assert.equal(h.events.length, 0);
      t.mock.timers.tick(1);
      await settled();
      assert.equal(h.events.length, 1);
      assert.equal(h.messages.length, 1);
    } finally {
      h.stop();
      if (previous === undefined) delete process.env.PI_RUNAI_POLL_INTERVAL_MS;
      else process.env.PI_RUNAI_POLL_INTERVAL_MS = previous;
    }
  });
}

test("submit, tracking, bounded logs, duplicate protection and explicit cancellation", async () => {
  const h = harness();
  try {
    await h.start();
    const result = await h.call("runai_submit", { name: "job", image: "ubuntu", command: ["echo", "ok"] });
    assert.match(result.content[0].text, /cluster-a\/lab-user\/job/);
    assert.equal(h.entries.at(-1).data.jobs[0].lastState, "PENDING");
    await assert.rejects(h.call("runai_submit", { name: "job", image: "ubuntu" }), /exists/);
    await h.call("runai_logs", { job_id: "cluster-a/lab-user/job" });
    const logArgs = h.commands.at(-1)!;
    assert(logArgs.includes("--train"));
    assert(logArgs.includes("100"));
    assert(!logArgs.includes("--follow"));
    await assert.rejects(h.call("runai_cancel", { job_id: "cluster-a/lab-user/job", reason: "obsolete", confirm: false }));
    await h.call("runai_cancel", { job_id: "cluster-a/lab-user/job", reason: "obsolete", confirm: true });
    assert.equal(h.entries.at(-1).data.jobs[0].lastState, "CANCELLED");
    assert.equal(h.events.at(-1).name, "runai:finished");
    assert.deepEqual(h.deliveryOptions.at(-1), { triggerTurn: true, deliverAs: "steer" });
    assert(!h.commands.some(args => args.includes("--all")));
  } finally { h.stop(); }
});
test("running notifications are steered immediately, not flushed during settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness();
  try {
    await h.start();
    await h.call("runai_submit", { name: "job", image: "ubuntu" });
    h.handlers.get("agent_start")?.();
    h.rows.set("job", "Running");
    t.mock.timers.tick(pollInterval());
    await settled();
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].details.status, "RUNNING");
    assert.deepEqual(h.deliveryOptions[0], { triggerTurn: true, deliverAs: "steer" });
    assert.equal(h.events.length, 0);
    assert.equal(h.entries.at(-1).data.jobs[0].lastState, "RUNNING");
    h.setSettling(true);
    assert.equal(h.handlers.get("agent_before_settle")?.(), undefined);
    h.handlers.get("agent_settled")?.();
    assert.equal(h.messages.length, 1);
    assert(!h.handlers.has("agent_before_settle"));
    assert(!h.handlers.has("agent_settled"));
  } finally { h.stop(); }
});
for (const [raw, status] of [["Succeeded", "COMPLETED"], ["Failed", "FAILED"], ["Cancelled", "CANCELLED"]]) {
  test(`${status} immediately steers one notification and emits one sleep event during an active run`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness();
    try {
      await h.start();
      await h.call("runai_submit", { name: "job", image: "ubuntu" });
      h.handlers.get("agent_start")?.();
      h.rows.set("job", raw);
      t.mock.timers.tick(pollInterval());
      await settled();
      assert.equal(h.messages.length, 1); // No settlement or final assistant response required.
      assert.equal(h.messages[0].details.status, status);
      assert.equal(h.messages[0].display, true);
      assert.deepEqual(h.deliveryOptions[0], { triggerTurn: true, deliverAs: "steer" });
      assert.equal(h.events.length, 1);
      assert.equal(h.events[0].name, "runai:finished");
      assert.equal(h.events[0].data.status, status);
      assert.equal(h.entries.at(-1).data.jobs[0].lastState, status);
      t.mock.timers.tick(pollInterval());
      await settled();
      h.handlers.get("agent_before_settle")?.();
      h.handlers.get("agent_settled")?.();
      assert.equal(h.messages.length, 1);
      assert.equal(h.events.length, 1);
    } finally { h.stop(); }
  });
}
test("idle completion still requests a continuation, and restore only replays the sleep event", async () => {
  const h = harness();
  try {
    await h.call("runai_submit", { name: "job", image: "ubuntu" });
    h.rows.set("job", "Succeeded");
    await h.start();
    await settled();
    assert.equal(h.messages.length, 1);
    assert.deepEqual(h.deliveryOptions[0], { triggerTurn: true, deliverAs: "steer" });
    assert.equal(h.events.length, 1);
    await h.start();
    await settled();
    assert.equal(h.messages.length, 1);
    assert.equal(h.events.length, 2);
  } finally { h.stop(); }
});
test("running-time reminder is steered once without waiting for settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness();
  try {
    await h.call("runai_submit", { name: "job", image: "ubuntu", notify_after_minutes: 1 });
    Object.assign(h.entries.at(-1).data.jobs[0], { lastState: "RUNNING", startedAt: new Date(Date.now() - 120000).toISOString() });
    h.rows.set("job", "Running");
    h.handlers.get("agent_start")?.();
    await h.start();
    await settled();
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0].content, /running-time reminder/);
    assert.deepEqual(h.deliveryOptions[0], { triggerTurn: true, deliverAs: "steer" });
    t.mock.timers.tick(pollInterval());
    await settled();
    assert.equal(h.messages.length, 1);
  } finally { h.stop(); }
});
test("missing jobs, unknown status, preemption and auth errors do not signal completion", async () => {
  for (const state of [undefined, "Preempted", "NewState", "Unauthorized"]) {
    const h = harness();
    try {
      await h.call("runai_submit", { name: "job", image: "ubuntu" });
      if (state === undefined) h.rows.delete("job"); else h.rows.set("job", state);
      if (state === "Unauthorized") h.setError(true);
      await h.start();
      await settled();
      assert.equal(h.events.length, 0);
      assert.equal(h.entries.at(-1).data.jobs[0].lastState, "PENDING");
    } finally { h.stop(); }
  }
});
test("context switch refuses logs/deletion and does not observe identically named jobs", async () => {
  const h = harness();
  try {
    await h.call("runai_submit", { name: "job", image: "ubuntu" });
    h.setCluster("cluster-b");
    h.rows.set("job", "Succeeded");
    await h.start();
    await settled();
    assert.equal(h.events.length, 0);
    await assert.rejects(h.call("runai_logs", { job_id: "cluster-a/lab-user/job" }), /context changed/);
    await assert.rejects(h.call("runai_cancel", { job_id: "cluster-a/lab-user/job", reason: "obsolete", confirm: true }), /context changed/);
    assert(!h.commands.some(args => args[0] === "delete"));
  } finally { h.stop(); }
});
test("large log reads preserve newest failures and save the complete requested output privately", async () => {
  const h = harness();
  try {
    await h.call("runai_submit", { name: "job", image: "ubuntu" });
    const raw = "  " + "😀".repeat(12000) + "\nLATEST_ERROR_MARKER\n";
    h.setLogOutput(raw);
    const result = await h.call("runai_logs", { job_id: "cluster-a/lab-user/job", tail: 2000, pod: "job-pod" });
    assert(result.content[0].text.includes("LATEST_ERROR_MARKER"));
    assert.equal(result.details.truncated, true);
    assert.equal(readFileSync(result.details.fullOutputPath, "utf8"), raw);
    assert.equal(statSync(result.details.fullOutputPath).mode & 0o777, 0o600);
    assert(h.commands.at(-1)!.includes("--pod"));
  } finally { h.stop(); }
});
test("captured logs and their paths survive job deletion, and local reads work across contexts", async () => {
  const h = harness();
  try {
    const submitted = await h.call("runai_submit", { name: "job", image: "ubuntu" });
    const logPath = h.entries.at(-1).data.jobs[0].logPath;
    assert(submitted.content[0].text.includes(logPath));
    await h.call("runai_cancel", { job_id: "cluster-a/lab-user/job", reason: "mock-only", confirm: true });
    assert.equal(readFileSync(logPath, "utf8"), "example log");
    assert(h.events.at(-1).data.logPath === logPath);
    assert(h.messages.at(-1).content.includes(logPath));
    const count = h.commands.length;
    h.setCluster("other-cluster");
    const result = await h.call("runai_logs", { job_id: "cluster-a/lab-user/job", local: true });
    assert.equal(h.commands.length, count);
    assert.equal(result.details.local, true);
    assert(result.content[0].text.includes("example log"));
  } finally { h.stop(); }
});
test("unavailable pod logs fall back to the retained file instead of losing captured output", async () => {
  const h = harness();
  try {
    await h.call("runai_submit", { name: "job", image: "ubuntu" });
    appendFileSync(h.entries.at(-1).data.jobs[0].logPath, "retained evidence\n");
    h.setLogReadError(true);
    const result = await h.call("runai_logs", { job_id: "cluster-a/lab-user/job" });
    assert.equal(result.details.local, true);
    assert.match(result.content[0].text, /retained evidence/);
    assert.match(result.content[0].text, /may be incomplete/);
  } finally { h.stop(); }
});
test("running log capture starts automatically and short completed jobs get a final snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness();
  try {
    await h.start();
    await h.call("runai_submit", { name: "job", image: "ubuntu" });
    h.rows.set("job", "Running");
    t.mock.timers.tick(pollInterval());
    await settled();
    assert(h.captures.includes("follow:cluster-a/lab-user/job"));
    h.rows.set("job", "Succeeded");
    t.mock.timers.tick(pollInterval());
    await settled();
    assert(h.captures.includes("finish:cluster-a/lab-user/job"));
    assert.equal(h.entries.at(-1).data.jobs[0].logCaptureStatus, "saved");
    assert.equal(h.events.length, 1);
  } finally { h.stop(); }
});
test("failed final capture blocks destructive deletion unless log loss was explicitly approved", async () => {
  const h = harness();
  try {
    h.rows.set("job", "Running");
    await h.call("runai_track", { name: "job" });
    h.setCaptureError(true);
    await assert.rejects(h.call("runai_cancel", { job_id: "cluster-a/lab-user/job", reason: "mock-only", confirm: true }), /NOT deleted/);
    assert(!h.commands.some(args => args[0] === "delete"));
    assert.equal(h.entries.at(-1).data.jobs[0].logCaptureStatus, "error");
    await h.call("runai_cancel", { job_id: "cluster-a/lab-user/job", reason: "approved mock-only log loss", confirm: true, allow_log_loss: true });
    assert(h.commands.some(args => args[0] === "delete"));
  } finally { h.stop(); }
});
test("completion notification and sleep event do not wait for slow disk capture", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness();
  let release!: () => void;
  h.setCaptureGate(new Promise<void>(resolve => { release = resolve; }));
  try {
    await h.start();
    await h.call("runai_submit", { name: "job", image: "ubuntu" });
    h.rows.set("job", "Succeeded");
    t.mock.timers.tick(pollInterval());
    await settled();
    assert.equal(h.events.length, 1);
    assert.equal(h.messages.length, 1);
    assert.equal(h.entries.at(-1).data.jobs[0].logCaptureStatus, "saving");
    release();
    await settled();
    assert.equal(h.entries.at(-1).data.jobs[0].logCaptureStatus, "saved");
    assert.equal(h.messages.length, 1);
  } finally { release(); await settled(); h.stop(); }
});

test("legacy restored terminal jobs get a log path and snapshot without duplicate completion messages", async () => {
  const h = harness();
  try {
    await h.call("runai_submit", { name: "job", image: "ubuntu" });
    const legacy = h.entries.at(-1).data.jobs[0];
    delete legacy.logPath;
    legacy.lastState = "COMPLETED";
    await h.start();
    await settled();
    const restored = h.entries.at(-1).data.jobs[0];
    assert(restored.logPath);
    assert.equal(restored.logCaptureStatus, "saved");
    assert.equal(h.messages.length, 0);
    assert.equal(h.events.length, 1);
  } finally { h.stop(); }
});

test("restore only uses current branch and validates stored state", async () => {
  const h = harness();
  try {
    h.entries.push({ type: "custom", customType: "pi-runai-state", data: { version: 1, jobs: [null, { id: "bad" }] } });
    await h.start();
    const result = await h.call("runai_jobs", {});
    assert.equal(result.content[0].text, "(none)");
    await assert.rejects(h.call("runai_cancel", { job_id: "cluster-a/lab-user/other", reason: "obsolete", confirm: true }), /Unknown tracked/);
  } finally { h.stop(); }
});
