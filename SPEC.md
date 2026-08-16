# Simplest self-provisioning clean-room demo — specification

## Scope

The configured containers are GitHub organization `GH_ORG` and LaunchDarkly project key `LD_PROJECT_KEY`, set in ignored local `.env`. They are non-secret, non-empty safe identifiers. The organization is never created, renamed, or deleted. `LD_PROJECT_KEY` identifies a non-default, fully demo-owned project: the implementation may create and delete it, but no other LaunchDarkly project.

The only disposable GitHub repositories are `demo-orders`, `demo-storefront`, and `demo-profile`. The demo project contains exactly flags `demo-checkout-rollout`, `demo-legacy-profile`, and `demo-retired-banner`, and environments `production`, `staging`, `test`, and `dev`, in that order. Production and Staging are critical; Test and Dev are not. Any other repository or project identifier is rejected before an API request.

## Credentials and requests

The management CLI reads exactly four secrets: `GH_RESET_TOKEN`, `GH_DEMO_TOKEN`, `LD_RESET_TOKEN`, and `LD_DEMO_TOKEN`. Each evaluator reads exactly one additional secret, `LD_EVALUATION_SDK_KEY`, for its environment. `GH_ORG` and `LD_PROJECT_KEY` are required non-secret configuration. `LD_PROBE_DETAILED_EVENTS` and `CAMPAIGN_LOCK` are optional non-secret booleans and default to `false`. Secrets are never arguments, URLs, Git remotes, fixtures, output, logs, or error text.

GitHub requests use `Authorization: Bearer <token>`; LaunchDarkly REST requests use `Authorization: <token>`; every JSON body declares `Content-Type: application/json`. `doctor` needs all four management secrets, `audit` needs only demo tokens, and `recreate`, `refresh`, and `destroy` need only reset tokens. Reset tokens never substitute for missing demo tokens. Evaluators never read management tokens. `CREDENTIALS.md` owns the one-time credential instructions.

Every REST call uses the same bounded rate-limit policy. A `429` is retried; GitHub `403` is retried only when its headers or message identify rate limiting. Delay preference is `Retry-After`, provider `X-RateLimit-Reset`, then exponential backoff from sixty seconds, with up to one second jitter. There are at most six attempts; one wait cannot exceed five minutes. Recreate and refresh show permitted waits in progress output without URLs, headers, bodies, or secrets.

The GitHub reset fine-grained PAT targets `GH_ORG`, all organization repositories, Administration read/write, Contents read/write, and Metadata read. The demo PAT has Contents read-only and Metadata read. The organization must permit the token owner to create and delete organization repositories.

The LaunchDarkly reset token is a Writer token using API version `20240415`, able to list/create/delete the non-default project and its environments and flags. The demo token is Reader. Default server-side SDK keys created with the environments are written only to ignored `runtime/sdk-keys.env`; each process receives exactly the key for its environment, and the three services in one environment share it.

## Operator shell contract

README command snippets target Bash from the repository root and must be directly usable in Ubuntu or another Linux desktop, the Bash shipped with or installed on macOS, and Git Bash on Windows. They use the portable, basic Bash intersection shared by those environments: relative forward-slash paths, quoted variable expansion, simple environment assignments, the POSIX `.` command for loading `.env`, and backslash line continuation where needed. They must not require PowerShell, Command Prompt, WSL, GNU-only command options, platform-specific absolute paths, Bash features unavailable in macOS's older default Bash, or shell aliases.

`.env` remains a sequence of unexported `NAME=value` assignments with no spaces around `=`. This form is read by the Node CLI and can also be loaded into the current Bash process with `. ./.env` so destructive confirmation uses the exact configured value as `"$LD_PROJECT_KEY"`; snippets never duplicate that value or use angle-bracket placeholders that Bash would interpret as redirection. Secrets loaded as shell variables are not printed. Commands that need temporary Compose overrides use one-command environment prefixes such as `DEMO_EVALUATIONS_PER_HOUR=1200 docker compose ...`, which work in all three supported Bash environments and do not persist after the command.

## Commands and lifecycle

`node demo.mjs doctor` is read-only. It checks credential presence, authentication, configured-organization access, existing disposable-repository access, project-list access, and official response origins. It succeeds whether the demo project exists or not. Mutation capability is verified only by the mutating commands.

`node demo.mjs baseline` is read-only and uses only demo tokens. It reads the configured project and the owned repositories and writes tracked `campaign.json`: schema version, scenario identifier, campaign start, LaunchDarkly project key and `_id`, and for every flag its real creation time, age in days at capture, and the date it reaches the default thirty-day minimum age; for every repository its numeric id, node id, creation time, default branch, and head commit SHA at baseline. Rerunning preserves the original campaign start and scenario identifier and refreshes the observed snapshot. It records no credential, SDK key, or request header.

`node demo.mjs bootstrap --confirm "$LD_PROJECT_KEY"` creates missing catalog flags and is the only command that may add flags during the campaign. It uses only `LD_RESET_TOKEN`, requires exact project confirmation, and requires the scenario identifier already recorded in `campaign.json`. It first validates tracked `scenario/flags.json` against the catalog contract: exactly twenty-four unique `demo-` keys within the maximum of forty-five, the exact presentation-role distribution, the three pre-existing flags adopted with cohort `pre-campaign`, exactly two protected live-demo archive candidates, and exactly two reserved rehearsal candidates that are not the protected pair. It then lists the project and refuses to proceed if any existing flag is absent from the catalog, so unknown drift stops the run before anything is created. Existing flags are adopted by identity and never recreated; missing flags are created boolean, off, with their declared temporary intent and the scenario identifier as an ownership tag. Applying it again is a verified no-op. It never deletes, archives, or retargets a flag.

### Scenario model and commands

Tracked `scenario/` holds the declarative campaign: `sandbox.json` (environment order and criticality, cluster topology, safety limits, named traffic and drain patterns, cadence rules, evidence gates, milestones), `services.json` (the service catalog with language template, wave, and flag-consumer edges), `flags.json` (the flag catalog), and ordered immutable deltas in `steps/*.json`.

The compiler replays steps in order into a complete desired-state model, validates the whole model before any mutation, and produces a stable checksum. It is forward-only: a step dated before its predecessor, a step that re-introduces an existing service, a release tag that does not advance, a source reference a service does not declare as a consumer, or a deployment set exceeding `limits.maxEvaluatorContainers` all fail closed before any request. `cadence` is `three-day` by default; `daily` is accepted only for a step naming one of `cadence.dailyTransitions` or dated inside a `cadence.dailyWindows` entry. Recommended dates never select a step automatically.

`node demo.mjs scenario list` and `node demo.mjs scenario plan --to <step>` perform no mutation; `plan` prints the sanitized ordered diff for human review. `node demo.mjs scenario status` compares the compiled desired state against live GitHub and LaunchDarkly state and reports each step as applied or pending with its overdue distance. `node demo.mjs scenario apply --to <step> --confirm "$LD_PROJECT_KEY"` reconciles forward using only `GH_RESET_TOKEN`.

Reconciliation is non-destructive and replaces the repository-recreating behavior of legacy `refresh`. It creates a catalog repository when its introduction step activates, commits generated source containing literal flag keys, and creates an immutable release tag. Every generated repository carries a tracked `.scenario-owner.json` ownership marker naming the scenario id and service key; an existing repository with the expected name but a missing or foreign marker is drift and stops the run rather than being reused. Applying the same step again adopts what exists and creates nothing. The reconciler never deletes a repository, force-pushes, rewrites history, or moves a tag. Applied step ids and checksums are recorded in ignored `runtime/scenario-state.json`, while remote inspection and ownership markers remain authoritative after a lost state file.

### Campaign lock

`CAMPAIGN_LOCK` is a non-secret boolean in `.env` and defaults to `false`. It must be exactly `true` or `false`; any other value is an error.

While `CAMPAIGN_LOCK=true`, `recreate`, `refresh`, and `destroy` refuse before any credential, confirmation, scope, or runtime preflight and before any API request. The lock exists because the campaign sandbox accumulates irreplaceable evidence: repository history, flag identity, flag age, evaluations, contexts, and search indexing. Resources created while the lock is active are archived, never deleted. `refresh` is locked with the other two because it deletes and recreates the owned repositories, which destroys repository history and restarts GitHub indexing even though it preserves the LaunchDarkly project.

`doctor` and `audit` are read-only and are never affected by the lock. The refusal names the refused command and points to the emergency-recovery section below; it never prints the override phrase.

### Emergency recovery only

Breaking the lock is an emergency recovery action, not an operating procedure, and is deliberately absent from the README timeline. In addition to `--confirm "$LD_PROJECT_KEY"`, the operator types the override on the command line for every single invocation:

```console
--break-campaign-lock "BREAK CAMPAIGN LOCK <the configured LD_PROJECT_KEY value>"
```

The argument must equal that phrase exactly, with the configured project key substituted. It is typed literally at the console each time and is never stored in `.env`, a shell alias, a variable, or a script. Breaking the lock does not make deletion safe; it only restores the pre-campaign behavior of the three destructive commands.

`node demo.mjs recreate --confirm "$LD_PROJECT_KEY"` is the destructive hard reset. It verifies reset access, exact confirmation, exact targets, and that the tracked local Compose stack is stopped. It deletes only the three owned repositories and exact demo project, confirms absence with at most ten one-second read checks, then creates the repositories, project, four environments, three flags, and targeting. It makes initial and timestamp-controlled synthetic commits. Finally it shallow-clones the public repositories over token-free HTTPS and transactionally replaces only generated `runtime/repos/` and `runtime/sdk-keys.env`; a local preparation failure cleans both artifacts.

Recreate deletes the old project with its environments, flags, SDK keys, project-scoped contexts, and project-scoped flag history. It records the prior and replacement LaunchDarkly project `_id` values when available. It also creates a non-secret traffic generation from the new project ID plus lifecycle UTC time. It does not erase account-level billing-period or service-connection usage, audit records, retained analytics, or UI caches. The operator is responsible for stopping evaluator clients outside the tracked local Compose stack. The line-oriented fifteen-phase display and bounded rate-limit countdown make waits visible.

`node demo.mjs refresh --confirm "$LD_PROJECT_KEY"` is the preserve-history flow. It verifies reset access, confirmation, stopped local Compose, and that the exact project already has exactly the four environments and three expected boolean flags. A mismatch fails before mutation. It deletes and recreates only the three owned repositories, atomically replaces each flag environment's rules and individual targets, removes prerequisites, reapplies expected state, and transactionally refreshes local clones and the same SDK keys. It never deletes or creates the LaunchDarkly project, environments, flags, SDK keys, contexts, or evaluations. Missing resources are errors. Its line-oriented progress and redaction follow recreate. Repeated refreshes keep the project `_id` but create a new traffic generation, allowing later contexts and summaries to distinguish preserved runs.

`node demo.mjs audit` uses only demo tokens. It lists configured-project flags, code-searches the configured organization, accepts only owned repositories, verifies current default-branch results, and prints `FLAG | VERIFIED FILES | REPOSITORIES | LAST FILE COMMIT | RESULT`. `REFERENCED` needs verified files; `STALE CANDIDATE` also needs an old newest matching-file commit; `DEAD CANDIDATE` needs complete successful no-match evidence. Incomplete evidence is always `UNKNOWN`. The obsolete pre-release `run` command is rejected.

`node demo.mjs destroy --confirm "$LD_PROJECT_KEY"` verifies the local stack is stopped, then deletes the three repositories and exact project and removes only generated local runtime artifacts. Missing targets are already absent. It cannot delete the account's last project, so the configured project must not be default or last.

## Generated applications and contexts

Each generated repository contains an independently runnable Node.js server-side evaluator, a Node.js 24 Alpine Dockerfile, minimal package manifest, and synthetic source. The image disables npm update advertising and retains the npm bundled with the pinned base image.

Every variation call receives one LaunchDarkly multi-context containing exactly:

- `user`: deterministic key plus synthetic `plan`, `region`, and `cohort`;
- `service`: stable generated-repository key and name;
- `cluster`: stable key plus `name`, `environment`, `region`, `ordinal`, `releaseRing`, and traffic generation.

The SDK key, not the cluster attribute, selects the LaunchDarkly environment. Cluster keys are lowercase RFC 1123 labels using `<environment>-<geography>-<ordinal>`. Deterministic distributions are Production `prod-eu-west-01`/`prod-emea-central-04`/`prod-sa-east-02` at 50/30/20; Staging `stg-eu-central-01`/`stg-eu-central-02` at 60/40; Test `test-eu-central-01`/`test-eu-central-02` at 75/25; and Dev `dev-local-01` at 100. Cluster selection uses a permutation independent from user targeting.

One-shot mode accepts `--context-key`, `--plan`, `--region`, `--cohort`, `--cluster`, and `--evaluations`. The cluster must belong to the selected Compose environment. Safe identifiers are required. Evaluations range from 1 through 1000 and default to 10. A count above one appends a zero-padded sequence to the user key. Defaults are `demo-user`, `free`, `eu`, `control`, and the environment's first cluster. Output contains only the safe multi-context, flag, service, and result.

Ordinary traffic mode is `npm run traffic -- --profile <production|staging|test|dev> [--interval-seconds <10..86400>]`. It opens one client, emits an immediate deterministic batch, defaults to five minutes, and uses larger weekday UTC 07:00–19:00 batches. Per ordinary evaluator, Production emits 100 busy or 40 quiet evaluations, Staging 30/12, Test 10/4, and Dev 2/1. It prints batch summaries. Signals wake it, flush events, close the client, and exit.

Exactly one evaluator is the high-rate probe: `demo-orders` evaluating `demo-checkout-rollout` in Production. It replaces that evaluator's ordinary batches with a paced cumulative scheduler controlled by `--evaluations-per-hour` or `DEMO_EVALUATIONS_PER_HOUR`, inclusive 10 through 100000, default 1200. Elapsed-time accumulation prevents rate-division drift and a simulated hour produces exactly the request. `--context-pool-size` or `DEMO_CONTEXT_POOL_SIZE` independently bounds deterministic user cardinality from 1 through 10000, default 1000. Maximum load is opt-in; automated tests call only pure scheduling functions.

The probe emits compact periodic summaries instead of per-evaluation lines: flag, service, cluster counts, generation, requested rate, attempted count, elapsed time, achieved hourly rate, variations, context-pool size, local errors, and flush outcome. The SDK client explicitly uses 10000-event capacity, five-second flush interval, compression, bounded context-key caching, and service application metadata. SDK warnings remain visible. `LD_PROBE_DETAILED_EVENTS=true` makes only checkout in Production request detailed per-evaluation feature events when recreate or refresh next reconciles it; default summary mode remains false.

`demo-orders` and `demo-storefront` evaluate checkout; `demo-profile` evaluates legacy profile. Both active flags receive activity in all environments. No application evaluates retired banner.

Rule clauses explicitly select context kind. Checkout precedence is `cluster.releaseRing=canary`, then `user.cohort=checkout-beta`, then `user.plan=enterprise`, then off fallthrough. Across each profile's first 100 generated orders contexts, checkout is true for exactly Production 48, Staging 80, Test 91, and Dev 40. Legacy profile is on for `user.region=legacy`, then off fallthrough, with exact first-100 true counts 8, 20, 30, and 12. Retired banner is off and silent.

Server-side variation calls execute locally and send analytics through LaunchDarkly SDK streaming/event endpoints, not management REST. REST `429` handling is not an evaluation-throughput limit. Operators compare three separate boundaries: local call throughput and Docker CPU/memory; SDK queue/compression/flush/network delivery; and LaunchDarkly entitlement/ingestion/retention/sampling/UI aggregation. Summary events aggregate counters, so local calls need not equal outbound events or immediately visible UI counts.

## Runtime and measurement

Tracked `runtime/compose.yaml` defines twelve services in Production, Staging, Test, Dev order, builds only shallow local clones, restarts unless stopped, rotates logs, exposes no port, and never mounts management `.env`. Each service gets its environment SDK key, profile, and generation. Only orders-production gets probe rate and pool settings.

Before recreate, refresh, or destroy, the operator runs Compose down. The command fails closed if the tracked stack cannot be verified stopped while generated runtime credentials exist. Compose may be stopped and restarted without losing history. Traffic continues only while the host and Docker engine run. There is no evaluation backfill.

README contains the repeatable lifecycle, one-shot example, `ps --all`, logs, graceful stop, `docker stats --no-stream`, and an operator-controlled probe ladder at 10, 1200, 10000, and 100000 evaluations/hour. Each step has an observation duration and a results table comparing local summaries, Docker resources, Live events/flag insights, and Organization usage. The maximum step is explicitly opt-in and easy to stop.

Normal SDK traffic uses summary events, not one outbound event per variation. Detailed-event mode is a separately reconciled flag setting. The public Developer plan has limited service connections and other entitlements; continued overage may make an account read-only. Public limits can change, so the account Plan usage page is authoritative. Twelve long-lived containers primarily exercise service connections; calls and unique contexts exercise different systems.

Project deletion is the demo's project-scoped reset boundary. Deleting individual context records does not reduce already accumulated usage. Account-wide permanent deletion is outside these credentials and may require LaunchDarkly Support or account deletion.

## Verification and CI

Local verification is `node --check demo.mjs`, `node --check lib.mjs`, and `npm test`. CI uses `actions/checkout@v7`, `actions/setup-node@v7`, and Node.js 24 on pushes to `main`, with read-only contents and no secrets or external requests.

Mocked tests cover exact multi-context shape; stable user/service/cluster keys; RFC 1123 names and exact weights; context-kind rules and precedence; retired silence; scheduler counts for 10, 1200, a non-divisible rate, and 100000 over a simulated hour; independent context cardinality; one compact maximum-rate summary; summary and detailed flag configuration; explicit SDK event options and final flush; token-free clones and runtime generation; fixed Compose order; rate limits; recreate hard-reset identity; and refresh preservation. Neither lifecycle may escape the fixed resources.

Errors name the token role, action, and safe exact target, with HTTP status and short redacted server message when available; they never reveal request headers or secret values. Candidate labels only begin investigation and never authorize deletion.

## Acceptance and non-goals

Real traffic makes separate `user`, `service`, and `cluster` kinds visible. Cluster attributes participate in targeting. One Production evaluator supports any rate 10–100000/hour with default 1200 while all other traffic stays fixed. Local counts, delivery, resources, and visible LaunchDarkly counts can be compared without claiming equivalence. Maximum load is never accidental, tests stay offline, and operators explicitly choose hard reset or preserve-history refresh.

This experimental reference does not provide production hardening, historical evaluation backfill, general repository discovery, account/organization deletion, presentation assets, recordings, publication workflows, or pull-request gating.
