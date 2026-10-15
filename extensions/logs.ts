import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Job } from "./core.js";

const LIMIT = 32000;
export interface LogCapture {
  create(cwd: string, name: string): string;
  follow(job: Job): Promise<void>;
  finish(job: Job): Promise<void>;
  stopAll(cluster?: string): void;
  stopJob(id: string): void;
}

function openLog(file: string, exclusive = false): number {
  if (!fs.lstatSync(path.dirname(file)).isDirectory()) throw new Error("Run:ai log directory must not be a symlink.");
  return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW
    | (exclusive ? fs.constants.O_EXCL : fs.constants.O_APPEND), 0o600);
}

/** A bounded, UTF-8-safe tail; never discard the newest traceback. */
export function tailPreview(output: string, lines = 2000) {
  const bytes = Buffer.from(output);
  let start = Math.max(0, bytes.length - LIMIT);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  const tail = bytes.subarray(start).toString("utf8");
  const parts = tail.replace(/\n$/, "").split("\n");
  return { text: parts.slice(-lines).join("\n"), truncated: start > 0 || parts.length > lines };
}

export function localTail(file: string, lines: number) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, LIMIT));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    const preview = tailPreview(buffer.subarray(start).toString("utf8"), lines);
    return { ...preview, truncated: preview.truncated || size > buffer.length };
  } finally { fs.closeSync(fd); }
}

/** Save the entire requested response, not just the model-facing preview. */
export function saveSnapshot(logPath: string, output: string): string {
  const file = `${logPath}.snapshot-${randomBytes(6).toString("hex")}.out`;
  const fd = openLog(file, true);
  try { fs.writeFileSync(fd, output); } finally { fs.closeSync(fd); }
  return file;
}

type Active = { cluster: string; child: ChildProcess; done: Promise<void> };

/** Capture stdout directly to disk: no unbounded in-memory log buffer. */
export class RunaiLogCapture implements LogCapture {
  private readonly active = new Map<string, Active>();
  private epoch = 0;
  private cluster?: string;
  constructor(private readonly cli: string, private readonly verifyCluster?: (cluster: string) => Promise<void>) {}

  create(cwd: string, name: string): string {
    const directory = path.resolve(cwd, process.env.PI_RUNAI_LOG_DIR || "runai-logs");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Run:ai log directory must not be a symlink.");
    const file = path.join(directory, `${name}-${randomBytes(8).toString("hex")}.out`);
    fs.closeSync(openLog(file, true));
    return file;
  }

  follow(job: Job): Promise<void> {
    return this.active.get(job.id)?.done ?? this.start(job, true);
  }

  async finish(job: Job): Promise<void> {
    const epoch = this.epoch;
    const previous = this.active.get(job.id);
    if (previous) {
      this.terminate(previous.child);
      await previous.done.catch(() => {});
    }
    if (epoch !== this.epoch || (this.cluster && this.cluster !== job.cluster)) throw new Error("Log capture context changed.");
    await this.verifyCluster?.(job.cluster);
    if (epoch !== this.epoch || (this.cluster && this.cluster !== job.cluster)) throw new Error("Log capture context changed.");
    await this.start(job, false);
  }

  stopAll(currentCluster?: string): void {
    if (currentCluster === undefined) this.epoch++;
    this.cluster = currentCluster;
    for (const capture of this.active.values()) {
      if (currentCluster === undefined || capture.cluster !== currentCluster) this.terminate(capture.child);
    }
  }

  stopJob(id: string): void {
    const capture = this.active.get(id);
    if (capture) this.terminate(capture.child);
  }

  private terminate(child: ChildProcess): void {
    child.kill("SIGTERM");
    const escalation = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
    escalation.unref();
    child.once("close", () => clearTimeout(escalation));
  }

  private start(job: Job, follow: boolean): Promise<void> {
    if (!job.logPath) return Promise.reject(new Error("No local log path is allocated."));
    let out: number;
    let err: number;
    try {
      out = openLog(job.logPath);
      try { err = openLog(`${job.logPath}.capture.log`); }
      catch (error) { fs.closeSync(out); throw error; }
      // Reconnection/final snapshots can replay output; mark boundaries rather
      // than silently deduplicating legitimate identical application messages.
      try { fs.writeSync(out, `\n[pi-runai ${follow ? "live capture" : "final snapshot"} ${new Date().toISOString()}]\n`); }
      catch (error) { fs.closeSync(out); fs.closeSync(err); throw error; }
    } catch (error) { return Promise.reject(error); }
    let child: ChildProcess;
    try {
      child = spawn(this.cli, ["logs", job.name, "--project", job.project,
        job.interactive ? "--interactive" : "--train", "--timestamps", "--tail", "-1",
        ...(follow ? ["--follow"] : []), "--suppress-deprecation-message"],
      { stdio: ["ignore", out, err] });
    } catch (error) {
      fs.closeSync(out); fs.closeSync(err);
      return Promise.reject(error);
    }
    fs.closeSync(out); fs.closeSync(err);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Log capture ${signal ? `stopped by ${signal}` : `exited ${code}`}; diagnostics: ${job.logPath}.capture.log`));
      });
      if (!follow) timeout = setTimeout(() => this.terminate(child), 15000);
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      if (this.active.get(job.id)?.child === child) this.active.delete(job.id);
    });
    this.active.set(job.id, { cluster: job.cluster, child, done });
    return done;
  }
}
