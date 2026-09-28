# Central Legal Agent — isolated synthetic staging runtime

This package is an isolated deployment candidate for the Central Jurídica → Legal Agent pre-real-matter staging path.

## Hard boundaries

- disabled by default;
- requires `CJ_LEGAL_AGENT_STAGING_ENABLED=true`;
- requires `CJ_LEGAL_AGENT_STAGING_ENV=STAGING`;
- requires `CJ_LEGAL_AGENT_STAGING_DATA_MODE=SYNTHETIC`;
- uses only the fixed synthetic fixture from the governed staging bridge;
- uses a fixed synthetic `lawyer` identity and capability receipt;
- accepts no arbitrary request body;
- web search is disabled;
- file input is disabled;
- provider transport is a deterministic synthetic stub;
- no database is used;
- no client/process data is accepted;
- no filing or PJe-Calc path exists;
- no production authority and no real-matter authority can be granted.

## Endpoints

- `GET /health`: process/config health; remains HTTP 200 even when disabled.
- `GET /ready`: HTTP 200 only when all staging flags are explicitly correct.
- `POST /api/staging/synthetic`: executes the fixed synthetic staging fixture. Any non-empty request body is rejected.
- `GET /api/staging/evidence`: returns sanitized digests/status only; no matter/source text.

## Promotion boundary

Passing the container smoke proves packaging and isolated synthetic execution only. It is not connected to Central production authentication, a real Legal Agent provider session, a real matter resolver, or a Railway staging environment.

Creating a cloud staging environment/service is a separate infrastructure decision.
