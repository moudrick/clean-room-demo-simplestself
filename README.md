# Simplest self-provisioning clean-room demo

Experimental, synthetic feature-flag reference demo. Its destructive boundary is exactly three repositories (`demo-orders`, `demo-storefront`, `demo-profile`) in `featureflag-extensiveconsumer-demo-org` and three flags in LaunchDarkly project `featureflag-extensiveconsumer-demo-key`; it never manages the surrounding organization, account, or project.

Copy `.env.example` to ignored `.env` and fill all four values. Create GitHub fine-grained PATs for resource owner `featureflag-extensiveconsumer-demo-org`, all repositories, short expiry: reset needs Administration and Contents read/write; demo needs Contents read-only (Metadata is normally automatic for both). The organization must permit repository creation/deletion by the token holder. In LaunchDarkly, go to **Organization settings → Authorization → Create token**, create `featureflag-demo-reset` (Writer) and `featureflag-demo-read` (Reader), both API version `20240415`; copy each value immediately because it is shown once.

Run first:

```console
node demo.mjs doctor
node demo.mjs recreate --confirm featureflag-extensiveconsumer-demo-key
node demo.mjs run
node demo.mjs destroy --confirm featureflag-extensiveconsumer-demo-key
```

`recreate` and `destroy` require the exact confirmation and use reset tokens only. `run` uses demo tokens only. See [SPEC.md](SPEC.md) for normative behavior and limitations.
