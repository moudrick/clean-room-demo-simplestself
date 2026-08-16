# Simplest self-provisioning clean-room demo

Experimental synthetic feature-flag reference demo. Its destructive boundary is exactly three repositories (`demo-orders`, `demo-storefront`, `demo-profile`) in configured `GH_ORG` and the entire dedicated, non-default LaunchDarkly project `LD_PROJECT_KEY`. It never creates or deletes the surrounding organization or account.

> **A campaign is active.** `CAMPAIGN_LOCK=true` in `.env` makes `recreate`, `refresh`, and
> `destroy` refuse before any preflight, because this sandbox now holds evidence that cannot be
> recreated: repository history, flag identity, flag age, evaluations, and search indexing. The
> destructive snippets below are retained for future disposable sandboxes and will fail closed
> while the lock is set. Normal campaign operation uses `doctor`, `baseline`, `bootstrap`, and
> `audit`. See `SPEC.md` for the lock and its emergency-recovery path.

Complete [one-time credential setup](CREDENTIALS.md). Run every snippet from the repository root in Bash on Linux, macOS, or Git Bash on Windows. The snippets use relative forward-slash paths and basic shell syntax shared by all three environments. Load the trusted local `.env` into the current shell before using its project key for destructive confirmation:

```bash
. ./.env
node demo.mjs doctor
node demo.mjs recreate --confirm "$LD_PROJECT_KEY"
node demo.mjs audit
node demo.mjs destroy --confirm "$LD_PROJECT_KEY"
```

The `.` command is the portable form of Bash `source`. Keep `.env` as simple `NAME=value` lines with no spaces around `=`. Quoting `"$LD_PROJECT_KEY"` passes exactly one argument and avoids duplicating the configured project key.

`recreate` creates environments in Production, Staging, Test, Dev order; Production and Staging are critical. It shallow-clones generated repositories into ignored `runtime/repos/` and writes four generated SDK keys plus a non-secret traffic generation to ignored `runtime/sdk-keys.env`. `audit` is source evidence, not runtime status. See [SPEC.md](SPEC.md) for the normative contract.

## Choose reset or preserve history

Always stop the tracked runtime before a mutating lifecycle command:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml down
```

Use hard reset when you want a new LaunchDarkly project instance:

```bash
. ./.env
node demo.mjs recreate --confirm "$LD_PROJECT_KEY"
```

Recreate deletes and rebuilds the three repositories and entire demo project. The old project's environments, flags, SDK keys, project-scoped contexts, and flag history go with it. The command verifies the local Compose stack is stopped, reports the old and new project `_id` values, and creates a new UTC-stamped traffic generation. It cannot detect evaluator clients started on another host, so stop those separately.

Use preserve-history refresh when the project is intact and you want new generated source or reconciled rules without losing evaluation history:

```bash
. ./.env
node demo.mjs refresh --confirm "$LD_PROJECT_KEY"
```

Refresh deletes and recreates only the three owned GitHub repositories, patches the three existing flags, and replaces local clones. It refuses to proceed unless the project contains exactly the expected boolean flags and environments. Reconciliation replaces targeting rules and individual targets and removes prerequisites, so manual flag targeting is not preserved. It keeps the project `_id`, SDK keys, contexts, and evaluations, while assigning new traffic a new UTC-stamped generation.

Neither command erases account-level billing-period usage, service-connection usage, audit records, retained analytics, or UI caches. Deleting individual contexts also does not reduce usage already recorded. Account-wide permanent deletion is outside this demo and may require LaunchDarkly Support or account deletion.

## Multi-context evaluations

Every SDK call sends one LaunchDarkly multi-context with exactly:

- `user`: synthetic customer key, plan, region, and cohort;
- `service`: stable `demo-orders`, `demo-storefront`, or `demo-profile` identity;
- `cluster`: stable DNS-label key, display name, environment label, geography region, ordinal, release ring, and generation.

The SDK key selects the real LaunchDarkly environment. A `cluster.environment` attribute describes the synthetic cluster; it does not create another environment.

| Environment | Clusters | Weight |
| --- | --- | --- |
| Production | `prod-eu-west-01`, `prod-emea-central-04`, `prod-sa-east-02` | 50%, 30%, 20% |
| Staging | `stg-eu-central-01`, `stg-eu-central-02` | 60%, 40% |
| Test | `test-eu-central-01`, `test-eu-central-02` | 75%, 25% |
| Dev | `dev-local-01` | 100% |

Checkout rule precedence is cluster canary ring, user checkout-beta cohort, user enterprise plan, then off. For the first 100 deterministic orders contexts it returns true 48/80/91/40 times in Production/Staging/Test/Dev. Legacy profile targets user region `legacy` and returns true 8/20/30/12 times. Retired banner has no evaluator.

## One-shot evaluation

Compose maps the selected environment SDK key and profile automatically:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml \
  run --rm --build orders-production \
  npm run evaluate -- --cohort checkout-beta --cluster prod-eu-west-01

docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml \
  run --rm --build storefront-staging \
  npm run evaluate -- --plan enterprise --cluster stg-eu-central-02

docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml \
  run --rm --build profile-test \
  npm run evaluate -- --region legacy --cluster test-eu-central-01

docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml \
  run --rm --build orders-dev npm run evaluate
```

Each invocation makes ten calls per owned flag by default. `--evaluations 1..1000` changes the count. `--context-key`, `--plan`, `--region`, `--cohort`, and `--cluster` change synthetic attributes. The cluster must belong to the selected service environment. Output includes the safe complete multi-context. The SDK key is never printed.

## Populate cumulative history

Start all twelve repository/environment services:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml up --detach --build
```

All services except orders-production keep fixed five-minute profiles. Per ordinary evaluator, weekday UTC 07:00–19:00 batches are Production 100, Staging 30, Test 10, Dev 2; quiet batches are 40, 12, 4, 1. Orders-production is the only high-rate probe and defaults to a paced, multi-day-safe 1200 checkout evaluations/hour with a bounded 1000-user pool.

Check every service, recent summaries, and current host resources:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml ps --all
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml logs --tail 20 --timestamps
docker stats --no-stream
```

Leave the host and Docker engine running for the desired period. Compose restarts preserve project history. There is no supported backfill for historical flag evaluations.

## Controlled production load probe

The rate and user cardinality are separate. `DEMO_EVALUATIONS_PER_HOUR` accepts an integer 10–100000. `DEMO_CONTEXT_POOL_SIZE` accepts 1–10000 and defaults to 1000. Only orders-production reads them. Recreate is unnecessary between rates.

Start only the probe at a chosen rate:

```bash
DEMO_EVALUATIONS_PER_HOUR=1200 \
DEMO_CONTEXT_POOL_SIZE=1000 \
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml \
  up --detach --build orders-production
```

These assignments apply only to this `docker compose` process in Bash; they do not modify `.env` or persist in the shell.

Stop it easily with:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml stop orders-production
```

Use this ladder; the maximum is an explicit stress step, not a normal demo setting:

| Rate/hour | Suggested observation | Purpose |
| ---: | --- | --- |
| 10 | 15 minutes | confirm pacing and contexts |
| 1200 | 1 hour | cross 1000 local calls in normal mode |
| 10000 | 30 minutes | observe SDK/network and container growth |
| 100000 | 10 minutes, opt-in | find the sandbox boundary and stop promptly if unhealthy |

For each step record:

| Rate | Duration | Local attempted/achieved | SDK flush/errors/warnings | Docker CPU/memory | LD Live events/insights | Organization usage/entitlement |
| ---: | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

The probe logs one compact summary per minute and a final summary. It uses a 10,000-event SDK buffer, five-second flush interval, event compression, and bounded context-key cache. The default LaunchDarkly summary events aggregate evaluation counters, so 100,000 local `boolVariation` calls do not imply 100,000 outbound HTTP events.

To compare per-evaluation feature events where the account supports them, set this non-secret value in management `.env`, stop Compose, and preserve history while reconciling the flag:

```dotenv
LD_PROBE_DETAILED_EVENTS=true
```

```bash
. ./.env
node demo.mjs refresh --confirm "$LD_PROJECT_KEY"
```

This enables detailed events only for checkout in Production. Restore `false` and refresh again after the comparison. Detailed events increase SDK bandwidth and ingestion pressure; they do not change the requested local call rate.

Measure three distinct boundaries rather than treating one number as truth:

1. Local variation-call throughput and Docker CPU/memory.
2. SDK analytics queue, flush, compression, warnings, and outbound network delivery.
3. LaunchDarkly entitlement, ingestion, retention, sampling, and UI aggregation.

Server-side evaluations execute locally and use SDK streaming/event endpoints, not management REST calls. Lifecycle REST `429` handling therefore does not define evaluation throughput.

LaunchDarkly's public Developer plan has limited service connections and other entitlements, and continued overage can make an account read-only. Limits can change: treat the account's Organization settings Plan usage page as authoritative. Twelve long-lived containers primarily exercise service connections; evaluation calls and unique-context cardinality exercise different systems.

## Destroy and verify changes

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml down
. ./.env
node demo.mjs destroy --confirm "$LD_PROJECT_KEY"
```

Destroy removes the dedicated project and repositories plus generated runtime files. It cannot delete an account's last project.

Run local checks used by GitHub Actions:

```bash
node --check demo.mjs
node --check lib.mjs
npm test
```

Tests use no credentials and produce no external traffic.

## Reference documentation

- [Multi-contexts and context kinds](https://launchdarkly.com/docs/home/flags/multi-contexts)
- [SDK analytics events](https://launchdarkly.com/docs/sdk/concepts/events) and [server-side bandwidth](https://launchdarkly.com/docs/sdk/concepts/server-side-bandwidth/)
- [Node server SDK options](https://launchdarkly.github.io/js-core/packages/sdk/server-node/docs/interfaces/LDOptions.html)
- [Feature-flag semantic patch instructions](https://launchdarkly.com/docs/api/feature-flags/patch-feature-flag?explorer=true)
- [Service connections](https://launchdarkly.com/docs/home/account/service-connections) and [billing calculations](https://launchdarkly.com/docs/home/account/calculating-billing)
- [Project deletion](https://launchdarkly.com/docs/api/projects/delete-project) and [context deletion usage caveat](https://launchdarkly.com/docs/home/flags/context-details)
