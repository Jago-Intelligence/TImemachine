# TimeMachine documentation

## Use TimeMachine in a backend

- [Integration overview and package availability](integrations/README.md)
- [Express production setup and code examples](express-setup.md)
- [JavaScript](integrations/javascript.md) · [TypeScript](integrations/typescript.md)
- [Project configuration and private credentials](project-configuration.md)
- [SDK API and delivery lifecycle](node-sdk.md)
- [Automatic recording](automatic-recording.md)

## Investigate and reproduce

- [Dashboard](dashboard.md) · [Issue grouping, filters and lifecycle](issues.md)
- [Evidence-based cause explanations](cause-explanations.md)
- [Approved request evidence](failed-request-recording.md)
- [HTTP dependencies](http-dependency-recording.md)
- [PostgreSQL reads](postgres-recording.md) · [Synthetic PostgreSQL transactions](synthetic-postgres-replay.md)
- [Dependency adapter scope](dependency-adapters.md)
- [Replay overview, retention and backup](replay.md)
- [Automatic replay eligibility](automatic-replay.md)
- [Custom app factories and assertions](custom-express-replay.md)

## Operate a shared workspace

- [Architecture and infrastructure sketch](architecture.md)
- [Self-hosting boundaries](self-hosting.md) · [Administrator provisioning](self-hosted-setup.md)
- [Collector API and limits](collector.md) · [Incident storage](storage.md)
- [Accounts, project access and tokens](workspace-access.md)
- [Alerts and provider configuration](alerts.md)
- [Incident contract](incident-schema.md)

## Contribute and track releases

- [Development and checks](development.md)
- [Roadmap and beta-release gates](roadmap.md)
- [Changelog](../CHANGELOG.md) · [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

Packages remain unpublished; npm instructions describe the intended release workflow.
Contributor/source commands belong to development and administrator guides. A working
capture does not imply complete replay coverage or production qualification.
