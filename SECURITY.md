# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `materios-gateway`, please **do not** open a public issue.

Instead, report it privately to: **fluxpointstudios@gmail.com**

We aim to acknowledge reports within 48 hours and ship a fix or mitigation within 7 days for critical issues.

## Scope

This repository ships the gateway service that:

- Stores and serves Materios blob data (manifests + chunks)
- Tracks attestor + observer registries
- Implements 402-style billing for paid endpoints
- Surfaces explorer JSON APIs and oracle metadata

Vulnerabilities of interest include — but are not limited to — auth bypasses, signature-verification flaws, cross-tenant data leaks, SQL/command injection, and chain-trust assumptions that can be subverted.

## Out of Scope

- DoS / resource exhaustion (handled by upstream rate-limiting + ops watchdogs)
- Outdated transitive dependencies without a concrete exploit path
- Issues that require admin-token compromise (admin tokens are deployment secrets, not network-reachable)

## Disclosure

We will credit reporters in release notes unless anonymity is requested.
