# Simplest self-provisioning clean-room demo — specification

## Scope

The fixed containers are GitHub organization `featureflag-extensiveconsumer-demo-org` and LaunchDarkly project key `featureflag-extensiveconsumer-demo-key`. They are never created, renamed, deleted, or modified. The only disposable GitHub repositories are `demo-orders`, `demo-storefront`, and `demo-profile` in that organization. The only disposable flags are `demo-checkout-rollout`, `demo-legacy-profile`, and `demo-retired-banner` in that project. Any other identifier is rejected before an API request.

## Tokens

Exactly four secrets are read from the environment: `GH_RESET_TOKEN`, `GH_DEMO_TOKEN`, `LD_RESET_TOKEN`, and `LD_DEMO_TOKEN`. Tokens are never command arguments, URLs, remotes, fixtures, output, or error text. `doctor` requires all four. `run` reads only demo tokens. `recreate` and `destroy` read only reset tokens, and never substitute a reset token when a demo token is absent.

Create the GitHub reset fine-grained PAT for resource owner `featureflag-extensiveconsumer-demo-org`, all organization repositories, Administration read/write, Contents read/write, and Metadata read (normally automatic), with short expiration. Create a separate demo PAT for the same owner and repositories with Contents read-only and Metadata read, also short-lived. The organization must allow members/tokens to create and delete organization repositories; GitHub Administration write is required for those operations.

In LaunchDarkly, use **Organization settings → Authorization → Create token**. Create personal token `featureflag-demo-reset` with Writer base role and API version `20240415`, able to list/create/delete flags in the fixed project. Create `featureflag-demo-read` with Reader base role and the same API version, able to read the project and list its flags. LaunchDarkly displays each secret once: copy each immediately into ignored `.env`. No custom role or service token is required.

## Commands

`node demo.mjs doctor` is the first command to run. It is read-only: it checks presence, authentication, fixed-container access, existing disposable-repository read access for both GitHub tokens, fixed-project access for both LaunchDarkly tokens, and official response origins. It prints the compact capability table. Write/delete capability is reported as verified only during `recreate`; it is never tested by mutation in doctor. Any authentication, identity/access, scope/read, origin, or identifier mismatch exits nonzero.

`node demo.mjs recreate --confirm featureflag-extensiveconsumer-demo-key` uses only reset tokens. It performs reset-token read checks, prints every exact target, requires the exact confirmation string, deletes only existing disposable targets, creates three public repositories, commits synthetic source, and creates three boolean flags. `demo-checkout-rollout` is in two files in two repositories with recent synthetic commits; `demo-legacy-profile` is in one file with deliberately fabricated old author/committer dates; `demo-retired-banner` is absent. It never deletes fixed containers.

`node demo.mjs run` uses only demo tokens. It lists fixed-project flags, code-searches the fixed organization, accepts only the three repositories, verifies each result on its current default branch, and prints `FLAG | VERIFIED FILES | REPOSITORIES | LAST FILE COMMIT | RESULT`.

`node demo.mjs destroy --confirm featureflag-extensiveconsumer-demo-key` uses only reset tokens, requires exact confirmation, and deletes only the six disposable targets. Missing targets are reported as already absent.

## Audit semantics and errors

`REFERENCED` requires one or more verified current-default-branch files. `STALE CANDIDATE` requires verified files and an old newest matching-file commit. `DEAD CANDIDATE` requires complete, successful evidence of no matches. Any failed, unauthorized, rate-limited, malformed, capped, or incomplete evidence yields `UNKNOWN`, never a candidate. Candidates only begin investigation and never authorize deletion. “Last file commit” is the newest default-branch commit touching a currently matching file, not a flag evaluation.

## Acceptance and non-goals

Acceptance is fixed-scope enforcement, command-specific token isolation, exact destructive confirmation, deterministic synthetic evidence, redacted errors, and mocked tests proving incomplete evidence cannot be stale/dead. This experimental reference deliberately does not provide production hardening, scheduling, flag deletion automation, general repository discovery, presentation assets, recordings, publication workflows, or management of accounts, organizations, or projects.
