# Legal Agent Cloud — deployment snapshot

This directory is a **deployment snapshot only**.

Authoritative Source of Truth:

- repository: `dkaminag/san-systems-master`
- commit: `fe35b36af28a8d17d96eb5e31e9564096494349d`
- canonical application path: `systems/legal-agent-cloud/`
- canonical legal skill: `skills/legal-counsel-br/SKILL.md`

The files in this directory are copied byte-for-byte from that exact SAN commit. `SNAPSHOT.json` records the matching Git blob identities.

This refresh includes the governed multi-provider release from SAN PR #191, sanitized provider diagnostics from SAN PR #192, the Groq GPT-OSS text-message compatibility fix from SAN PR #193, the bounded Groq reasoning/output profile from SAN PR #195, the fail-closed legal-authority provenance gate from SAN PR #196, PostgreSQL SSL-mode normalization from SAN PR #198, and deterministic Groq input-context budgeting from SAN PR #199.

Groq free-tier inference uses medium reasoning with a 4096-token output budget. Plain-text messages use Groq's documented string-content contract. TXT/RTF are decoded locally in-memory; PDF files with a text layer and DOCX files are extracted locally in a bounded worker and appended to the model input. Images, legacy DOC files, password-protected PDFs and scanned PDFs without extractable text fail closed. No attachment body is persisted by this application.

Do not implement legal-agent business logic directly here. Changes must originate in SAN, pass SAN CI, then be snapshotted again with a new exact commit pin.

This wrapper exists only because the Railway service being reused is already connected to `dkaminag/dashboard-app`, while `dkaminag/san-systems-master` is private and cannot be fetched during an unauthenticated container build.

The reused Railway service is the historical non-canonical `central-juridica-v3-1-1` service. It is distinct from the preserved rollback service `central-juridica-v3-1-1-cutover`.


## Authority provenance hardening

When public research is OFF, specific legal authority identifiers (article/law/case/súmula/tema numbers) still require provenance from user-supplied readable text. The deterministic gate now performs one bounded private self-repair before blocking: the first unsafe draft is discarded and regenerated without unsupported identifiers, using general conditional reasoning plus `AUTHORITY_CHECK_REQUIRED`/`PENDING`. The repair never enables public research. If unsupported identifiers remain, the response still fails closed.


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


## Bounded authority-provenance self-repair

SAN PR #221 improves the no-research path without weakening the authority gate. An unsourced authority in the first draft triggers one private regeneration from the original matter input. The repaired answer is rechecked by the deterministic legal-consistency gate and the authority-provenance gate. Repair metadata stores only aggregate status/counts; it does not persist the rejected draft or expose hidden instructions.


## Deployment snapshot completeness

This snapshot includes the local document-extraction runtime files required by `package.json` and `server.mjs`: `document-extract.mjs`, `document-extract-worker.mjs`, and `document-extract-smoke.mjs`. Missing any of these files is a deployment-blocking snapshot error.


## PDF.js standard-font runtime fix

SAN PR #230 binds `pdfjs-dist` standard-font data to the exact local package path used by the isolated document-extraction worker. This removes an implicit runtime-directory dependency exposed by the downstream container build gate when the embedded Helvetica PDF smoke ran inside Docker. The change does not add OCR, external file access, provider calls, or attachment persistence.
