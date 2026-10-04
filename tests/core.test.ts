import test from "node:test";
import assert from "node:assert/strict";
import { identifier, identity, normaliseState, parseConfig, parseJobs, submitArgs, terminal, isJob } from "../extensions/core.js";

test("v1 listings: headers, fractional GPUs, whitespace and empty project", () => {
  const table = 'Showing jobs for project lab-user\nNAME  STATUS  AGE NODE IMAGE TYPE PROJECT USER GPUs\njob-1  Running  6s node image Train lab-user user 0.10 (0.10)\njob-2  Succeeded 1m node image Train lab-user user 1\n';
  assert.equal(parseJobs(table).get("job-1")?.state, "RUNNING");
  assert.equal(parseJobs(table).get("job-2")?.state, "COMPLETED");
  assert.equal(parseJobs("NAME STATUS AGE\n").size, 0);
  assert.throws(() => parseJobs("Unauthorized"));
});
test("preempted/restarting jobs are not terminal and unknowns never mean success", () => {
  for (const raw of ["Preempted", "Restarting", "Pending"]) assert.equal(normaliseState(raw), "PENDING");
  assert.equal(normaliseState("Suspended"), "SUSPENDED");
  assert.equal(normaliseState("NewState"), "UNKNOWN");
  assert.equal(terminal("UNKNOWN"), false);
  assert.equal(terminal("SUSPENDED"), false);
  assert.equal(terminal("FAILED"), true);
});
test("config accepts both CLI logging formats", () => {
  assert.deepEqual(parseConfig('time="now" level=info msg="Project: lab-user"\ntime="now" level=info msg="Cluster: cluster-a"'), { cluster: "cluster-a", project: "lab-user" });
  assert.deepEqual(parseConfig("INFO[0000] Cluster: cluster-a\nINFO[0000] Project: <none>"), { cluster: "cluster-a", project: undefined });
  assert.throws(() => parseConfig("Cluster: <none>"));
});
test("submission uses explicit container argv, fractional GPU and documented PVC/identity flags", () => {
  const args = submitArgs({ image: "ubuntu", command: ["/bin/bash", "-lc", "echo 'hello; world'"], gpus: 0.5, cpus: 2,
    pvc_mounts: [{ claim: "home", path: "/home/user" }], uid: 123, gid: 456, supplemental_groups: [789], environment: [{ name: "HOME", value: "/home/user" }] }, "test-job", "lab-user");
  assert.deepEqual(args.slice(-4), ["--", "/bin/bash", "-lc", "echo 'hello; world'"]);
  assert(args.indexOf("--suppress-deprecation-message") < args.indexOf("--"));
  assert(args.includes("claimname=home,path=/home/user"));
  assert(args.includes("0.5"));
  assert(!args.includes("--host-network"));
  assert(!args.includes("--attach"));
});
test("omitted command keeps image entrypoint; safe names and PVC paths", () => {
  assert(!submitArgs({ image: "ubuntu" }, "job", "project").includes("--command"));
  for (const name of ["--all", "../job", "Uppercase", "job;rm", "a".repeat(64)]) assert.throws(() => identifier(name, "name"));
  assert.throws(() => submitArgs({ image: "--bad" }, "job", "project"));
  assert.throws(() => submitArgs({ image: "ubuntu", pvc_mounts: [{ claim: "home", path: "/x,extra=yes" }] }, "job", "project"));
  assert.throws(() => submitArgs({ image: "ubuntu", command: [] }, "job", "project"));
});
test("restore validates persistent state and cluster/project identity", () => {
  const job = { id: identity("cluster", "project", "job"), cluster: "cluster", project: "project", name: "job", interactive: false, submittedAt: "2026-01-01", lastState: "PENDING" };
  assert(isJob(job));
  assert(!isJob({ ...job, id: "other" }));
  assert(!isJob({ ...job, lastState: "garbage" }));
  assert(!isJob(null));
});
