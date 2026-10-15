import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RunaiLogCapture, localTail, saveSnapshot, tailPreview } from "../extensions/logs.js";
import type { Job } from "../extensions/core.js";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Fake CLI did not become ready");
    await delay(10);
  }
}

function fixture(fail = false) {
  const root = fs.mkdtempSync(join(tmpdir(), "runai-logs-test-"));
  const cli = join(root, "fake-runai");
  const calls = join(root, "calls.jsonl");
  const previous = process.env.PI_RUNAI_LOG_DIR;
  delete process.env.PI_RUNAI_LOG_DIR;
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (${fail}) { console.error('synthetic remote log failure'); process.exit(1); }
console.error('synthetic CLI diagnostics');
if (args.includes('--follow')) {
  console.log('STREAM_READY');
  process.on('SIGTERM', () => { console.log('STREAM_CLOSED'); process.exit(0); });
  setInterval(() => {}, 1000);
} else {
  process.stdout.write('x'.repeat(40000) + '\\nLATEST_ERROR_MARKER\\n');
}
`, { mode: 0o700 });
  const capture = new RunaiLogCapture(cli);
  const job: Job = { id: "cluster/project/job", name: "job", cluster: "cluster", project: "project", interactive: false,
    submittedAt: new Date().toISOString(), lastState: "RUNNING", logPath: capture.create(root, "job") };
  return { root, capture, job, calls,
    close() {
      capture.stopAll();
      if (previous === undefined) delete process.env.PI_RUNAI_LOG_DIR;
      else process.env.PI_RUNAI_LOG_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("tail previews retain latest failures, enforce byte/line limits and preserve Unicode", () => {
  const preview = tailPreview("😀".repeat(10000) + "\nLATEST_ERROR_MARKER\n");
  assert(preview.truncated);
  assert(preview.text.endsWith("LATEST_ERROR_MARKER"));
  assert(!preview.text.includes("�"));
  assert(Buffer.byteLength(preview.text) <= 32000);
  assert.equal(tailPreview("one\ntwo\nthree\n", 2).text, "two\nthree");
});

test("streaming capture writes directly to a private persistent file; final snapshot retains its newest output", async () => {
  const f = fixture();
  let live: Promise<void> | undefined;
  try {
    live = f.capture.follow(f.job);
    assert.equal(f.capture.follow(f.job), live, "Only one live capture per job");
    await until(() => fs.readFileSync(f.job.logPath!, "utf8").includes("STREAM_READY"));
    await f.capture.finish(f.job);
    await live;
    const output = fs.readFileSync(f.job.logPath!, "utf8");
    assert(output.includes("STREAM_READY"));
    assert(output.includes("STREAM_CLOSED"));
    assert(output.includes("LATEST_ERROR_MARKER"));
    assert(!output.includes("synthetic CLI diagnostics"));
    assert(fs.readFileSync(f.job.logPath! + ".capture.log", "utf8").includes("synthetic CLI diagnostics"));
    assert.equal(fs.statSync(f.job.logPath!).mode & 0o777, 0o600);
    assert.equal(fs.statSync(join(f.root, "runai-logs")).mode & 0o777, 0o700);
    assert(localTail(f.job.logPath!, 2).text.includes("LATEST_ERROR_MARKER"));
    const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert(calls[0].includes("--follow"));
    assert(!calls[1].includes("--follow"));
    assert(calls.every(args => args.includes("--train") && args.includes("--timestamps") && args.includes("-1")));
  } finally {
    f.capture.stopAll();
    await live?.catch(() => {});
    f.close();
  }
});

test("snapshot files preserve every requested byte even when the preview is truncated", () => {
  const f = fixture();
  try {
    const raw = " leading whitespace\n" + "x".repeat(40000) + "\nERROR\n";
    const file = saveSnapshot(f.job.logPath!, raw);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert(tailPreview(raw).text.endsWith("ERROR"));
  } finally { f.close(); }
});

test("failed capture retains diagnostics and does not report success", async () => {
  const f = fixture(true);
  try {
    await assert.rejects(f.capture.finish(f.job), /exited 1/);
    assert(fs.readFileSync(f.job.logPath! + ".capture.log", "utf8").includes("synthetic remote log failure"));
  } finally { f.close(); }
});

test("shutdown prevents an in-flight finalizer from spawning a new CLI after stopping its follower", async () => {
  const f = fixture();
  let live: Promise<void> | undefined;
  try {
    live = f.capture.follow(f.job);
    await until(() => fs.readFileSync(f.job.logPath!, "utf8").includes("STREAM_READY"));
    const done = assert.rejects(f.capture.finish(f.job), /context changed/);
    f.capture.stopAll();
    await done;
    await live;
    assert.equal(fs.readFileSync(f.calls, "utf8").trim().split("\n").length, 1);
  } finally { f.capture.stopAll(); await live?.catch(() => {}); f.close(); }
});

test("context change stops the old cluster's follower and prevents a queued final snapshot", async () => {
  const f = fixture();
  let live: Promise<void> | undefined;
  try {
    live = f.capture.follow(f.job);
    await until(() => fs.readFileSync(f.job.logPath!, "utf8").includes("STREAM_READY"));
    const done = assert.rejects(f.capture.finish(f.job), /context changed/);
    f.capture.stopAll("other-cluster");
    await done;
    await live;
    assert.equal(fs.readFileSync(f.calls, "utf8").trim().split("\n").length, 1);
  } finally { f.capture.stopAll(); await live?.catch(() => {}); f.close(); }
});

test("log directory overrides resolve relative to the job working directory or use an absolute path", () => {
  const f = fixture();
  try {
    process.env.PI_RUNAI_LOG_DIR = "custom-logs";
    assert(f.capture.create(f.root, "job").startsWith(join(f.root, "custom-logs")));
    process.env.PI_RUNAI_LOG_DIR = join(f.root, "absolute-logs");
    assert(f.capture.create("/unused", "job").startsWith(join(f.root, "absolute-logs")));
  } finally { f.close(); }
});

test("a final snapshot verifies current cluster after waiting for the follower to exit", async () => {
  const f = fixture();
  try {
    const capture = new RunaiLogCapture(join(f.root, "fake-runai"), async () => { throw new Error("wrong cluster"); });
    await assert.rejects(capture.finish(f.job), /wrong cluster/);
    assert(!fs.existsSync(f.calls), "No logs command should run in a different cluster");
  } finally { f.close(); }
});

test("unsafe symlink log targets are not followed", async () => {
  const f = fixture();
  try {
    const outside = join(f.root, "untouched");
    fs.writeFileSync(outside, "UNCHANGED");
    fs.unlinkSync(f.job.logPath!);
    fs.symlinkSync(outside, f.job.logPath!);
    await assert.rejects(f.capture.finish(f.job));
    assert.throws(() => localTail(f.job.logPath!, 10));
    assert.equal(fs.readFileSync(outside, "utf8"), "UNCHANGED");
  } finally { f.close(); }
});
