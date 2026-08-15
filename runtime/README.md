# Runtime traffic workspace

`recreate` and `refresh` write ignored `sdk-keys.env` and shallow-clone the three generated public repositories into ignored `repos/`. Neither generated artifact belongs in Git.

Start all twelve services at the safe default, including the 1200 evaluations/hour orders-production probe:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml up --detach --build
```

Inspect all states, compact summaries, and resource use:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml ps --all
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml logs --tail 20 --timestamps
docker stats --no-stream
```

To run only the probe, set `DEMO_EVALUATIONS_PER_HOUR` to an integer from 10 through 100000 and optionally set `DEMO_CONTEXT_POOL_SIZE` from 1 through 10000, then start `orders-production`. The 100000 setting is an explicit short stress test, never the default.

```bash
DEMO_EVALUATIONS_PER_HOUR=1200 \
DEMO_CONTEXT_POOL_SIZE=1000 \
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml \
  up --detach --build orders-production
```

Stop traffic before `recreate`, `refresh`, or `destroy`:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml down
```

Stopping and restarting Compose preserves evaluations. `refresh` also preserves them. `recreate` and `destroy` delete the project-scoped history, but account-level usage and audit observations may remain.
