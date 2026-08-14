# Universal project instructions

These instructions apply to every agent and every task involving this project.

## Read first

Before changing anything, read `SPEC.md`, `README.md`, and the relevant implementation and tests in
this directory. Treat `SPEC.md` as the normative description of the current desired behavior.

## Spec-first changes

For every requested behavior change:

1. Update the affected parts of `SPEC.md` first.
2. Rewrite or remove superseded text; do not append exceptions that leave contradictory rules.
3. Keep the specification incremental by changing only the sections affected by the request.
4. Resolve material ambiguity before editing implementation behavior.
5. Update implementation, tests, and `README.md` to conform to the revised specification.
6. Finish with a concise specification-versus-implementation consistency check.

`SPEC.md` describes the current state, not a chronological transcript. Record a decision only when
it is necessary to understand the current design.

## Clean-room boundary

- Work only from this project's specification, source, tests, README, and official public GitHub
  and LaunchDarkly documentation.
- Do not inspect, compare, copy, or reuse the sibling `../clean-room-demo/` implementation, an
  earlier engagement artifact or gist, or any employer/client/customer material.
- Use only synthetic identifiers, repositories, flags, source, history, fixtures, and output.

## Fixed safety boundary

Never create, rename, modify, or delete the GitHub organization, LaunchDarkly account, or
LaunchDarkly project.

The configured containers are set in ignored local `.env`:

- GitHub organization: `GH_ORG`
- LaunchDarkly project: `LD_PROJECT_KEY`

Only the repositories enumerated in `SPEC.md` and the configured non-default LaunchDarkly project
are disposable. Destructive operations must retain the exact confirmation requirement and reject
every identifier outside that scope.

## Credentials and external operations

- Keep the four-management-token separation and evaluator-SDK-key boundary defined in `SPEC.md`;
  never fall back from a missing demo token to a reset token.
- Tokens belong only in the ignored local `.env`. Never print, log, commit, persist, or put them in
  command arguments, URLs, Git remotes, fixtures, or error text.
- Tests must use mocks and must not contact external services.
- Do not run `recreate` or `destroy`, or otherwise mutate GitHub or LaunchDarkly, unless the user
  explicitly requests that external operation in the current task.
- Before an authorized destructive operation, show the exact targets and retain the explicit
  confirmation guard. Never broaden the target set by discovery.

## Keep the project simple

- Prefer Node.js built-ins and the existing small file structure.
- Add a dependency, abstraction, file, compatibility layer, or generalized feature only when the
  requested behavior materially needs it.
- Do not add production hardening, presentation assets, recordings, publication workflows, or
  speculative edge-case machinery unless explicitly requested.
- Do not use subagents for routine work in this project.
- Preserve clear fail-closed behavior: incomplete or failed evidence cannot become a stale or dead
  candidate, and candidates never authorize deletion.

## Verification

After local changes, run at minimum:

```console
node --check demo.mjs
node --check lib.mjs
node --test
```

Add focused mocked tests for changed behavior. Report separately anything that requires real tokens
or external resources and therefore was not verified locally. Do not stage, commit, push, publish,
or perform external setup unless the user explicitly asks.
