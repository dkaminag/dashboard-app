# Legal Agent Cloud — deployment snapshot

This directory is a **deployment snapshot only**.

Authoritative Source of Truth:

- repository: `dkaminag/san-systems-master`
- commit: `b604d2546760def219cd17735c0d7aeb143c76ee`
- canonical application path: `systems/legal-agent-cloud/`
- canonical legal skill: `skills/legal-counsel-br/SKILL.md`

The files in this directory are copied byte-for-byte from that exact SAN commit. `SNAPSHOT.json` records the matching Git blob identities.

This refresh includes the governed multi-provider release certified by SAN PR #191: Groq is available as the default free-start provider with `openai/gpt-oss-120b`, OpenAI remains selectable, provider/model combinations are allowlisted, public web research remains OFF by default and per-turn opt-in, and provider-specific data-policy acknowledgment is required before inference.

Groq document handling is fail-closed: image and TXT/RTF inputs are supported by this wrapper, while PDF/DOC/DOCX are rejected under Groq until a governed local extraction path is added. No attachment body is persisted by this application.

Do not implement legal-agent business logic directly here. Changes must originate in SAN, pass SAN CI, then be snapshotted again with a new exact commit pin.

This wrapper exists only because the Railway service being reused is already connected to `dkaminag/dashboard-app`, while `dkaminag/san-systems-master` is private and cannot be fetched during an unauthenticated container build.

The reused Railway service is the historical non-canonical `central-juridica-v3-1-1` service. It is distinct from the preserved rollback service `central-juridica-v3-1-1-cutover`.
