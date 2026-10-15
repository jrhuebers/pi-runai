import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/index.js";
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
      else if (args[0] === "logs") output = "example log";
      return { stdout: output, stderr: error ? "Unauthorized" : "", code: error ? 1 : 0, killed: false };
    },
  };
  extension(pi as unknown as ExtensionAPI);
  const ctx = { hasUI: false, sessionManager: { getBranch: () => entries } };
  return { handlers, tools, entries, messages, deliveryOptions, events, commands, ctx, rows,
    setCluster: (value: string) => { cluster = value; }, setError: (value: boolean) => { error = value; },
    setSettling: (value: boolean) => { settling = value; },
    call: (name: string, params: any) => tools.get(name).execute("id", params, undefined, undefined, ctx),
    async start() { await handlers.get("session_start")?.({}, ctx); },
    stop() { handlers.get("session_shutdown")?.({}, ctx); },
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
