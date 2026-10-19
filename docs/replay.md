# Isolated Express replay

Replay runs a developer-reviewed Express scenario in a trusted Docker image using
controlled recorded dependencies or reviewed synthetic fixtures. It compares the
original captured build with an updated build and checks declared business assertions.

Start with [Express replay setup](express-setup.md#add-isolated-replay). Packages are
currently unpublished; npm commands describe the intended release workflow. The
collector/dashboard and Docker host are deployed separately from your backend.

Containers have no external network, production credentials or host mounts. Historical
registrations are preserved, but required image files must still exist or have a verified
backup. Automatic generation is bounded to [supported recordings](automatic-replay.md);
custom scenarios use [app factories and assertions](custom-express-replay.md).

## Verification results and explicit resolution

New runner observations expose individual intended-status, error-code and business
assertion checks. Synthetic PostgreSQL scenarios also report rollback or committed-row
checks from their reviewed databaseChecks callback. Checks contain fixed identifiers
and passed/failed/not-checked values, not response bodies or database rows.

The dashboard compares captured and current build checks. Absence means Not reported,
including older runner images; it never implies a pass. Response checks compare against
the registered success target, so a captured failure can legitimately reproduce while
its success checks fail. Update/register the runner and capture a new occurrence if
adding checks changes its scenario contract hash.

After successful current-build verification, Mark issue resolved is an explicit action.
New occurrences reopen the issue. See [issue lifecycle](issues.md#resolution-and-reopening).

## Historical build retention

Registration preserves previous image IDs; it no longer silently drops builds after
10 registrations. Each service accepts up to 1,000 registered builds. At that bound,
registration fails rather than evicting historical builds. The registry file remains
bounded to 256 KiB, which may be reached earlier for complex manifests.

Keep Docker images or archive them in your container registry while retained captures
reference them. TimeMachine does not run Docker pruning or delete images automatically.
A newer build does not reconstruct a deleted original image.

Administrators can inspect `GET /v1/replay/retention`. It reports registered builds,
reference counts and retention deadlines, protects current builds, and lists captures
whose artifacts are not registered. Expired captures stop protecting their builds.
This is a read-only cleanup report: no images or registrations are deleted. Coordinate
manual cleanup with recording applications; an unreferenced build can still be in use
by an application that has not yet sent a failure.

The replay panel distinguishes missing registration, missing Docker image and an
unreachable Docker engine, and exposes the exact captured image ID for recovery.

## Private-registry backup and recovery

Add `backupRepository` to `timemachine/replay.json`:

```json
{
  "version": 1,
  "runner": "timemachine/replay-runner.mjs",
  "files": ["package.json", "package-lock.json", "src", "timemachine/replay-runner.mjs"],
  "backupRepository": "registry.company.com/team/api-replay"
}
```

Authenticate Docker on the build machine with push permissions and on the replay
host with pull permissions, preferably using Docker credential helpers. Keep these
credentials out of TimeMachine JSON files and version control. The Docker daemon must
trust the registry's TLS certificate. TimeMachine does not configure registry access.

`timemachine replay build` pushes the image and records its immutable repository
manifest digest alongside the captured Docker image ID. A failed backup does not
advance the recorder configuration. The local image registration may already exist;
retry after fixing registry access. Deploy the updated registry JSON to the collector
host as usual. This command uploads images, not collector configuration.

If an image is missing locally, the collector automatically pulls ONLY its configured
backup digest. It verifies the restored image ID against the captured artifact before
allowing replay. The dashboard shows Backed up, Restoring, Ready, or Recovery failed;
restoration status refreshes automatically. Failed restores wait one minute before a
refresh triggers another attempt. No backup is shown explicitly for older builds.

Backups are opt-in. Previously deleted images cannot be recovered unless that exact
build was archived. Keep private-registry manifests from garbage collection while
retained incidents reference them; TimeMachine does not delete remote images or
configure the registry's retention policy. Use the retention report to plan cleanup.
