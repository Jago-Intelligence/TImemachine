# Self-hosted workspace setup

Express developers use `timemachine/config.json` and a private `credentials.json`. The person hosting the collector/dashboard provisions infrastructure separately. Notification providers are configured in Dashboard → Alerts.

## Source-operated administrator setup

After installing repository dependencies, run:

```sh
pnpm workspace:setup
```

This generates missing local defaults and strong secrets in the ignored root `.env` with permissions 600: collector settings, PostgreSQL connection/password, dashboard origin/password/session secret and the notification encryption key. Existing nonempty values and unrelated settings are preserved. Re-running does not rotate credentials. Invalid settings are reported without secret values.

Start storage and apply migrations:

```sh
pnpm db:up
pnpm db:migrate
```

Start these in separate terminals:

```sh
pnpm start:collector
pnpm start:dashboard
```

Open the dashboard origin (default http://127.0.0.1:4321). To view your password locally:

```sh
pnpm workspace:password
```

That command deliberately prints your dashboard password. Do not share its output in logs/screenshots. Setup does not print secrets. In account mode, generate a project ingestion token in the Workspace page and put it into the backend's private credential file. Keep the infrastructure control-plane token private. Account mode supports individual users and project ingestion tokens. See [Workspace access](workspace-access.md). Hosted onboarding is not implemented yet.

Configure providers in Dashboard → Alerts. Their credentials do not belong in an Express application's config.

## Keep and back up secrets

Root `.env` is generated **and still required** for self-hosting. Back it up with the database. The ignored `.timemachine/infrastructure.json` marker contains protected field names, not values. After initialization, missing protected secrets cause a recovery error rather than automatic regeneration. Restore the original `.env`; do not delete the marker to repair a workspace.

Fresh initialization cannot recover an existing database password or decrypt notifications without their original encryption key. This version does not implement encryption-key rotation.

Setup provides local development defaults. It does not install Docker, start services, deploy a website, configure DNS or provide production hardening. Deployment operators must choose HTTPS origins, database TLS, networking and secret storage. Services still support deployment environment variables. Replay executes trusted application images through controlled Docker access; this is not a managed hosting service or hostile-code isolation guarantee.
