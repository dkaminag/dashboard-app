# Legal Agent Cloud — deployment snapshot

This directory is a **deployment snapshot only**.

Authoritative Source of Truth:

- repository: `dkaminag/san-systems-master`
- commit: `f477d88a61ee0272b19c52a2928583a95c27e919`
- canonical application path: `systems/legal-agent-cloud/`
- canonical legal skill: `skills/legal-counsel-br/SKILL.md`

The files in this directory are copied byte-for-byte from that exact SAN commit. `SNAPSHOT.json` records the matching Git blob identities.

This refresh includes the fail-closed privacy gates certified by SAN PR #187: public web research defaults OFF and requires per-turn opt-in; AI inference additionally requires administrator acknowledgment of the applicable provider data-retention policy.

Do not implement legal-agent business logic directly here. Changes must originate in SAN, pass SAN CI, then be snapshotted again with a new exact commit pin.

This wrapper exists only because the Railway service being reused is already connected to `dkaminag/dashboard-app`, while `dkaminag/san-systems-master` is private and cannot be fetched during an unauthenticated container build.

The reused Railway service is the historical non-canonical `central-juridica-v3-1-1` service. It is distinct from the preserved rollback service `central-juridica-v3-1-1-cutover`.
