# One-time credential setup

Complete this setup once before the first `node demo.mjs doctor`. Repeat it only when a management token expires, is revoked, or needs rotation. Never commit `.env` or `runtime/sdk-keys.env`, paste their values into commands, or share them in logs.

## Local configuration

From the repository root in Bash, copy `.env.example` to the ignored `.env` file:

```bash
cp .env.example .env
```

Edit `.env`. Set `GH_ORG` to the dedicated demo organization and `LD_PROJECT_KEY` to a dedicated, non-default LaunchDarkly project key. Keep every entry as `NAME=value`, with no spaces around `=`; this remains compatible with both the Node loader and `. ./.env` in Bash. The project does not need to exist: `recreate` creates it. Keep another LaunchDarkly project in the account because the API cannot delete the account's last project.

Leave these four secret fields ready for the management credentials described below:

```dotenv
GH_RESET_TOKEN=
GH_DEMO_TOKEN=
LD_RESET_TOKEN=
LD_DEMO_TOKEN=
```

## GitHub management tokens

Create two fine-grained personal access tokens from **GitHub profile picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Use a short expiration for both. Select `GH_ORG` as the resource owner and **All repositories** as repository access. All-repository access is necessary because the three demo repositories do not exist during initial setup and are deleted and recreated by the lifecycle.

The organization must permit the token owner to create repositories and must permit repository deletion. If the organization requires approval for fine-grained tokens, an owner must approve each token before it can access the organization.

### `GH_RESET_TOKEN`

Suggested token name: `featureflag-demo-reset`.

Set repository permissions to:

- **Administration: Read and write**
- **Contents: Read and write**
- **Metadata: Read-only** (normally selected automatically)

This token is used only by `recreate`, `refresh`, and `destroy` to create, populate, and delete the three owned repositories. Copy its value into `GH_RESET_TOKEN` in `.env`.

### `GH_DEMO_TOKEN`

Suggested token name: `featureflag-demo-read`.

Set repository permissions to:

- **Contents: Read-only**
- **Metadata: Read-only** (normally selected automatically)

This token is used only by read-only `doctor` checks and `audit`. Copy its value into `GH_DEMO_TOKEN` in `.env`.

GitHub documents the complete [fine-grained token creation flow](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) and the [permissions associated with REST endpoints](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

## LaunchDarkly management tokens

Create two personal API access tokens from **Organization settings → Authorization → Create token**. These authenticate the management CLI to the LaunchDarkly REST API. They are not SDK keys.

LaunchDarkly reveals a new access-token secret only once. Copy each value into `.env` before leaving or refreshing the creation page. Custom roles and service tokens are not required.

### `LD_RESET_TOKEN`

Create the token with:

- Name: `featureflag-demo-reset`
- Base role: **Writer**
- API version: `20240415`

It must be able to list, create, and delete the dedicated project and manage its environments and flags. This token is used only by `recreate`, `refresh`, and `destroy`. Copy its value into `LD_RESET_TOKEN` in `.env`.

### `LD_DEMO_TOKEN`

Create the token with:

- Name: `featureflag-demo-read`
- Base role: **Reader**
- API version: `20240415`

It must be able to list projects and read the dedicated project and its flags. This token is used only by read-only `doctor` checks and `audit`. Copy its value into `LD_DEMO_TOKEN` in `.env`.

See LaunchDarkly's documentation for [creating API access tokens](https://launchdarkly.com/docs/home/account/api-create) and [access-token permissions](https://launchdarkly.com/docs/home/account/api).

## Evaluator SDK keys: generated automatically

The evaluator applications need a different credential type because they use LaunchDarkly's server-side Node.js SDK to download flag rules, evaluate flags, and deliver evaluation events. A management API token cannot be used for that purpose. A server-side SDK client connects to the project environment identified by its SDK key, so the four environments require four distinct SDK keys. This is a LaunchDarkly environment boundary and is necessary for sending each evaluation to the intended environment; it is not an extra REST API permission.

You do **not** create or copy these keys during one-time setup. When `recreate` creates `production`, `staging`, `test`, and `dev`, LaunchDarkly gives every environment a default server-side SDK key. The command retrieves those four keys and writes them to ignored `runtime/sdk-keys.env` as:

```dotenv
LD_EVALUATION_SDK_KEY_PRODUCTION=<generated by LaunchDarkly>
LD_EVALUATION_SDK_KEY_STAGING=<generated by LaunchDarkly>
LD_EVALUATION_SDK_KEY_TEST=<generated by LaunchDarkly>
LD_EVALUATION_SDK_KEY_DEV=<generated by LaunchDarkly>
DEMO_GENERATION_ID=<non-secret traffic run generation>
```

Docker Compose maps the appropriate value to the single `LD_EVALUATION_SDK_KEY` variable inside each evaluator container. The management CLI never stores these keys in `.env` and never prints them. `destroy` deletes the LaunchDarkly project and removes the local runtime key file; the next `recreate` generates a fresh set.

The twelve Compose services use all four keys as follows:

- The three `*-production` services share the production key.
- The three `*-staging` services share the staging key.
- The three `*-test` services share the test key.
- The three `*-dev` services share the dev key.

Therefore the demo models four LaunchDarkly environments, not twelve independently secured applications. Sharing one environment key among several trusted server-side applications is sufficient for this demo. LaunchDarkly also supports creating distinct SDK credentials for different applications to reduce the impact of a leaked key; that additional per-application isolation would require twelve credentials here and is deliberately outside the current model. Long-running Compose traffic uses all four keys, while a one-shot Compose command uses only the key belonging to the selected service's environment.

If you need to inspect or rotate an SDK key manually, use **Organization settings → SDK keys**, select the project and environment, and follow LaunchDarkly's [SDK credential instructions](https://launchdarkly.com/docs/home/account/environment/keys). A manually created replacement is not automatically selected by this demo; use the default keys generated by `recreate`, or recreate the project for a clean rotation.

## Verify the setup

Run the read-only credential check:

```bash
node demo.mjs doctor
```

It checks all four management credentials without creating or deleting resources. Write and delete access is verified only when `recreate` actually exercises it.
