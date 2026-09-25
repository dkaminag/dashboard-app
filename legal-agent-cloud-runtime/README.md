# Legal Agent Cloud — deployment snapshot

This directory is a **deployment snapshot only**.

Authoritative Source of Truth:

- repository: `dkaminag/san-systems-master`
- commit: `46eaa99fc319356fbac7f9c45a9ff1ba945706fa`
- canonical application path: `systems/legal-agent-cloud/`
- canonical legal skill: `skills/legal-counsel-br/SKILL.md`

The files in this directory are copied byte-for-byte from that exact SAN commit. `SNAPSHOT.json` records the matching Git blob identities.

This refresh includes the governed multi-provider release from SAN PR #191, sanitized provider diagnostics from SAN PR #192, the Groq GPT-OSS text-message compatibility fix from SAN PR #193, the bounded Groq reasoning/output profile from SAN PR #195, the fail-closed legal-authority provenance gate from SAN PR #196, PostgreSQL SSL-mode normalization from SAN PR #198, and deterministic Groq input-context budgeting from SAN PR #199.

Groq free-tier inference uses medium reasoning with a 4096-token output budget. Provider dispatch remains text-only, but TXT/RTF, text-based PDF and DOCX are now converted to text locally in request memory before the Groq call. PDF/DOCX parsing runs in a resource-limited worker with a hard timeout; images, legacy DOC, scanned PDF without a text layer, protected PDF and extraction failures remain fail-closed. No automatic OCR is used and no attachment body or extracted text is persisted by this application.

Do not implement legal-agent business logic directly here. Changes must originate in SAN, pass SAN CI, then be snapshotted again with a new exact commit pin.

This wrapper exists only because the Railway service being reused is already connected to `dkaminag/dashboard-app`, while `dkaminag/san-systems-master` is private and cannot be fetched during an unauthenticated container build.

The reused Railway service is the historical non-canonical `central-juridica-v3-1-1` service. It is distinct from the preserved rollback service `central-juridica-v3-1-1-cutover`.


## Authority provenance hardening

When public research is OFF, the runtime now blocks newly generated specific legal authority identifiers (article/law/case/súmula/tema numbers) unless the exact identifier already appears in user-supplied readable text. This is a deterministic gate in addition to the Supervisor prompt. The UI instructs the lawyer to enable public research or provide the source instead of allowing an unsourced authority to pass through.


## PostgreSQL SSL-mode normalization

SAN PR #198 makes the current strict node-postgres behavior explicit before the announced pg/pg-connection-string compatibility change: URL `sslmode=prefer`, `require` and `verify-ca` are normalized to `verify-full`. The legacy `LEGAL_PG_SSL` fallback applies only when the URL carries no `sslmode`. Database URLs and credentials are never logged by this normalization path.


## Groq input context budget

SAN PR #199 prevents the observed `context_length_exceeded` path from receiving unbounded history/input. The runtime applies a conservative UTF-8 byte envelope before Groq dispatch, preserves the current user turn/readable attachment text without silent truncation, and drops only the oldest history while keeping one contiguous recent window.

If the current turn alone exceeds the governed envelope, the request fails closed with `AI_CONTEXT_TOO_LARGE`. History omission is exposed only as non-substantive counts/budget metadata, and the legal-authority provenance gate uses the same effective history actually sent to the provider.


## Contract reasoning hardening

SAN PR #201 adds a fail-closed contract-law sanity layer after a synthetic early-termination opinion exposed material reasoning defects. The Supervisor now requires explicit classification of termination mechanism, penalty nature, supplementary-indemnity conditions and claim-specific prescription analysis. It also prohibits treating legal authorities as VERIFIED_FACT.

The runtime rejects material contradictions such as describing Civil Code art. 205 as a five-year rule, unqualified cumulative penalty-plus-damages claims, and research-enabled answers that cite specific authority without provider-backed citations. These gates block unsafe output instead of silently passing it to the lawyer.


## Executable legal consistency gate

SAN PR #202 replaces the provisional inline contract-consistency detector with a separately executable module used by production and by regression tests. The test suite now exercises actual bad/good examples, including the exact `art. 205` + five-year error that previously evaded detection because sentence splitting treated the abbreviation period as a boundary.


## Bounded consistency self-repair

SAN PR #208 keeps the deterministic legal-consistency gate fail-closed but adds one bounded regeneration pass for known material contradictions. A failed first draft is discarded, the original matter input is regenerated with a narrow correction directive, and the second draft must pass the same consistency, citation and authority gates. The repair never enables public research on its own and records only sanitized repair metadata plus aggregate token usage.


## Assistant-history authority provenance

SAN PR #210 closes a citation-provenance loophole: when public research is OFF, legal authority identifiers found only in prior assistant/model responses no longer count as source authority. Only the current user message, prior user-role messages and readable user-supplied text attachments can establish pre-existing authority provenance. This prevents a hallucinated citation from laundering itself into later turns.


## Local PDF/DOCX extraction

SAN PR #214 adds governed local document extraction for the Groq text-only path. `pdfjs-dist 6.3.289` extracts embedded text from PDF bytes and `mammoth 1.12.3` extracts raw DOCX text. Binary parsing runs in an isolated Node worker with bounded memory, page/text limits and a hard timeout. The build executes an embedded TXT/PDF/DOCX runtime smoke before the image is accepted.

No secondary extraction service or automatic OCR is introduced. Image-only/scanned PDFs, password-protected PDFs, legacy DOC and unsupported inputs fail closed. Extracted text is request-memory-only and can establish authority provenance exactly as other user-supplied readable text.
