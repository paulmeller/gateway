# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly. **Do not open a public GitHub issue.**

Email **security@agentstep.com** with:

- Description of the vulnerability
- Steps to reproduce
- Affected component (core, CLI, server)
- Severity estimate (critical, high, medium, low)

## Response Timeline

- **Acknowledge**: within 48 hours
- **Triage**: within 1 week
- **Fix**: depends on severity, critical issues are prioritized

## Scope

In scope:
- Authentication/authorization bypasses
- SQL injection or command injection
- Secret exposure
- Denial of service in the core engine

Out of scope:
- Issues requiring physical access to the host
- Social engineering
- Vulnerabilities in upstream dependencies (report those to the dependency maintainer)

## Disclosure

We will coordinate disclosure with you and credit you in the release notes unless you prefer anonymity.
