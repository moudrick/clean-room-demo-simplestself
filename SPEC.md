# Simplest self-provisioning clean-room demo — specification

## Scope

The configured containers are GitHub organization `GH_ORG` and LaunchDarkly project key `LD_PROJECT_KEY`, set in the ignored local `.env`. They are configuration values, not secrets, and must be non-empty safe identifiers. The organization is never created, renamed, or deleted. `LD_PROJECT_KEY` identifies a non-default, fully demo-owned project: the implementation may create and delete it. It controls all flags and environments in that project, and no other LaunchDarkly project.

The only disposable GitHub repositories are `demo-orders`, `demo-storefront`, and `demo-profile` in `GH_ORG`. The generated LaunchDarkly project contains exactly the disposable flags `demo-checkout-rollout`, `demo-legacy-profile`, and `demo-retired-banner`, and exactly the environments `production`, `test`, `staging`, and `dev`. Any other repository or LaunchDarkly project identifier is rejected before an API request.

## Tokens

The management CLI reads exactly four secrets: `GH_RESET_TOKEN`, `GH_DEMO_TOKEN`, `LD_RESET_TOKEN`, and `LD_DEMO_TOKEN`. The generated evaluator applications read exactly one additional secret, `LD_EVALUATION_SDK_KEY`, which is the server-side SDK key for whichever generated environment they evaluate. `GH_ORG` and `LD_PROJECT_KEY` are required non-secret configuration values. Secrets are never command arguments, URLs, remotes, fixtures, output, or error text. GitHub requests use `Authorization: Bearer <token>`; LaunchDarkly REST requests use `Authorization: <token>`; every JSON request body declares `Content-Type: application/json`. `doctor` requires the four management secrets and both configuration values. `run` reads only demo tokens. `recreate` and `destroy` read only reset tokens, and never substitute a reset token when a demo token is absent. The evaluator applications never read management tokens.

Every GitHub and LaunchDarkly REST call uses the same bounded rate-limit policy. A `429` response is retried; a GitHub `403` is also retried when its headers or message identify rate limiting. Before retrying, the implementation prefers `Retry-After`, then the provider's `X-RateLimit-Reset` (`epoch seconds` for GitHub and `epoch milliseconds` for LaunchDarkly), and otherwise uses exponential backoff beginning at sixty seconds. It waits through the indicated window and adds up to one second of jitter. A request is attempted at most six times total. If the required single wait exceeds five minutes, or all retries are exhausted, the command fails nonzero without issuing an early retry. Rate-limit handling reuses the same method, target, body, token role, redaction, and official-origin checks.

Create the GitHub reset fine-grained PAT for resource owner `GH_ORG`, all organization repositories, Administration read/write, Contents read/write, and Metadata read (normally automatic), with short expiration. Create a separate demo PAT for the same owner and repositories with Contents read-only and Metadata read, also short-lived. The organization must allow members/tokens to create and delete organization repositories; GitHub Administration write is required for those operations.

In LaunchDarkly, use **Organization settings → Authorization → Create token**. Create personal token `featureflag-demo-reset` with Writer base role and API version `20240415`, able to list/create/delete the non-default demo project and all of its environments and flags. Create `featureflag-demo-read` with Reader base role and the same API version, able to list projects and flags. After each `recreate`, copy the server-side SDK key for the environment you want an evaluator to use into `LD_EVALUATION_SDK_KEY`; it is not an API access token and cannot manage resources. LaunchDarkly shows access-token secrets once: copy each immediately into ignored `.env`. No custom role or service token is required.

## Commands

`node demo.mjs doctor` is the first command to run. It is read-only: it checks presence, authentication, configured-organization access, existing disposable-repository read access for both GitHub tokens, LaunchDarkly project-list access for both LaunchDarkly tokens, and official response origins. It prints the compact capability table. It succeeds whether the demo project is present or absent. Write/delete capability is reported as verified only during `recreate`; it is never tested by mutation in doctor. Any authentication, identity/access, scope/read, origin, or identifier mismatch exits nonzero. A failed check identifies its token variable and check type, but never its token value.

`node demo.mjs recreate --confirm <LD_PROJECT_KEY value>` uses only reset tokens. It performs reset-token read checks, prints every exact target, requires the exact configured-project confirmation string, deletes only existing disposable repositories and the exact demo project, confirms each deleted repository and project is absent with at most ten one-second read-only checks, and creates three public repositories with an initial commit. It creates the project with exactly `production`, `test`, `staging`, and `dev`, then commits synthetic source as a child commit, preserving the deliberate source-commit timestamps, creates three boolean flags, and restores the deterministic targeting in every generated environment described below. `demo-checkout-rollout` is in two files across two repositories with recent synthetic commits; `demo-legacy-profile` is in one file in one repository with deliberately fabricated old author/committer dates; `demo-retired-banner` is absent. A destructive-operation failure identifies the reset-token role, action, and exact target, but never a token value.

`node demo.mjs run` uses only demo tokens. It lists configured-project flags, code-searches the configured organization, accepts only the three repositories, verifies each result on its current default branch, and prints `FLAG | VERIFIED FILES | REPOSITORIES | LAST FILE COMMIT | RESULT`.

`node demo.mjs destroy --confirm <LD_PROJECT_KEY value>` uses only reset tokens, requires exact confirmation, and deletes the three disposable repositories and the exact demo project. Deleting the project removes all its flags and environments, returning it to the state before this demo was created. Missing targets are reported as already absent. It cannot delete the account's last project, so `LD_PROJECT_KEY` must not be the default or last project. A destructive-operation failure identifies the reset-token role, action, and exact target, but never a token value.

## Generated repositories and evaluation

Each generated repository contains an independently runnable Node.js server-side LaunchDarkly evaluator, its minimal package manifest, and synthetic source only. It accepts `--context-key`, `--plan`, `--region`, and `--cohort` parameters. These values form a single synthetic `user` context: `key` is `--context-key`; `plan`, `region`, and `cohort` are custom attributes. Values must be safe non-empty identifiers. The default context is `demo-user`, `free`, `eu`, and `control` respectively. The evaluator reads only `LD_EVALUATION_SDK_KEY`, waits for SDK initialization, evaluates its owned flag or flags, explicitly flushes analytics events, closes the SDK, and exits. It never prints the SDK key or a management token.

`demo-orders` and `demo-storefront` each evaluate `demo-checkout-rollout`. `demo-profile` evaluates `demo-legacy-profile`. No generated application evaluates `demo-retired-banner`; that absence is deliberate evidence for its dead-candidate scenario. Each evaluator prints only its repository name, flag key, evaluated boolean value, and non-secret context attributes.

In every generated environment, `recreate` configures the disposable flags as follows:

- `demo-checkout-rollout` is on for `cohort=checkout-beta` or `plan=enterprise`; it is off for the fallthrough rule.
- `demo-legacy-profile` is on for `region=legacy`; it is off for the fallthrough rule.
- `demo-retired-banner` is off and has no evaluator.

This permits repeatable demonstrations of distinct targeting rules, for example `--cohort checkout-beta`, `--plan enterprise`, or `--region legacy`, while all other default contexts receive the off variation.

## Audit semantics and errors

`REFERENCED` requires one or more verified current-default-branch files. `STALE CANDIDATE` requires verified files and an old newest matching-file commit. `DEAD CANDIDATE` requires complete, successful evidence of no matches. Any failed, unauthorized, rate-limited, malformed, capped, or incomplete evidence yields `UNKNOWN`, never a candidate. Candidates only begin investigation and never authorize deletion. “Last file commit” is the newest default-branch commit touching a currently matching file, not a flag evaluation. API errors include their HTTP status and, when present, a short redacted server message; they never include request headers or token values.

## Acceptance and non-goals

Acceptance is fixed-scope enforcement, command-specific token isolation, exact destructive confirmation, deterministic synthetic evidence, redacted errors, and mocked tests proving incomplete evidence cannot be stale/dead. The generated evaluator applications must run with a server-side SDK key from one generated environment, emit and flush evaluations for their owned flags, and demonstrate both targeting and fallthrough variations using only synthetic contexts. This experimental reference deliberately does not provide production hardening, continuous evaluation traffic, general repository discovery, presentation assets, recordings, publication workflows, or management of accounts or organizations.
