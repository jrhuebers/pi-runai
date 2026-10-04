export type State = "PENDING" | "RUNNING" | "SUSPENDED" | "COMPLETED" | "FAILED" | "CANCELLED" | "UNKNOWN";
export type Job = {
  id: string; name: string; project: string; cluster: string; interactive: boolean;
  submittedAt: string; lastState: State; startedAt?: string;
  notifyAfterMinutes?: number; reminderSent?: boolean; completionNotified?: boolean;
};
export function terminal(state: State): boolean {
  return ["COMPLETED", "FAILED", "CANCELLED"].includes(state);
}
export function normaliseState(raw: string): State {
  switch (raw.toLowerCase().replace(/[-_ ]/g, "")) {
    case "running": return "RUNNING";
    case "pending": case "queued": case "creating": case "initializing": case "scheduling":
    case "containercreating": case "restarting": case "preempted": return "PENDING";
    case "suspended": case "paused": return "SUSPENDED";
    case "succeeded": case "completed": return "COMPLETED";
    case "failed": case "error": return "FAILED";
    case "cancelled": case "canceled": case "deleted": return "CANCELLED";
    default: return "UNKNOWN";
  }
}
// CLI v1 list has no JSON output. Parse only NAME and STATUS, not mutable AGE,
// IMAGE, USER or pod-count columns. Reject unknown layouts rather than guessing.
export function parseJobs(output: string): Map<string, { state: State; raw: string }> {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const header = lines.findIndex(line => /^\s*NAME\s+STATUS\b/.test(line));
  if (header < 0) throw new Error("Unrecognised Run:ai job listing (requires CLI v1 NAME/STATUS table).");
  const jobs = new Map<string, { state: State; raw: string }>();
  for (const line of lines.slice(header + 1)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)/);
    if (match && /^[a-z0-9][a-z0-9-]*$/.test(match[1])) {
      jobs.set(match[1], { state: normaliseState(match[2]), raw: match[2] });
    }
  }
  return jobs;
}
export function identifier(value: string, label: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) || value.length > 63) {
    throw new Error(`Invalid ${label}: use a lowercase DNS label (max 63 characters).`);
  }
  return value;
}
export function identity(cluster: string, project: string, name: string): string {
  return `${cluster}/${project}/${name}`;
}
export function parseConfig(output: string): { cluster: string; project?: string } {
  const cluster = output.match(/\bCluster:\s*([^\s"']+)/)?.[1];
  const project = output.match(/\bProject:\s*([^\s"']+)/)?.[1];
  if (!cluster || cluster === "<none>" || cluster === "-" || cluster === "none") {
    throw new Error("No Run:ai cluster configured. Configure/login manually with the site instructions.");
  }
  return { cluster, project: project && !["<none>", "-", "none"].includes(project) ? project : undefined };
}
export type Submit = {
  name?: string; image: string; command?: string[]; interactive?: boolean; gpus?: number;
  cpus?: number; memory?: string; working_directory?: string;
  pvc_mounts?: { claim: string; path: string }[];
  environment?: { name: string; value: string }[];
  uid?: number; gid?: number; supplemental_groups?: number[];
  node_pools?: string[]; large_shm?: boolean; notify_after_minutes?: number;
};
function safeValue(value: string, label: string): string {
  if (!value || value.startsWith("-") || value.includes("\0")) throw new Error(`Invalid ${label}.`);
  return value;
}
export function submitArgs(params: Submit, name: string, project: string): string[] {
  const args = ["submit", "--name", identifier(name, "job name"), "--project", identifier(project, "project"),
    "--image", safeValue(params.image, "image"), "--gpu", String(params.gpus ?? 0)];
  if (params.interactive) args.push("--interactive");
  if (params.cpus !== undefined) args.push("--cpu", String(params.cpus));
  if (params.memory) args.push("--memory", safeValue(params.memory, "memory"));
  if (params.working_directory) args.push("--working-dir", safeValue(params.working_directory, "working directory"));
  for (const mount of params.pvc_mounts ?? []) {
    identifier(mount.claim, "PVC claim");
    if (!mount.path.startsWith("/") || /[,\0]/.test(mount.path)) throw new Error("PVC mount path must be absolute and contain no comma or NUL.");
    args.push("--existing-pvc", `claimname=${mount.claim},path=${mount.path}`);
  }
  for (const env of params.environment ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.name) || env.value.includes("\0")) throw new Error("Invalid environment variable.");
    args.push("--environment", `${env.name}=${env.value}`);
  }
  if (params.uid !== undefined) args.push("--run-as-uid", String(params.uid));
  if (params.gid !== undefined) args.push("--run-as-gid", String(params.gid));
  if (params.supplemental_groups?.length) args.push("--supplemental-groups", params.supplemental_groups.join(","));
  if (params.node_pools?.length) args.push("--node-pools", params.node_pools.map(v => identifier(v, "node pool")).join(","));
  if (params.large_shm) args.push("--large-shm");
  // Global option must precede '--', otherwise it becomes a container argument.
  args.push("--suppress-deprecation-message");
  if (params.command) {
    if (!params.command.length || params.command.some(v => v.includes("\0"))) throw new Error("Command must be a non-empty argv array without NULs.");
    args.push("--command", "--", ...params.command);
  }
  return args;
}
export function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object") return false;
  const j = value as Job;
  return [j.id, j.name, j.project, j.cluster, j.submittedAt].every(v => typeof v === "string" && !!v)
    && typeof j.interactive === "boolean"
    && ["PENDING", "RUNNING", "SUSPENDED", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"].includes(j.lastState)
    && j.id === identity(j.cluster, j.project, j.name);
}
