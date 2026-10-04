# pi-runai

Session-persistent **Run:ai CLI v1** submission and monitoring for [Pi](https://pi.dev). Inspired by [pi-slurm](https://github.com/jrhuebers/pi-slurm), but runs container workloads through Run:ai, not Slurm or the login host.

## Install

Requires a recent Pi with `agent_before_settle`/`agent_settled`, and an installed, configured, authenticated Run:ai CLI exposing `submit`, `list jobs`, `logs`, and `delete job`. Tested with Run:ai 2.24.86 (v1 command surface). CLI v2 is **not** supported yet.

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
| `runai_logs` | Fetch logs of a tracked job; default 100 lines, maximum 2,000, no follow |
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

The extension polls asynchronously every 15 seconds, once per tracked project in the current cluster, with no overlapping monitor polls. Start, state-change, completion and optional running-time reminder messages enter Pi's context. Active-turn notifications are batched at `agent_before_settle`, not injected into the editor's steering queue.

Job metadata is saved in the current Pi session branch. Reload, session restore and tree navigation rebuild that branch's tracking state. Monitoring stops on shutdown; it only runs while Pi is running. Terminal states are retained for inspection. Completed jobs are **not** automatically deleted.

Preemption/restarting is treated as pending, not failure. Authentication errors, missing jobs, unknown statuses and a different cluster context **never** imply successful completion. Background polling quietly retries; `runai_jobs` surfaces CLI errors and shows live observations beside recorded states. A job deleted externally may remain tracked with its last known state. There is no Slurm-style accounting history.

The v1 CLI has no structured `list jobs` output. This extension parses only the documented `NAME STATUS` columns, rejecting unfamiliar table headers. Unknown states remain unknown rather than guessed terminal states. Failed jobs aren't automatically relaunched.

### Configuration

| Environment variable | Default |
|---|---|
| `PI_RUNAI_PROJECT` | CLI default project; explicit tool argument takes precedence |
| `PI_RUNAI_CLI` | `runai` on PATH (or path to an approved CLI wrapper) |
| `PI_RUNAI_POLL_INTERVAL_MS` | `15000`, minimum `5000` |

### Event integration

Emits `runai:finished` with `{ id, name, project, cluster, status }` for completed, failed or cancelled tracked jobs. Restoring a terminal job re-emits this event for newly loaded listeners. This is a separate event from `slurm:finished`; sleep extensions must explicitly support it. No automatic `pi-sleep` integration is claimed.

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

Tests mock the scheduler; they do not launch or delete compute jobs.
