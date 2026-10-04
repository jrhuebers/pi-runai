import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function harness() {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const messages: any[] = [];
  const events: any[] = [];
  const commands: string[][] = [];
  let cluster = "cluster-a";
  let rows = new Map<string, string>();
  let error = false;
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    sendMessage(message: unknown) { messages.push(message); },
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
  return { handlers, tools, entries, messages, events, commands, ctx, rows,
    setCluster: (value: string) => { cluster = value; }, setError: (value: boolean) => { error = value; },
    call: (name: string, params: any) => tools.get(name).execute("id", params, undefined, undefined, ctx),
    async start() { await handlers.get("session_start")?.({}, ctx); },
    stop() { handlers.get("session_shutdown")?.({}, ctx); },
  };
}
async function settled() { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

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
    assert(!h.commands.some(args => args.includes("--all")));
  } finally { h.stop(); }
});
test("monitor transitions persist and inject notifications only at agent boundaries", async () => {
  const h = harness();
  try {
    await h.call("runai_submit", { name: "job", image: "ubuntu" });
    h.handlers.get("agent_start")!();
    h.rows.set("job", "Succeeded");
    await h.start();
    await settled();
    assert.equal(h.entries.at(-1).data.jobs[0].lastState, "COMPLETED");
    assert.equal(h.messages.length, 0);
    const draft = h.handlers.get("agent_before_settle")!();
    assert.equal(draft.continue, true);
    assert.equal(draft.entries[0].details.status, "COMPLETED");
    assert.equal(h.handlers.get("agent_before_settle")!(), undefined);
    assert.equal(h.events.length, 1);
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
