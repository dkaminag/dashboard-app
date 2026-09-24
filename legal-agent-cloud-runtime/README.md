# Legal Agent Cloud — deployment snapshot

This directory is a **deployment snapshot only**.

Authoritative Source of Truth:

- repository: `dkaminag/san-systems-master`
- commit: `7a0694c8d9f72b49d8e64842af53140a8d955593`
- canonical application path: `systems/legal-agent-cloud/`
- canonical legal skill: `skills/legal-counsel-br/SKILL.md`

The files in this directory were copied byte-for-byte from that exact SAN commit. `SNAPSHOT.json` records the matching Git blob identities.

Do not implement legal-agent business logic directly here. Changes must originate in SAN, pass SAN CI, then be snapshotted again with a new exact commit pin.

This wrapper exists only because the Railway service being reused is already connected to `dkaminag/dashboard-app`, while `dkaminag/san-systems-master` is private and cannot be fetched during an unauthenticated container build.

The reused Railway service is the historical non-canonical `central-juridica-v3-1-1` service. It is distinct from the preserved rollback service `central-juridica-v3-1-1-cutover`.
