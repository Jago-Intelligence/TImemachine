# Development

## Setup and checks

Install Node.js 24 and pnpm 11.25.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm check
```

CI runs the same checks on Node.js 24. Dependency versions are pinned by the
committed lockfile. The workspace enforces a one-day minimum release age for
newly resolved dependencies. Review dependency updates rather than bypassing it.

```sh
pnpm --filter @timemachine/config test
pnpm --filter @timemachine/logger typecheck
pnpm build
pnpm format
```

Turbo builds upstream packages before consumers when dependencies are introduced.
Collector process tests depend on compiled entrypoints. The Node SDK depends on
core, Zod and TypeScript for approved source inspection; application framework and
database observation resolve supported dependencies from the consumer app. Tests
and type checks live in each package; ESLint and formatting run at the root.
Build output is `dist` and must not be committed.

## Conventions

Use strict TypeScript and ESM. Server imports use `.js` extensions so emitted
code runs in Node. Export public entry points through package manifests. Prefer
small modules grouped by responsibility; avoid unrelated utility collections and
premature generic service layers.

Validate external inputs at boundaries. Throw typed domain errors where callers
need to distinguish failures, and translate errors to API responses in services.
Keep constructors free of network side effects. Pass dependencies explicitly.
Use constant log messages with reviewed structured fields. Never interpolate
request data, URLs with credentials, tokens, error messages or stacks into logs.

Configuration parsing accepts a supplied environment map. Applications will own
`.env` loading and should fail before listening if parsing fails. The collector
commands load the root `.env` with Node.js before parsing. A token
is required for collector startup on every interface. Current config includes a
PostgreSQL settings; `DATABASE_URL` is mandatory for the PostgreSQL driver. Collector
authentication is enforced and tested; dashboard session authentication is implemented.

Tests belong in `test/*.test.ts` beside each package. Test boundary behavior,
failure handling and security constraints. Database and future sandbox tests must
use disposable infrastructure and sanitized fixtures. Keep tests independent of
production services, secrets and optional AI providers.

## Adding a package

Create `packages/<name>/package.json`, `src/index.ts` and the two TypeScript
configs using an existing package as a reference. Provide build, typecheck and
test scripts, Apache-2.0 licensing and explicit exports. Declare internal
references with `workspace:*`. Keep packages private until release packaging is
verified. Add focused tests and update the architecture and changelog.

Do not commit local tool settings, transcripts, secrets, logs, cache directories,
or disposable generated artifacts. Reviewed documentation images and their reproducible
sources may be committed deliberately. No repository hooks are required to contribute; CI is
the common verification boundary.

PostgreSQL integration tests run separately with `pnpm test:storage`, and also run
in CI against a disposable PostgreSQL service. See [storage setup](storage.md).

The dashboard uses Next.js-generated route types; its typecheck runs `next typegen`
before TypeScript. `pnpm smoke:dashboard` exercises the built dashboard with a
synthetic collector and credentials. See [dashboard development](dashboard.md).

## Source packages before npm publication

This is contributor/source operation, not the released application's installation path.
Build the packages with `pnpm build`. `pnpm pack` can create SDK/core/replay archives for
an isolated installation test; workspace dependencies must be resolved to the matching
archives until published versions exist. Keep test projects and archives outside Git.

The repository example is an internal end-to-end fixture; `pnpm demo` is a contributor
launcher, not a required command for application users. Source-operated infrastructure
helpers are documented in [administrator setup](self-hosted-setup.md).

SDK queues, scoped access, replay identity/fixtures and migrations need meaningful
regression coverage. Contract tests with doubles do not replace live adapter or registry
validation against deployment infrastructure.
