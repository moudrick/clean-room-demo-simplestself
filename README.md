# Simplest self-provisioning clean-room demo

Experimental, synthetic feature-flag reference demo. Configure `GH_ORG` and the non-default, dedicated `LD_PROJECT_KEY` in `.env`. Its destructive boundary is exactly three repositories (`demo-orders`, `demo-storefront`, `demo-profile`) in that organization and that entire LaunchDarkly project. It never creates, renames, or deletes the surrounding organization or account.

Complete the [one-time credential setup](CREDENTIALS.md) before the first run. It explains the four management tokens and the separate environment SDK keys used by the evaluator applications. After setup, the normal lifecycle below can be repeated without creating credentials again.

`recreate` creates `production`, `test`, `staging`, and `dev`, stores their automatically generated SDK keys in ignored `runtime/sdk-keys.env`, and shallow-clones the generated repositories into ignored `runtime/repos/`. SDK keys are passed only to evaluator containers and are never printed.

Run first:

```console
node demo.mjs doctor
node demo.mjs recreate --confirm <your-LD_PROJECT_KEY-value>
node demo.mjs run
node demo.mjs destroy --confirm <your-LD_PROJECT_KEY-value>
```

`recreate` and `destroy` require the exact confirmation and use reset tokens only. `run` uses demo tokens only. See [SPEC.md](SPEC.md) for normative behavior and limitations.

After deleting a disposable GitHub repository or LaunchDarkly project, `recreate` waits for it to become absent from the API before recreating it (at most ten seconds). Stop runtime traffic before either destructive command.

`destroy` deletes the dedicated LaunchDarkly project, including every flag and environment inside it. It cannot delete an account's last project.

## One-shot evaluation

After `recreate`, run one-shot evaluations through Compose from the repository root. Compose builds the selected cloned application and maps its generated environment SDK key automatically:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml run --rm --build orders-production npm run evaluate -- --cohort checkout-beta
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml run --rm --build storefront-production npm run evaluate -- --plan enterprise
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml run --rm --build profile-production npm run evaluate -- --region legacy
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml run --rm --build orders-production npm run evaluate
```

Replace the service suffix `production` with `test`, `staging`, or `dev` to evaluate the same case in another environment. The one-off container is removed after the app flushes its evaluation event and exits. `demo-orders` and `demo-storefront` evaluate checkout; `demo-profile` evaluates legacy profile.

## Populate cumulative evaluation history

Docker Compose is the recommended multi-day runner. It starts the three repository apps in all four environments—twelve processes total—with distinct deterministic traffic profiles, five-minute cycles, graceful event flushing, automatic restart, and rotated logs:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml up --detach --build
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml ps
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml logs --tail 50
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

The initial workflow runs after every direct push to `main`. It uses no credentials and makes no GitHub or LaunchDarkly API calls.
