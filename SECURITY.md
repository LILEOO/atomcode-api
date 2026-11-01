# Security policy

This project is a local-only gateway for a non-official upstream integration.
Treat it as security-sensitive because it stores an AtomCode refresh token and
adds a local API key in front of model access.

## Boundaries

- The HTTP server binds only to `127.0.0.1` and rejects non-loopback `Host` headers.
- `/v1/*` requires the locally generated API key.
- AtomCode access and refresh tokens are never returned downstream or printed.
- Model traffic is restricted to `https://llm-api.atomgit.com`; redirects and
  arbitrary targets are refused before credentials are attached.
- OAuth and CodingPlan metadata reads are bounded and use official endpoint
  families only.
- `config.json` and `auth.json` are written atomically with mode `0600`.

## Reporting

Do not publish credentials or exploitable routing details publicly. Open a
private security advisory in the repository where this project is hosted and
include a minimal reproduction with all tokens, account identifiers and local
paths removed.
