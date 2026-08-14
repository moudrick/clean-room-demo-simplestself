# Simplest self-provisioning clean-room demo

Experimental, synthetic feature-flag reference demo. Configure `GH_ORG` and the non-default, dedicated `LD_PROJECT_KEY` in `.env`. Its destructive boundary is exactly three repositories (`demo-orders`, `demo-storefront`, `demo-profile`) in that organization and that entire LaunchDarkly project. It never creates, renames, or deletes the surrounding organization or account.

Copy `.env.example` to ignored `.env`, set `GH_ORG` and a dedicated, non-default `LD_PROJECT_KEY`, then fill the four management-token values. Create GitHub fine-grained PATs for resource owner `GH_ORG`, all repositories, short expiry: reset needs Administration and Contents read/write; demo needs Contents read-only (Metadata is normally automatic for both). The organization must permit repository creation/deletion by the token holder. In LaunchDarkly, go to **Organization settings → Authorization → Create token**, create `featureflag-demo-reset` (Writer) and `featureflag-demo-read` (Reader), both API version `20240415`; copy each value immediately because it is shown once. `recreate` creates `production`, `test`, `staging`, and `dev`; after it completes, copy the server-side SDK key of the environment you want to evaluate into `LD_EVALUATION_SDK_KEY`. It is used only by generated apps, never by `demo.mjs`.

Run first:

```console
node demo.mjs doctor
node demo.mjs recreate --confirm <your-LD_PROJECT_KEY-value>
node demo.mjs run
node demo.mjs destroy --confirm <your-LD_PROJECT_KEY-value>
```

`recreate` and `destroy` require the exact confirmation and use reset tokens only. `run` uses demo tokens only. See [SPEC.md](SPEC.md) for normative behavior and limitations.

After deleting a disposable GitHub repository, `recreate` waits for it to become absent from the API before recreating it (at most ten seconds).

`destroy` deletes the dedicated LaunchDarkly project, including every flag and environment inside it. It cannot delete an account's last project.

After `recreate`, clone any generated repository, run `npm install`, then evaluate its synthetic flag with `LD_EVALUATION_SDK_KEY` set. For example: `npm run evaluate -- --cohort checkout-beta`. The app flushes its evaluation event before exiting.
