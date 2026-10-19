# Workspace accounts and project tokens

Account mode separates the collector's control-plane credential from SDK ingestion tokens. Users sign in individually with an email and password. Administrators manage accounts, memberships, project tokens and alerts; developers investigate and replay incidents for assigned projects.

## Enable account mode

Apply migrations, then configure these on both the collector and dashboard:

```dotenv
WORKSPACE_AUTH_MODE=accounts
WORKSPACE_ADMIN_EMAIL=admin@your-company.example
WORKSPACE_ADMIN_PASSWORD=your-initial-administrator-password
```

Source-operated administrators can use the provisioning helper in
[self-hosted setup](self-hosted-setup.md). Bootstrap creates the administrator only for
an empty workspace document. Changing environment values later does not reset its
password; use an existing administrator's account-management controls. Configure account
mode on both services; bootstrap password material belongs to collector infrastructure,
not application SDK configuration.

The root `TIMEMACHINE_AUTH_TOKEN` remains a private control-plane credential used by the dashboard's login connection. Once account mode is active, it cannot ingest failures or read incidents. Old shared-password dashboard cookies are rejected. Switching back to legacy mode deliberately restores the old shared access model; do not use it as an account-password reset mechanism.

## Projects and onboarding

Open **Workspace** in the dashboard as an administrator:

1. Create a project with a unique backend service name, such as `auth-api`.
2. Generate an ingestion token. The complete token is shown once; only its SHA-256 digest is stored.
3. Give the token to the backend developer through a private channel. Paste it into `timemachine/credentials.json`, never the public config or Git.
4. Set `service.name` in `timemachine/config.json` to the project's service name and set its collector URL.
5. Start the recorded backend and use `timemachine doctor` to check token access.

This first version defines one project per unique service name. Service environments and versions remain inside that project. It is one self-hosted workspace, not organization multitenancy. Existing incidents are preserved and belong to projects by their existing service names. Registered replay services are created as projects at first bootstrap; administrators may create projects for other historic services.

SDK tokens can only ingest incidents for their bound service and inspect their own service binding and replay-readiness registration. They cannot list/read incidents, access replay, use notification settings or manage users. Generate a replacement token, update/restart the backend, then revoke the old token to rotate. Revocation takes effect on subsequent requests; an already-admitted request can finish. Revoking a token does not delete captured incidents.

## Users and roles

Create an individual account with a temporary password and select its projects. No invitation email is sent in this version; share initial credentials privately. Users can change their own password on the Workspace page. Password changes and administrator password resets invalidate the user's existing sessions. Disabling an account also invalidates sessions. At least one active administrator must remain.

Developers only see authorized services in incident/issue list queries; access filters apply inside storage before pagination and aggregation. Direct incident, issue and replay URLs enforce the same project membership. Developers may verify and resolve issues in their projects. Notification credentials and global alert status are administrator-only.

Sessions use random opaque credentials, stored as SHA-256 digests in collector storage with eight-hour expiration. Dashboard cookies are signed, HttpOnly and SameSite=Strict, and Secure for HTTPS origins. Passwords use asynchronous scrypt with per-user random salts. Workspace mutations use optimistic revision checks to avoid lost updates. API responses omit password hashes, salts, session digests and token digests. Local memory storage is temporary; use PostgreSQL for durable users, projects and sessions.

## Upgrade and token rotation

Apply workspace migrations and deploy compatible collector/dashboard builds while
preserving existing database records and infrastructure secrets. Create projects for
historic service names and assign developer access deliberately. SDK applications need
project tokens in account mode; a former shared control-plane token does not become a
project token automatically. Revoked tokens require explicit replacements, not a restart.

## Current limits

There is no SSO, MFA, email invitation, password-reset email, organization multitenancy or security audit log yet. Administrators create/reset accounts explicitly. Restore access using another active administrator; changing the bootstrap environment does not reset stored credentials. Limits are 50 users, 50 projects, 200 retained token records and 250 concurrent stored sessions per workspace. Login requests are rate-limited; large distributed deployments need shared abuse controls. Project-specific alert subscriptions and managed hosted onboarding are not implemented.

## Select a project

In accounts mode, the sidebar lists only projects returned by the current user's
fresh workspace session. Pick one to investigate its issues, occurrences and replay
history. The first assigned project is selected initially. The preference is saved
in an HttpOnly, SameSite=Strict cookie (Secure on HTTPS); it is not an authorization
credential. Every page/API request resolves the cookie against current membership.
A removed or stale selection falls back to the first remaining project, and a user
with no projects gets an empty-access view instead of an aggregate issue list.

Switching returns to the issues page and drops the previous project's search filters,
cursors and detail URLs. A stale `service` URL filter cannot override the selected
project. Issue/occurrence/replay/resolution requests send the selection as
`x-timemachine-project` to the collector, which validates the UUID and membership and
applies its service scope before listing or allowing direct access. Even administrators
using the selected-project context cannot accidentally replay another project's
occurrence through that context. The collector's existing authenticated API remains
compatible when no selection header is supplied; project selection is a view within
a user's authorized memberships, not a replacement for authorization.

The project settings view lists the selected project's members and tokens. Existing
memberships outside the view are preserved when an administrator edits a user.
Creating a project selects the newly created project. Account roles, password changes
and the existing alert destinations remain workspace-wide and are labelled as such.
Changing projects does not reconfigure alert delivery or create isolated workspaces.
Legacy shared-password mode keeps its existing service-filter workflow.

Run `pnpm smoke:projects` from a source checkout to test two-project selection,
server-side filtering, direct links, replay access, CSRF rejection and membership
revocation against temporary services with synthetic credentials. No real alert
destinations are used by this check.
