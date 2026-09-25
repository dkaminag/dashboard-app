# Legal Agent Cloud — deployment snapshot

This directory is a **deployment snapshot only**.

Authoritative Source of Truth:

- repository: `dkaminag/san-systems-master`
- commit: `47de613a22dd6d2f02be13b0ddbb8c6d2805746e`
- canonical application path: `systems/legal-agent-cloud/`
- canonical legal skill: `skills/legal-counsel-br/SKILL.md`

The files in this directory are copied byte-for-byte from that exact SAN commit. `SNAPSHOT.json` records the matching Git blob identities.

This refresh includes the governed multi-provider release from SAN PR #191, sanitized provider diagnostics from SAN PR #192, and the Groq GPT-OSS text-message compatibility fix from SAN PR #193. Groq remains the default free-start provider with `openai/gpt-oss-120b`, OpenAI remains selectable, provider/model combinations are allowlisted, public web research remains OFF by default and per-turn opt-in, and provider-specific data-policy acknowledgment is required before inference.

Groq GPT-OSS is treated as text-only in this runtime: plain-text messages use Groq's documented string-content contract; TXT/RTF are decoded locally in-memory and appended to the message; image/PDF/DOC/DOCX inputs fail closed until a governed local extraction/conversion path is added. No attachment body is persisted by this application.

Do not implement legal-agent business logic directly here. Changes must originate in SAN, pass SAN CI, then be snapshotted again with a new exact commit pin.

This wrapper exists only because the Railway service being reused is already connected to `dkaminag/dashboard-app`, while `dkaminag/san-systems-master` is private and cannot be fetched during an unauthenticated container build.

The reused Railway service is the historical non-canonical `central-juridica-v3-1-1` service. It is distinct from the preserved rollback service `central-juridica-v3-1-1-cutover`.
