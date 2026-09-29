# Central Jurídica v3.2 — human review handoff for Legal Agent

This runtime extension exists only to capture a genuine human legal/privacy review event after the reviewer has inspected the transformed package in the local/trusted boundary.

## Safety boundary

- route is disabled unless `CJ_LEGAL_HUMAN_REVIEW_ENABLED=true`;
- exactly one preconfigured target digest is accepted through `CJ_LEGAL_HUMAN_REVIEW_TARGET_DIGEST`;
- only an authenticated Central user with role `lawyer` can attest;
- the role must be covered by the Central MFA policy and have MFA enabled;
- request schema accepts only digest + fixed boolean confirmations + `residual_risk=LOW`;
- no free-text field exists and raw/transformed document content is rejected by schema;
- a successful event is written to the Central audit chain as `LEGAL_AGENT_HUMAN_REVIEW_ATTESTED`;
- the audit evidence includes only digests/status metadata;
- review does not grant real-source, real-matter or production authority;
- anonymization remains `NOT_PROVEN`.

The human UI is `/human-review.html?digest=sha256:...`. The reviewer must open and inspect the local/trusted review packet separately. The page never receives that packet.
