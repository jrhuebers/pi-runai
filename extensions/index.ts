import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { identity, identifier, isJob, parseConfig, parseJobs, submitArgs, terminal, type Job, type State } from "./core.js";

const ENTRY = "pi-runai-state";
const MESSAGE = "pi-runai";
const projectSchema = Type.Optional(Type.String({ description: "Run:ai project (not Kubernetes namespace). Defaults to PI_RUNAI_PROJECT or the CLI default." }));
const jobSchema = Type.String({ description: "Tracked ID returned by runai_submit/runai_track: cluster/project/name." });
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

export default function runai(pi: ExtensionAPI): void {
  // State is per runtime, not module-global: SDK sessions cannot share jobs.
  let jobs = new Map<string, Job>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller = new AbortController();
  let generation = 0;
  let polling = false;
  const rawInterval = Number(process.env.PI_RUNAI_POLL_INTERVAL_MS ?? 5000);
  const interval = Number.isFinite(rawInterval) ? Math.max(5000, rawInterval) : 5000;
  const cli = process.env.PI_RUNAI_CLI || "runai";

  async function run(args: string[], signal?: AbortSignal, timeout = 15000): Promise<string> {
    const result = await pi.exec(cli, args, { signal, timeout });
    if (signal?.aborted) throw new Error("Run:ai command aborted. For a submission, inspect the project before retrying.");
    if (result.killed || result.code !== 0) {
      // Do not echo submit arguments (they can contain environment values).
      const detail = `${result.stderr}\n${result.stdout}`.trim().slice(0, 4000);
      throw new Error(`Run:ai command failed${result.killed ? " or timed out" : ""}: ${detail || result.code}. For submission failures, inspect the project before retrying.`);
    }
    return `${result.stdout}\n${result.stderr}`.trim();
  }
  async function scope(project?: string, signal?: AbortSignal) {
    const config = parseConfig(await run(["config", "view", "--suppress-deprecation-message"], signal));
    const selected = project || process.env.PI_RUNAI_PROJECT || config.project;
    if (!selected) throw new Error("Pass project, set PI_RUNAI_PROJECT, or configure a default Run:ai project manually.");
    return { cluster: config.cluster, project: identifier(selected, "project") };
  }
  async function listing(project: string, signal?: AbortSignal) {
    return parseJobs(await run(["list", "jobs", "--project", project, "--suppress-deprecation-message"], signal));
  }
  function persist() { pi.appendEntry(ENTRY, { version: 1, jobs: [...jobs.values()] }); }
  function notify(job: Job, text: string) {
    const message = { content: `[RUNAI] ${job.id} ${text}`, details: { jobId: job.id, status: job.lastState } };
    // Queue into the active run immediately, rather than waiting for the whole
    // run to settle. Pi delivers steering at its next eligible boundary and
    // starts a continuation when idle, just as pi-slurm does.
    pi.sendMessage({ customType: MESSAGE, ...message, display: true }, { triggerTurn: true, deliverAs: "steer" });
  }
  function emitFinished(job: Job) {
    pi.events.emit("runai:finished", { id: job.id, name: job.name, project: job.project, cluster: job.cluster, status: job.lastState });
  }
  function update(job: Job, state: State): boolean {
    if (state === "UNKNOWN") return false; // Missing/unknown is NOT success or deletion.
    let changed = false;
    if (state !== job.lastState) {
      job.lastState = state;
      changed = true;
      if (state === "RUNNING") job.startedAt ??= new Date().toISOString();
      notify(job, `is ${state.toLowerCase()}. Read logs with runai_logs; container storage is ephemeral.`);
    }
    if (terminal(state) && !job.completionNotified) {
      job.completionNotified = true;
      emitFinished(job);
      changed = true;
    }
    if (state === "RUNNING" && job.notifyAfterMinutes && !job.reminderSent && job.startedAt
      && Date.now() - Date.parse(job.startedAt) >= job.notifyAfterMinutes * 60000) {
      job.reminderSent = true;
      notify(job, "has reached its running-time reminder; inspect its logs if useful.");
      changed = true;
    }
    return changed;
  }
  async function poll() {
    if (polling || ![...jobs.values()].some(j => !terminal(j.lastState))) return;
    polling = true;
    const epoch = generation;
    const signal = controller.signal;
    try {
      const config = parseConfig(await run(["config", "view", "--suppress-deprecation-message"], signal));
      const projects = new Set([...jobs.values()].filter(j => j.cluster === config.cluster && !terminal(j.lastState)).map(j => j.project));
      for (const project of projects) {
        const observations = await listing(project, signal);
        if (epoch !== generation) return;
        let changed = false;
        for (const job of jobs.values()) {
          if (job.cluster !== config.cluster || job.project !== project || terminal(job.lastState)) continue;
          changed = update(job, observations.get(job.name)?.state ?? "UNKNOWN") || changed;
        }
        if (changed) persist();
      }
    } catch {
      // Auth/network errors don't alter persisted states or start login prompts.
      // An explicit runai_jobs call surfaces diagnostics, unlike background polls.
    } finally { if (epoch === generation) polling = false; }
  }
  function stop() {
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined;
    controller.abort();
    controller = new AbortController();
    polling = false;
  }
  function restore(ctx: ExtensionContext) {
    stop();
    jobs = new Map();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const data = entry.data as { version?: number; jobs?: unknown[] } | undefined;
      if (data?.version === 1 && Array.isArray(data.jobs)) jobs = new Map(data.jobs.filter(isJob).map(job => [job.id, { ...job }]));
    }
    for (const job of jobs.values()) if (terminal(job.lastState)) emitFinished(job);
    timer = setInterval(() => { void poll(); }, interval);
    timer.unref?.();
    void poll();
  }
  async function tracked(id: string, signal?: AbortSignal): Promise<Job> {
    const job = jobs.get(id);
    if (!job) throw new Error("Unknown tracked ID. Use runai_track for an existing job first.");
    const current = await scope(job.project, signal);
    if (current.cluster !== job.cluster) throw new Error(`Cluster context changed: ${job.id} belongs to ${job.cluster}, not ${current.cluster}. Switch context manually first.`);
    return job;
  }
  function text(output: string) {
    const truncated = output.length > 32000;
    return { content: [{ type: "text" as const, text: truncated ? output.slice(0, 32000) + "\n[Output truncated; request fewer log lines or inspect with the Run:ai CLI.]" : output || "(none)" }], details: { truncated } };
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => stop());

  pi.registerTool({
    name: "runai_submit", label: "Submit Run:ai Job",
    description: "Submit and track a container workload with the Run:ai CLI v1. Training by default; no host compute, implicit mounts, privilege escalation or exposed services. State changes notify this Pi session.",
    promptGuidelines: [
      "Use runai_submit for Run:ai work instead of shell submission so lifecycle changes are reported without a polling loop.",
      "Choose an image and explicit existing PVC mounts; host paths are NOT automatically available in containers. Use training jobs for experiments and checkpoint for preemption.",
      "Never put credentials in command/environment parameters (Pi records tool calls). Use site-approved pre-existing Kubernetes secrets for private images.",
    ],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    parameters: Type.Object({
      project: projectSchema, name: Type.Optional(Type.String()), image: Type.String(),
      command: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Container argv overriding the image entrypoint, e.g. ['/bin/bash','-lc','python train.py']. Omit to keep image entrypoint." })),
      interactive: Type.Optional(Type.Boolean()), gpus: Type.Optional(Type.Number({ minimum: 0 })),
      cpus: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), memory: Type.Optional(Type.String()),
      working_directory: Type.Optional(Type.String({ description: "Container path, NOT the local working directory." })),
      pvc_mounts: Type.Optional(Type.Array(Type.Object({ claim: Type.String(), path: Type.String() }))),
      environment: Type.Optional(Type.Array(Type.Object({ name: Type.String(), value: Type.String() }), { description: "NON-SECRET environment values only." })),
      uid: Type.Optional(Type.Integer({ minimum: 0 })), gid: Type.Optional(Type.Integer({ minimum: 0 })),
      supplemental_groups: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
      node_pools: Type.Optional(Type.Array(Type.String())), large_shm: Type.Optional(Type.Boolean()),
      notify_after_minutes: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_id, params, signal) {
      const current = await scope(params.project, signal);
      const name = identifier(params.name || `pi-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, "job name");
      const id = identity(current.cluster, current.project, name);
      if (jobs.has(id) || (await listing(current.project, signal)).has(name)) throw new Error("Job name already exists/tracked. Choose a new name; do not overwrite a job.");
      const output = await run(submitArgs(params, name, current.project), signal, 60000);
      const job: Job = { id, name, ...current, interactive: params.interactive ?? false, submittedAt: new Date().toISOString(), lastState: "PENDING", notifyAfterMinutes: params.notify_after_minutes };
      jobs.set(id, job);
      persist();
      return text(`Submitted and tracked ${id}. Training=${!job.interactive}. ${output}\nUse runai_logs with this ID. No local directory was automatically mounted.`);
    },
  });

  pi.registerTool({
    name: "runai_track", label: "Track Existing Run:ai Job", description: "Adopt an existing job in the selected project into this session's monitor. Does not modify the cluster.", annotations,
    parameters: Type.Object({ name: Type.String(), project: projectSchema, interactive: Type.Optional(Type.Boolean({ description: "Whether this is an interactive job (needed for logs/deletion)." })) }),
    async execute(_id, params, signal) {
      const current = await scope(params.project, signal);
      const name = identifier(params.name, "job name");
      const observation = (await listing(current.project, signal)).get(name);
      if (!observation) throw new Error("Job not found in selected project.");
      const id = identity(current.cluster, current.project, name);
      if (!jobs.has(id)) {
        const job: Job = { id, name, ...current, interactive: params.interactive ?? false, submittedAt: new Date().toISOString(), lastState: observation.state };
        if (observation.state === "RUNNING") job.startedAt = new Date().toISOString();
        if (terminal(job.lastState)) { job.completionNotified = true; emitFinished(job); }
        jobs.set(id, job);
        persist();
      }
      return text(`Tracking ${id}: ${observation.raw}`);
    },
  });

  pi.registerTool({
    name: "runai_jobs", label: "Inspect Run:ai Jobs", description: "Show this session's tracked jobs and current observations, or all jobs in one selected project. Includes persisted terminal states. Use for diagnosis, not a wait loop.", annotations,
    parameters: Type.Object({ show_all: Type.Optional(Type.Boolean()), project: projectSchema }),
    async execute(_id, params, signal) {
      const current = await scope(params.project, signal);
      if (params.show_all) return text(await run(["list", "jobs", "--project", current.project, "--suppress-deprecation-message"], signal));
      const projects = new Set([...jobs.values()].filter(j => j.cluster === current.cluster && (!params.project || j.project === params.project)).map(j => j.project));
      const observations = new Map<string, Awaited<ReturnType<typeof listing>>>();
      for (const project of projects) observations.set(project, await listing(project, signal));
      return text([...jobs.values()].filter(j => !params.project || j.project === params.project).map(j => {
        const observation = observations.get(j.project)?.get(j.name);
        const live = j.cluster !== current.cluster ? "different cluster context (not queried)" : observation?.raw ?? "not visible (NOT evidence of completion)";
        return `${j.id} | recorded=${j.lastState} | current=${live}`;
      }).join("\n"));
    },
  });

  pi.registerTool({
    name: "runai_logs", label: "Read Run:ai Job Logs", description: "Read bounded logs of a tracked job (no follow/stream). Be careful: application logs may contain secrets. Save important artifacts to a PVC before deleting a job.", annotations,
    parameters: Type.Object({ job_id: jobSchema, tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })), timestamps: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      const job = await tracked(params.job_id, signal);
      return text(await run(["logs", job.name, "--project", job.project, job.interactive ? "--interactive" : "--train", "--tail", String(params.tail ?? 100), ...(params.timestamps ? ["--timestamps"] : []), "--suppress-deprecation-message"], signal));
    },
  });

  pi.registerTool({
    name: "runai_cancel", label: "Delete Run:ai Job", description: "Delete ONE tracked obsolete/invalid/wedged job and its resources. This removes container-local files and logs. Requires explicit confirmation; never deletes all jobs.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    promptGuidelines: ["Do not delete healthy jobs just because they run a long time. Preserve logs/artifacts on PVC storage first."],
    parameters: Type.Object({ job_id: jobSchema, reason: Type.String({ minLength: 1 }), confirm: Type.Boolean({ description: "Must be true after obtaining user approval to delete this specific job." }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!params.confirm || !params.reason.trim()) throw new Error("Deletion requires confirmation and a reason.");
      const job = await tracked(params.job_id, signal);
      if (ctx.hasUI && !(await ctx.ui.confirm("Delete Run:ai job?", `${job.id}\n${params.reason}\nContainer-local files and logs will be removed.`))) throw new Error("Deletion declined.");
      const output = await run(["delete", "job", job.name, "--project", job.project, job.interactive ? "--interactive" : "--train", "--suppress-deprecation-message"], signal, 60000);
      update(job, "CANCELLED");
      persist();
      return text(`Deleted ${job.id}: ${params.reason}\n${output}`);
    },
  });
}
