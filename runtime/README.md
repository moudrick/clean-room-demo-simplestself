# Runtime traffic workspace

`recreate` writes ignored `sdk-keys.env` and shallow-clones the three generated public repositories into ignored `repos/`. Neither generated directory belongs in Git.

Start all twelve repository/environment traffic processes:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml up --detach --build
```

Inspect them:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml ps --all
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml logs --tail 20 --timestamps
```

Stop traffic before `recreate` or `destroy`:

```console
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml down
```

Stopping and restarting Compose preserves accumulated LaunchDarkly evaluations. Recreating or destroying the LaunchDarkly project resets them.
