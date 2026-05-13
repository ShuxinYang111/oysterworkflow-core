# Security Policy

## Supported Versions

Security reports are accepted for the current `main` branch.

## Reporting A Vulnerability

Please do not disclose security issues in a public GitHub issue.

Send reports to `shuxin.y.97@gmail.com` with:

- a short description of the issue
- affected command or module
- reproduction steps, using synthetic data when possible
- potential impact
- any suggested mitigation

Do not include real Screenpipe traces, secrets, private OCR text, or API keys in
the report unless we explicitly agree on a secure transfer method.

## Scope

In scope:

- accidental persistence or exposure of sensitive trace data
- API key handling issues
- unsafe file writes or path traversal
- command execution vulnerabilities
- dependency vulnerabilities with a practical exploit path

Out of scope:

- reports requiring access to private user machines or accounts
- issues caused by intentionally publishing private traces
- denial-of-service reports without a realistic usage scenario
