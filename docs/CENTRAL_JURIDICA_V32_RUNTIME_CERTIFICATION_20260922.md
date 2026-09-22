# Central Jurídica v3.2 — runtime-source certification — 2026-09-22

This follow-up gate certifies the six-commit delta added after the first v3.2 source/build certification.

- certified base: `6d1858690c7c298f5100cee97f01bb0a07ddb4bc`
- current source snapshot: `eabfb4da6b4e5207cb25d569c5e434829c2e5614`
- expected delta: six commits / six files
- new capability: isolated encrypted DR drill plus isolated intake verifier package

The gate preserves the prior overlay hash and immutable Docker source pin, rebuilds the v3.2 candidate, checks the final DR drill fail-closed invariants, validates the verifier package and smoke contract, and does not access Railway secrets or mutate a database.

Live runtime acceptance remains separate: the existing non-canonical candidate service must keep health/readiness green, the isolated verifier must prove unauthorized rejection + first intake + idempotent replay, and the DR drill must execute against distinct source/target databases before any canonical cutover.
