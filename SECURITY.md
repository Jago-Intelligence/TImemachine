# Security policy

TimeMachine is pre-release. The latest main-branch implementation is the only
maintained version; there is no production-supported deployment yet.

Do not include vulnerabilities, secrets or production incident data in public
issues. Use GitHub private vulnerability reporting if the repository enables it. Otherwise contact a maintainer privately. Maintainers
must establish a dedicated private reporting channel before public deployment.
Do not invent or rely on a security email address that has not been published.

Include affected versions, a minimal sanitized reproduction, impact and suggested
mitigation. Maintainers should acknowledge reports and coordinate fixes and
publication privately; no response-time guarantee is currently offered.

Capture and replay data can contain secrets and personal information. Sanitize
before transport, authenticate all remotely exposed services and enforce retention.
Never replay against production services or with production credentials. Logging
redaction is defense in depth, not a substitute for allowlisted fields.

The shared workspace should use individual accounts. Account login budgets persist
in workspace storage; legacy shared-password mode is for private local use. Run
replay only with reviewed images on an isolated development/staging host; the
built-in executor rejects production collector configuration. See the
[self-hosting security boundaries](docs/self-hosting.md#security-boundary-for-replay)
for ingress limits, production webhook egress controls, Docker host isolation and
nonce-based dashboard script policy. These controls still require correct host,
TLS, firewall, backup and secret-manager configuration.
