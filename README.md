# Simplest self-provisioning clean-room demo

Experimental, synthetic feature-flag reference demo. Configure `GH_ORG` and `LD_PROJECT_KEY` in `.env`. Its destructive boundary is exactly three repositories (`demo-orders`, `demo-storefront`, `demo-profile`) in that organization and three flags in that project; it never manages the surrounding organization, account, or project.

Copy `.env.example` to ignored `.env`, set `GH_ORG` and `LD_PROJECT_KEY`, and fill all four token values. Create GitHub fine-grained PATs for resource owner `GH_ORG`, all repositories, short expiry: reset needs Administration and Contents read/write; demo needs Contents read-only (Metadata is normally automatic for both). The organization must permit repository creation/deletion by the token holder. In LaunchDarkly, go to **Organization settings → Authorization → Create token**, create `featureflag-demo-reset` (Writer) and `featureflag-demo-read` (Reader), both API version `20240415`; copy each value immediately because it is shown once.

Run first:

```console
node demo.mjs doctor
node demo.mjs recreate --confirm <your-LD_PROJECT_KEY-value>
node demo.mjs run
node demo.mjs destroy --confirm <your-LD_PROJECT_KEY-value>
```

`recreate` and `destroy` require the exact confirmation and use reset tokens only. `run` uses demo tokens only. See [SPEC.md](SPEC.md) for normative behavior and limitations.

After deleting a disposable GitHub repository, `recreate` waits for it to become absent from the API before recreating it (at most ten seconds).
