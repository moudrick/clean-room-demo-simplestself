# Simplest self-provisioning clean-room demo

Experimental, synthetic feature-flag reference demo. Configure `GH_ORG` and the non-default, dedicated `LD_PROJECT_KEY` in `.env`. Its destructive boundary is exactly three repositories (`demo-orders`, `demo-storefront`, `demo-profile`) in that organization and that entire LaunchDarkly project. It never creates, renames, or deletes the surrounding organization or account.

Complete the [one-time credential setup](CREDENTIALS.md) before the first run. It explains the four management tokens and the separate environment SDK keys used by the evaluator applications. After setup, the normal lifecycle below can be repeated without creating credentials again.

`recreate` creates `production`, `staging`, `test`, and `dev`, marking Production and Staging critical while leaving Test and Dev non-critical. It stores their automatically generated SDK keys in ignored `runtime/sdk-keys.env` and shallow-clones the generated repositories into ignored `runtime/repos/`. SDK keys are passed only to evaluator containers and are never printed.

Run first:

```console
node demo.mjs doctor
node demo.mjs recreate --confirm <your-LD_PROJECT_KEY-value>
node demo.mjs audit
node demo.mjs destroy --confirm <your-LD_PROJECT_KEY-value>
```

`recreate` and `destroy` require the exact confirmation and use reset tokens only. `audit` uses demo tokens only and reports the flag-to-source evidence table; runtime process status is provided by Docker Compose below. See [SPEC.md](SPEC.md) for normative behavior and limitations.

After deleting a disposable GitHub repository or LaunchDarkly project, `recreate` waits for it to become absent from the API before recreating it (at most ten seconds per target). Stop runtime traffic before either destructive command.

`destroy` deletes the dedicated LaunchDarkly project, including every flag and environment inside it. It cannot delete an account's last project.

## Repeat recreation safely

`recreate` is already a complete reset, so running `destroy` first is unnecessary. Stop Compose, then run `recreate` again:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml down
node demo.mjs recreate --confirm <your-LD_PROJECT_KEY-value>
```

It deletes and rebuilds the three owned repositories and the entire dedicated LaunchDarkly project. That resets repository history, flags, targeting, environments, SDK keys, and all accumulated evaluations. It also replaces ignored `runtime/repos/` and `runtime/sdk-keys.env`. It does not change the GitHub organization, LaunchDarkly account, another repository or project, tracked Compose files, or local Docker images. Rerunning the command after a partial failure starts the same bounded reset again. The fifteen-step progress bar shows the active phase; a rate-limit wait adds a provider and countdown without displaying secrets.

## One-shot evaluation

After `recreate`, run one-shot evaluations through Compose from the repository root. Compose builds the selected cloned application and maps its generated environment SDK key automatically:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml run --rm --build orders-production npm run evaluate -- --cohort checkout-beta
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml run --rm --build storefront-production npm run evaluate -- --plan enterprise
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml run --rm --build profile-production npm run evaluate -- --region legacy
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml run --rm --build orders-production npm run evaluate
```

Each command emits ten evaluations per owned flag by default. Add `--evaluations 25` to choose another one-shot count from 1 through 1000, or `--instance DEMO1` to label its synthetic deployment. Replace the service suffix `production` with `staging`, `test`, or `dev` to evaluate the same case in another environment. The one-off container is removed after the app flushes its events and exits. `demo-orders` and `demo-storefront` evaluate checkout; `demo-profile` evaluates legacy profile. The retired banner remains deliberately unevaluated.

## Populate cumulative evaluation history

Docker Compose is the recommended multi-day runner. It starts the three repository apps in Production, Staging, Test, and Dev—twelve processes total—with distinct deterministic traffic profiles, immediate first batches, five-minute cycles, graceful event flushing, automatic restart, and rotated logs:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml up --detach --build
```

Per application, a business-hours cycle emits 100 Production, 30 Staging, 10 Test, and 2 Dev evaluations; quiet cycles emit 40, 12, 4, and 1. Production contexts are weighted across `WestEU1`, `EMEA4`, and `SouthAM2`; Staging uses `STG1` and `STG2`. These are synthetic context values, not extra LaunchDarkly environments.

Check all services, including any that exited, and inspect recent timestamped output:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml ps --all
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml logs --tail 20 --timestamps
```

Leave the host and Docker engine running for the desired two or three weeks. Stopping and restarting containers continues adding to the existing flag history. Do not run `recreate` while filling data: it intentionally deletes the project and all accumulated evaluations.

Before testing another clean recreation or destroying the demo, stop traffic:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml down
node demo.mjs destroy --confirm <your-LD_PROJECT_KEY-value>
```

LaunchDarkly does not provide supported backfill for flag-evaluation insights. Metric-event import accepts custom metrics, not historical variation evaluations, and REST evaluation does not populate flag insights. The demo therefore generates only live SDK evaluations. See [runtime/README.md](runtime/README.md) for the compact operator commands.

## Verify a change

Run the same local checks used by GitHub Actions:

```console
node --check demo.mjs
node --check lib.mjs
npm test
```

The initial workflow uses Node.js 24 and the current major releases of the official checkout and setup-node actions after every direct push to `main`. It uses no credentials and makes no GitHub or LaunchDarkly API calls.
