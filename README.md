# pi-runai

Session-persistent **Run:ai CLI v1** submission and monitoring for [Pi](https://pi.dev). Inspired by [pi-slurm](https://github.com/jrhuebers/pi-slurm), but runs container workloads through Run:ai, not Slurm or the login host.

## Install

Requires a recent Pi with extension steering notifications, and an installed, configured, authenticated Run:ai CLI exposing `submit`, `list jobs`, `logs`, and `delete job`. Tested with Run:ai 2.24.86 (v1 command surface). CLI v2 is **not** supported yet.

```sh
pi install git:github.com/jrhuebers/pi-runai
```

Run `/reload` in an existing Pi session. Authentication and cluster/project configuration remain manual: follow your site's documentation, then `runai login` and select your cluster/project. The extension never reads kubeconfig/auth files, performs login, or changes contexts.

## Tools

| Tool | Purpose |
|---|---|
| `runai_submit` | Submit a container and track its state; training by default |
| `runai_track` | Adopt an existing named job; specify `interactive: true` if appropriate |
| `runai_jobs` | Inspect tracked jobs, or `show_all: true` for one selected project |
| `runai_logs` | Fetch and save recent logs, or read the retained local log; default 100 lines, maximum 2,000 |
| `runai_cancel` | Delete one tracked job after approval, with a reason and `confirm: true` |

Job IDs are `cluster/project/name`, not numeric scheduler IDs. All job commands pass an explicit project. A changed cluster context prevents logs/deletion of jobs belonging to another cluster. Cancellation also requests a confirmation dialog when Pi has a UI. In non-UI mode the caller must obtain approval before setting `confirm: true`.

Example `runai_submit` arguments (replace placeholders using your site's image, PVC, UID/GID, and container paths):

```json
{
  "project": "lab-user",
  "name": "experiment-001",
  "image": "registry.example.org/lab/training:tag",
  "gpus": 1,
  "cpus": 4,
  "memory": "16G",
  "pvc_mounts": [{ "claim": "lab-scratch", "path": "/scratch" }],
  "working_directory": "/scratch/user/project",
  "command": ["/bin/bash", "-lc", "python train.py"],
  "notify_after_minutes": 30
}
```

- `command` is container **argv**, overriding the image entrypoint. Omit it to retain the image's entrypoint. A shell is used only if you explicitly request one; choose a shell available in your image.
- GPU requests support fractions; omitted `gpus` means **0**, avoiding accidental GPU consumption.
- Supported options include CPU/memory requests, explicit existing PVCs, non-secret environment variables, UID/GID/supplemental groups, node pools, and large shared memory. No arbitrary extra CLI flags, host-path mounts, privilege escalation, externally exposed services, or automatic PVC creation.
- No current local directory is implicitly mounted. Container-local storage is ephemeral: mount an approved PVC and save checkpoints/artifacts there. Preserve logs before deletion.
- Never put credentials in tool parameters: Pi records tool calls. Use site-approved pre-existing Kubernetes secrets for private images. Application logs can contain sensitive data; inspect them carefully.

## Monitoring

The extension polls asynchronously every 5 seconds, once per tracked project in the current cluster, with no overlapping monitor polls. Start, state-change, completion and optional running-time reminder messages enter Pi's context. Notifications are queued immediately with `deliverAs: "steer"` and `triggerTurn: true`, matching pi-slurm: an active run receives them at its next eligible model continuation, while an idle session starts a continuation. They are not buffered until `agent_before_settle` or flushed from `agent_settled`. Polling and CLI latency still apply, and notifications do not interrupt an executing tool; use pi-sleep's `runai_job_ids` to wake a watched sleep.

Job metadata is saved in the current Pi session branch. Reload, session restore and tree navigation rebuild that branch's tracking state. Monitoring stops on shutdown; it only runs while Pi is running. Terminal states are retained for inspection. Completed jobs are **not** automatically deleted.

Preemption/restarting is treated as pending, not failure. Authentication errors, missing jobs, unknown statuses and a different cluster context **never** imply successful completion. Background polling quietly retries; `runai_jobs` surfaces CLI errors and shows live observations beside recorded states. A job deleted externally may remain tracked with its last known state. There is no Slurm-style accounting history.

The v1 CLI has no structured `list jobs` output. This extension parses only the documented `NAME STATUS` columns, rejecting unfamiliar table headers. Unknown states remain unknown rather than guessed terminal states. Failed jobs aren't automatically relaunched.

## Persistent logs

Like pi-slurm's `slurm-logs/`, new submissions and tracked jobs get a local `runai-logs/<name>-<unique-id>.out` file in the agent's working directory. Its absolute path is saved in session metadata and included in submission/tracking results, notifications, `runai_jobs`, and `runai:finished`. Existing sessions acquire paths on reload. Set `PI_RUNAI_LOG_DIR` to override the directory; relative overrides resolve from the working directory. New log directories are private (`0700`) and files are private (`0600`). Files are retained after job deletion; there is no automatic log cleanup.

Run:ai does not provide Slurm's `--output` submission option, so capture uses a local, non-shell `runai logs --follow --timestamps --tail -1` process while a running pod is observed. Output goes directly to disk, not an unbounded in-memory buffer. CLI stderr goes to the adjacent `.capture.log` diagnostics file instead of the terminal or application log. The extension retries an ended stream at a later monitor poll, stops it on observed preemption/suspension, and resumes when the job runs again. Cluster-context changes, tree navigation, reload, and shutdown stop owned captures. Terminal detection immediately notifies Pi and wakes sleep; a final full available-log snapshot runs independently and does not delay completion delivery. Short jobs that finish between polls also receive a final snapshot.

This is a **best-effort local archive**, not a guarantee of complete Kubernetes log history. Capturing stops when Pi stops; removed/restarted pods, rotation, or network failures can leave gaps. Reconnection and final snapshots may replay lines; explicit capture-boundary markers delimit attempts rather than silently dropping identical application messages. Multi-pod jobs require explicit inspection of the relevant pods. For authoritative complete experiment logs across preemption or Pi downtime, configure the workload to write logs to a mounted PVC; merely mounting the PVC does not redirect stdout/stderr. The extension never changes your container argv or image entrypoint to add a logging wrapper.

`runai_logs` saves the **entire requested response** to a private snapshot file before returning a bounded, UTF-8-safe preview of the **newest** output. The result gives both the snapshot path and continuous archive path; snapshot files contain only the requested pod/tail, not necessarily the whole job history. Optional `pod` selects a particular pod. If live logs are unavailable, the tool returns a clearly labelled local fallback. Use `local: true` to read retained output without contacting Run:ai, including after job deletion or a cluster-context change. Local capture uses timestamps regardless of the live-read `timestamps` option. `runai_jobs` reports capture status and failures.

`runai_cancel` attempts a final snapshot **before** deleting the job. If capture fails, deletion is refused unless the user explicitly approves `allow_log_loss: true` (also relevant to pending jobs without a pod). Already captured local files are never removed by cancellation. Log files and snapshots can contain secrets from the application; keep them private and do not commit them.

### Configuration

| Environment variable | Default |
|---|---|
| `PI_RUNAI_PROJECT` | CLI default project; explicit tool argument takes precedence |
| `PI_RUNAI_CLI` | `runai` on PATH (or path to an approved CLI wrapper) |
| `PI_RUNAI_POLL_INTERVAL_MS` | `5000`, minimum `5000` |
| `PI_RUNAI_LOG_DIR` | `runai-logs/` in the agent working directory |

### Event integration

Emits `runai:finished` with `{ id, name, project, cluster, status, logPath }` for completed, failed or cancelled tracked jobs. Restoring a terminal job re-emits this event for newly loaded listeners. This is a separate event from `slurm:finished`; sleep extensions must explicitly support it. With a [pi-sleep](https://github.com/jrhuebers/pi-sleep) revision that exposes `runai_job_ids`, pass the full tracked IDs to `sleep({ seconds: 3600, message: "Inspect the job logs.", runai_job_ids: ["cluster/project/name"] })` to interrupt a wait on any listed terminal job. Older pi-sleep revisions supporting only background tasks and Slurm must be updated. Detection follows this extension's polling cadence; preemption, unknown states and missing jobs never imply completion.

## RCP documentation consulted

The implementation follows the CLI syntax and workflow in EPFL RCP's documentation, without embedding account-specific configuration:

- [Run:ai quickstart](https://wiki.rcp.epfl.ch/en/home/CaaS/FAQ/how-to-use-runai)
- [Job submission demo: PVCs and UID/GID](https://wiki.rcp.epfl.ch/en/home/CaaS/FAQ/how-to-submit-job-demo)
- [Storage/data journey](https://wiki.rcp.epfl.ch/en/home/CaaS/storage-data-journey)
- [Public service description](https://www.epfl.ch/research/facilities/rcp/rcp-cluster-service-description/)

RCP's wiki requires the EPFL network/VPN. Training jobs can be preempted and restarted: implement checkpointing. Interactive limits and eligible GPU models are site policy, not hardcoded by this portable extension.

## Development

Install dev dependencies with `npm install --legacy-peer-deps`. For local development, make the peer packages `@earendil-works/pi-coding-agent` and `typebox` available from your Pi installation (or install compatible versions with `--no-save`). Pi supplies these peers when loading managed packages.

```sh
npm run typecheck
npm test
```

Tests mock the scheduler and run isolated fake CLI subprocesses to validate disk capture; they do not launch or delete compute jobs. Optional sleep integration tests should use a pi-sleep source checkout whose test harness supplies a mock log-capture adapter, so they cannot contact the live Run:ai CLI.
