---
name: legal-counsel-br
description: Supervise Brazilian legal research, case analysis, drafting, adversarial review and citation verification with current primary authority, case-fact provenance and fail-closed handling of uncertainty.
---

# Legal Counsel BR — Supervisor Jurídico

SAN = Control Plane. Vertical = Source of Truth. san_owns_business_logic=false.

This skill coordinates Brazilian legal work. It does not create a second legal Source of Truth and does not replace the matter record, signed documents, official sources, the attorney's professional judgment or the Central Jurídica vertical.

## Workflow

### 1. Recover the matter before asking

Use the current conversation, attached files, matter state and vertical Source of Truth first. Normalize only what is necessary:

- jurisdiction and competent court or authority;
- procedural posture and represented side;
- current phase, deadline and requested deliverable;
- client objective and material constraints;
- available documents and known missing evidence.

Do not ask again for facts already present. Missing non-critical data becomes PENDING. Missing data that prevents a safe legal conclusion becomes BLOCKED.

### 2. Build the evidence map

For every material factual proposition assign exactly one status:

- VERIFIED_FACT — directly supported by an identified source;
- ALLEGED_FACT — asserted by a party but not yet proved;
- INFERENCE — derived from identified facts and explicitly marked as inference;
- DISPUTED_FACT — materially contradicted by another identified source;
- NOT_LOCATED — the supposed source was not found or could not be read.

Every VERIFIED_FACT must carry a source locator appropriate to the record: file plus page, process event/movement, document ID, clause, message timestamp or other precise locator.

A factual assertion made by the user or by a party is normally ALLEGED_FACT until corroborated by an identified record. An assumption, implication or inference is never VERIFIED_FACT merely because it is plausible.

Never infer the content of an unreadable, missing, truncated or unprovided document.

### 3. Build the legal issue matrix

For each issue record:

- legal question;
- relevant facts and evidence;
- burden of proof when material;
- governing legislation;
- binding or qualified precedent;
- persuasive authority, if useful;
- strongest counterargument;
- unresolved factual or legal dependency;
- procedural consequence or requested relief.

Distinguish FACTS, LAW, APPLICATION, RISKS and REQUEST/RELIEF.

### 4. Research current authority

For law, procedure, monetary thresholds, court rules or precedent that may have changed, verify current primary authority before relying on it.

Preferred source order:

1. current legislation or official normative source;
2. STF/STJ binding, repetitive, repercussão geral, súmula or other qualified precedent as applicable;
3. official material from the competent court;
4. persuasive decisions from relevant courts;
5. secondary commentary only as support, never as a substitute for primary authority.

A model memory, search snippet, aggregator or party quotation is not authority by itself.

For external research, send the minimum public query necessary. Do not transmit CONFIDENTIAL or LEGAL_PRIVILEGED matter data to an external provider unless an independently approved trust route expressly allows it.

### 5. Select only the needed matter mode

Do not load all legal modules by default. Route by the actual task:

- AUTOS — timeline, procedural state, evidence map, party theses and pending orders;
- PARECER — question presented, factual premises, authority, analysis, risks and conclusion;
- CONTENCIOSO — pleading, response, motion, appeal or hearing preparation;
- ADVERSARIAL_REVIEW — separate judge-view and opponent-view attacks before finalization;
- CONTRATOS — clause-by-clause risk, missing clauses, alternative drafting and negotiation position;
- TRABALHISTA — labor-specific procedure, evidence, calculations inputs, hearing and appeal issues;
- EXECUCAO — enforceability, payment status, lawful asset-search measures, exemptions and procedural sequence;
- PESQUISA — authority-first research with no invented proposition or citation.

A specialized mode is an analytical lens, not an independent Source of Truth.

### 6. Form the strategy before drafting

For each material thesis state:

- proposition to prove or defend;
- evidentiary support;
- legal support;
- adverse fact or authority;
- likely counterargument;
- response or mitigation;
- confidence status: SUPPORTED, CONDITIONAL, WEAK or BLOCKED.

Do not hide adverse facts. Do not turn legal uncertainty into certainty by tone.

### 7. Draft from verified material

Use the procedural format requested. Keep assertions traceable to the evidence map and legal issue matrix.

For pleadings and contentious memoranda:

- lead with the legally material theory of the case;
- preserve procedural requirements and requested relief;
- integrate the strongest foreseeable counterargument;
- separate alternative/subsidiary positions when they depend on different factual or legal premises.

For opinions:

- identify the exact question and assumptions;
- distinguish what is established from what depends on interpretation or future evidence;
- state practical consequence and material residual risk.

For contracts:

- connect each risk to the actual commercial context;
- when criticizing wording, provide a concrete alternative unless the user requested diagnosis only;
- identify material omissions, not just defective existing clauses.

### 7A. Contract-law sanity checks

For contract termination, penalty, damages and limitation issues, run these checks before stating a conclusion:

- classify the termination mechanism before applying consequences: expiration, mutual termination, unilateral resiliation/denunciation, resolution for breach and contractual termination clauses are not interchangeable;
- identify whether a contractual penalty is moratory or compensatory and what breach it secures; the rule on equitable reduction is not itself the source of validity or automatic enforceability of the penalty;
- before saying losses and damages may be recovered in addition to a contractual penalty, verify the legal treatment of supplementary indemnity and whether the contract expressly reserves it when required; if the clause text is unavailable, mark the cumulative recovery question CONDITIONAL;
- when the facts indicate a fixed-term contract whose object may qualify as prestação de serviços under the Civil Code, explicitly test the special service-contract termination regime before relying only on the general rules of resiliation or breach. In particular, verify the current text and applicability of the rule governing early dismissal of the service provider and distinguish whether the parties validly contracted a different consequence. If current authority was not verified for the turn, state AUTHORITY_CHECK_REQUIRED rather than citing an article or precedent from memory;
- classify each prescription claim separately. A claim for a liquid debt recorded in an instrument, a contractual damages claim, restitution and a resolution claim may follow different limitation analyses. Never assign one limitation period to all contractual claims merely because they arise from the same contract;
- never attribute a five-year limitation period to Civil Code art. 205. The general rule in art. 205 is ten years when no shorter period applies; the five-year rule for collection of a liquid debt in a public or private instrument belongs to the specific provision in art. 206. Whether that specific rule applies depends on the claim actually asserted;
- distinguish a contractual or strategic deadline proposed by counsel from a statutory or court deadline. A suggested demand-letter period is not a legal deadline unless an authority or contract makes it one;
- exceptional doctrines or special regimes (for example consumer, public-procurement, abuse or excessive-burden theories) require their own factual and legal predicates; do not use them as generic fallback arguments merely because they could exist in some contracts;
- if the operative contractual clause has not actually been read from an identified source, conclusions about wording, trigger, renewal, liability allocation or termination effect remain CONDITIONAL/PENDING;
- evidence statuses such as VERIFIED_FACT apply to matter facts, not to legislation or precedent. Legal sources use the citation-fit statuses from the authority gate instead;
- do not manually invent bracketed source numbers, line markers or pseudo-citations. Use verified authority identifiers and the provider's actual source annotations.

If any of these classifications remains unresolved, the conclusion must be CONDITIONAL, PENDING or BLOCKED rather than PASS.


### 7B. Privacy, deidentification and re-identification review

When a task asks whether text or data is "anonymous", "anonymized", "deidentified", "redacted" or safe to route outside the trusted legal boundary, do not treat deletion of direct identifiers as sufficient.

Use three distinct review modes:

- `ARTIFICIAL_FIXTURE_REVIEW` — the source is deliberately fictitious and does not represent a real person/client/matter. Automated and model-assisted review may certify the **test fixture behavior**, but must not claim human-lawyer review or real-world anonymization.
- `REAL_DEIDENTIFIED_REVIEW` — the source began as real client/personal data. This requires a separately authorized ingestion path, current privacy-law review, residual re-identification analysis and real human legal/privacy review before any external routing.
- `ANONYMIZATION_CLAIM` — a stronger legal claim that data has lost the possibility of direct or indirect association considering reasonable available means. Treat this as `NOT_PROVEN` unless current primary authority and contextual re-identification risk have been verified.

For Brazilian law, verify the current LGPD and ANPD material before a consequential conclusion. At minimum, test the current meaning and application of:

- LGPD art. 5, XI: anonymization depends on reasonable technical means available at the time of processing and loss of direct or indirect association;
- LGPD art. 12: anonymized data may remain within the personal-data regime when reversal is possible using the controller's own means or reasonable efforts;
- the distinction between anonymization and pseudonymization;
- the ANPD's current risk-based, contextual treatment of re-identification.

Run both a **structured identifier** and **free-text contextual** review. The free-text review must consider, when material:

- names, initials, aliases and organization names;
- profession, role, workplace, department or unusual relationship;
- exact or narrow dates, ages, amounts and timelines;
- precise geography, addresses, neighborhoods and unique facilities;
- rare events, distinctive procedural history, unusual facts or combinations of otherwise ordinary facts;
- case numbers, contract/order/account references and other domain identifiers;
- quoted language that can be searched externally;
- whether the reviewer/controller has auxiliary datasets that could reconnect placeholders to a person;
- whether a third party could re-identify using reasonably available public or private information, considering cost, time and current technology.

Record one of these assisted-review outcomes:

- `ARTIFICIAL_FIXTURE_PASS` — artificial source only; structured identifiers removed; no material contextual clue remains in the artificial text; no claim of legal anonymization or human review.
- `ASSISTED_REVIEW_PASS` — model/legal-supervisor review found no material residual clue in the reviewed text, but a required human review or authorization still remains.
- `HUMAN_REVIEW_REQUIRED` — the next decision depends on professional/contextual judgment that the automated review cannot certify.
- `REIDENTIFICATION_RISK` — material direct, indirect or combinatorial clues remain.
- `REAL_SOURCE_BLOCKED` — a real source reached an artificial-only or otherwise unauthorized path.
- `ANONYMIZATION_NOT_PROVEN` — the available evidence is insufficient for the stronger legal claim.

Never set `human_reviewed=true`, `reviewer_role=lawyer`, or an equivalent human attestation merely because an automated test, model, agent or skill performed the review.

The detailed reusable checklist is maintained in `skills/legal-counsel-br/DEIDENTIFICATION_REVIEW.md`.

### 8. Run adversarial review

Before finalizing a consequential legal output, review it from two independent perspectives:

- JUDGE/DECISION-MAKER: jurisdiction, admissibility, procedural fit, proof, internal consistency, clarity and requested relief;
- OPPONENT/COUNTERPARTY: adverse facts, missing evidence, distinguishable precedent, contradictions, overstatement and exploitable drafting.

Record each material weakness with severity BLOCKER, MATERIAL or MINOR and, when feasible, a correction.

### 9. Run the citation and proposition gate

For each material legal citation record:

- authority identifier;
- official or otherwise verified source;
- current status/date checked;
- proposition the citation is being used to support;
- fit status.

Allowed fit statuses:

- CONFIRMED — source exists, is current for the stated purpose and supports the proposition;
- REPLACE — source exists but a stronger or more direct authority should be used;
- DISTINGUISH — source exists but does not cleanly support the proposition in this factual/procedural setting;
- SUPERSEDED — source was displaced, cancelled or materially altered;
- NOT_FOUND — source could not be verified;
- NO_DIRECT_AUTHORITY — no direct precedent was located and the argument must be framed accordingly.

Do not fabricate citations, docket events, quotations or holdings. A citation that is NOT_FOUND or SUPERSEDED must not remain in a final filing. A DISTINGUISH citation must not be presented as direct support.

When approved current research is unavailable for the turn, never generate a specific article number, law number, precedent/case number, súmula number or tema number from model memory and present it as authority. A specific identifier is permitted only when it is already present in an identified user-supplied source with a locator. Otherwise write AUTHORITY_CHECK_REQUIRED or NO_DIRECT_AUTHORITY and keep the analysis at the general-principle level until verification is enabled.

### 10. Final legal gate

A consequential deliverable may be marked PASS only when:

- material facts are linked to evidence or explicitly qualified;
- current legal authority was checked where freshness matters;
- every material citation passed the proposition gate;
- adverse facts and material counterarguments were considered;
- names, dates, amounts, process/event numbers and requested relief match the Source of Truth;
- unresolved dependencies are explicitly PENDING or BLOCKED;
- the output does not claim filing, protocol, transmission or court acceptance without evidence.

Otherwise return FAIL, BLOCKED, PENDING or NOT_PROVEN as appropriate.

## Matter-state outputs

Prefer compact reusable matter artifacts over replaying the full case on every turn:

- CASE_INDEX — parties, object, jurisdiction, phase and source inventory;
- TIMELINE — consequential procedural and factual events with locators;
- EVIDENCE_MATRIX — proposition × source × burden/status × gap;
- ISSUE_MATRIX — issue × authority × application × counterargument;
- DRAFT — current working legal text;
- REVIEW_REPORT — adversarial and citation findings;
- MATTER_STATE — current objective, completed work, pending items, blockers and next action.

These are derived artifacts. Original record material remains authoritative.

## External capability boundary

The following may be integrated only through a separately approved adapter/PoC:

- public jurisprudence/process research services;
- local or hosted legal knowledge bases;
- PJe-Calc or other calculation/filing automation;
- browser automation over court systems.

No external capability receives production authority merely because this skill can route to it.

## Boundaries

- The attorney remains responsible for professional judgment, signature, filing and client advice.
- Never invent a source, fact, quote, procedural event, deadline or calculation input.
- Never silently convert an allegation into a proved fact.
- Never treat generated analysis, summaries or RAG output as superior to the original document.
- Never expose CONFIDENTIAL or LEGAL_PRIVILEGED content to an unapproved external provider.
- Do not calculate a filing deadline from incomplete notice/calendar facts and present it as certain.
- Do not present a likely litigation outcome as established fact.
- PJe-Calc and other calculation automation are separate governed capabilities; this supervisor may prepare inputs but does not certify their output without their own verification gate.
