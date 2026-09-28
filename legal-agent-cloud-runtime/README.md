# Legal Agent Cloud — deployment snapshot

This directory is a **deployment snapshot only**.

Authoritative Source of Truth:

- repository: `dkaminag/san-systems-master`
- commit: `54082914a0d1226905b77fbaceb0e21035545893`
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

SAN PR #230 plus follow-up `4451079b4c538b8cf703916b1a25168ad055899d` bind `pdfjs-dist` standard-font data to the exact local filesystem path used by the isolated document-extraction worker. This removes an implicit runtime-directory dependency exposed by the downstream container build gate when the embedded Helvetica PDF smoke ran inside Docker. The change does not add OCR, external file access, provider calls, or attachment persistence.


## glibc container portability

SAN PR #235 merged as `2cf8868b8028f719a920cbe24e636615d262c9a7` and changes the canonical Legal Agent deployment base to `node:22-bookworm-slim`. This preserves the existing Node 22 runtime while using a glibc base for the bounded local PDF/DOCX extraction path that failed under the Alpine container gate. No provider, credential, database, or real-matter boundary is changed.


## PDF.js 6 cleanup API

SAN PR #238 merged as `a39ca93ab0c1a2bc4bfecee31a31a18d1bd0a74c`. The bounded PDF worker now releases PDF.js through `PDFDocumentLoadingTask.destroy()` instead of the removed `PDFDocumentProxy.destroy()` API. The no-secret Linux container gate proved the embedded PDF and DOCX extraction smoke after this change.


## Synthetic release certification and opinion regressions

SAN PR #241 merged as `9a382348d6c2addba5ef73b987834503ee1c93d8`. It adds an opt-in startup certification using a fixed fictitious contract scenario and the same provider, legal-consistency and authority-provenance gates used by normal chat. The flag is disabled by default and the runtime logs only PASS/FAIL plus non-substantive provider/repair/usage metadata; generated answer text and credentials are never logged.

The executable consistency gate now also rejects model-invented pseudo-citation markers, a PASS conclusion while material PENDING/BLOCKED/NOT_LOCATED/AUTHORITY_CHECK_REQUIRED dependencies remain, and use of the penalty-reduction rule as the source of validity/enforceability of a contractual penalty.


## Groq rate-limit hardening

SAN PR #245 merged as `aea2975387f606309cc59b079dc2aaefb555f76b`. The runtime now treats Groq HTTP 429 as an explicit provider-rate-limit condition, performs at most one retry only when Groq supplies a positive `retry-after` of 5 seconds or less, and otherwise returns `AI_PROVIDER_RATE_LIMITED` without masking the condition as a generic 503. The production startup synthetic smoke is disabled after release certification so cold starts do not consume free-tier quota.


## Fixed-term service-contract termination hardening

SAN PR #250 merged as `d11e3f4a45695d68b8ca130847393f602cf5b6af`. The canonical Supervisor now requires explicit assessment of the special Civil Code regime for early termination of fixed-term service contracts before relying only on general resiliation/breach rules, while preserving the no-memory citation gate (`AUTHORITY_CHECK_REQUIRED` when current authority has not been verified for the turn). The synthetic benchmark also requires the classification counterargument so the rule is not applied mechanically to contracts that may fall under a different legal regime.


## Semantic live-smoke certification gate

SAN PR #260 adds a semantic acceptance gate to the opt-in synthetic production smoke. A smoke can now emit `legal-agent-synthetic-smoke-pass` only if the repaired/final answer contains substantive coverage for all six fixed regression dimensions: termination classification, penalty nature, supplementary damages, claim-specific limitation analysis, the potentially applicable fixed-term service-contract rule, and the counterargument on whether that special regime actually applies. With public research disabled, the smoke must also preserve `AUTHORITY_CHECK_REQUIRED` rather than inventing authority identifiers, and provider citations must remain absent.

This strengthens certification evidence only; it does not force these machine-readable section labels into ordinary lawyer-facing responses and does not authorize real client matter data.
