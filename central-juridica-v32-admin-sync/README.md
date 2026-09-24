# Central Jurídica v3.2 — controlled admin credential resync

This directory prepares a one-shot, fail-closed credential reconciliation utility for the canonical R3 database.

It is intentionally isolated from `main` deployment paths until separately approved.

## Safety properties

- defaults to `CJ_ADMIN_SYNC_MODE=dry-run`;
- refuses non-production `CJ_ENV`;
- targets only `central_juridica_v32_prod_r3`;
- refuses to create a missing administrator;
- requires an existing active `role=admin` account;
- refuses QA usernames;
- preserves the complete user payload except:
  - `passwordHash`;
  - `passwordChangedAt`;
  - `updatedAt`;
- checks an immutable fingerprint before commit;
- revokes all existing sessions only in apply mode;
- writes an audit-chain entry;
- never logs password, password hash, MFA secret or recovery codes.

## Dry-run

Required variables should be supplied by Railway reference variables from `central-juridica-v3-2-prod`.

Expected safe output includes only:

- whether current password matches;
- whether a password change would be needed;
- current session count;
- confirmation that no apply was performed.

## Apply gate

Apply mode additionally requires both:

```
CJ_ADMIN_SYNC_MODE=apply
CJ_ADMIN_SYNC_APPROVAL=ADMIN_RESYNC_APPROVED_20260924
```

The approval variable must not be set before explicit human authorization.

## Post-apply acceptance

After apply:

1. old admin sessions must be invalidated;
2. password-only login must no longer fail as invalid credentials;
3. if MFA is already enrolled, login should proceed to the existing MFA challenge rather than bypass it;
4. if MFA enrollment is required, the human administrator must enroll it interactively;
5. admin audit gate must remain inaccessible until second-factor requirements are satisfied.

No automated MFA reset, MFA disable, recovery-code regeneration or admin recreation is permitted.
