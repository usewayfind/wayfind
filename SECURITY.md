# Security Policy

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

Use [GitHub Security Advisories](https://github.com/usewayfind/wayfind/security/advisories/new) to report vulnerabilities privately. This is the preferred method.

Alternatively, email security@usewayfind.ai.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact

### What qualifies

- Code execution vulnerabilities in the CLI or hooks
- Data exfiltration from state files or journals
- Credential exposure in logs or output
- Authentication bypass in the Slack bot

### Response timeline

- **Acknowledge**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix**: Depends on severity, but we aim for patches within 2 weeks for critical issues

## Supported Versions

Only the latest version published to npm is supported with security updates.
