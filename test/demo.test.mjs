import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ORG_ENV, PROJECT_ENV, REPOS, FLAGS, ENVIRONMENTS, GH, LD, SOURCES, request, rateLimitDelayMs, doctor, recreate, refresh, destroy, audit, checkLaunchDarkly, createRepositoryWithSource, createProject, prepareRuntime, configureFlagTargeting, removeIfPresent, waitForRepositoryAbsence, waitForProjectAbsence, settingsFor, assertScope, tokensFor, requireConfirmation, outcome, progressLine, redact, detailedEventsFor, generationIdFor, assertRuntimeStopped, campaignLocked, assertCampaignUnlocked, breakGlassPhrase, CAMPAIGN_LOCK_ENV, baseline, mergeCampaign, flagAgeEvidence, assertFlagCatalog, bootstrapFlags, CATALOG_SIZE, loadScenario, compileScenario, assertSandbox, assertServices, reconcileStep, catalogSource, OWNERSHIP_MARKER } from '../lib.mjs';
const catalogFile = JSON.parse(fs.readFileSync(new URL('../scenario/flags.json', import.meta.url), 'utf8'));

const env = { GH_ORG: 'example-demo-org', LD_PROJECT_KEY: 'example-demo-project', GH_RESET_TOKEN: 'gh-reset-secret', GH_DEMO_TOKEN: 'gh-demo-secret', LD_RESET_TOKEN: 'ld-reset-secret', LD_DEMO_TOKEN: 'ld-demo-secret' };
test('fixed scope rejects another organization, project, repository, flag, or environment set', () => {
  const settings = settingsFor(env);
  assert.throws(() => assertScope({ ...settings, org: 'not/a-safe-org' })); assert.throws(() => assertScope({ ...settings, project: 'not/a-safe-project' }));
  assert.throws(() => assertScope({ ...settings, repos: ['other', REPOS[1], REPOS[2]] })); assert.throws(() => assertScope({ ...settings, flags: [FLAGS[0], FLAGS[1], 'other'] }));
  assert.throws(() => assertScope({ ...settings, environments: ['production', 'test', 'staging', 'other'] }));
  assert.doesNotThrow(() => assertScope(settings));
});
test('organization and project must come from required non-secret environment settings', () => {
  assert.deepEqual(settingsFor(env), { org: 'example-demo-org', project: 'example-demo-project' });
  assert.throws(() => settingsFor({ ...env, GH_ORG: '' })); assert.throws(() => settingsFor({ ...env, LD_PROJECT_KEY: 'project/key' }));
});
test('demo commands cannot access reset tokens and reset cannot fall back', () => {
  assert.deepEqual(Object.keys(tokensFor('audit', env)).sort(), ['GH_DEMO_TOKEN', 'LD_DEMO_TOKEN']);
  assert.deepEqual(Object.keys(tokensFor('recreate', env)).sort(), ['GH_RESET_TOKEN', 'LD_RESET_TOKEN']);
  assert.deepEqual(Object.keys(tokensFor('refresh', env)).sort(), ['GH_RESET_TOKEN', 'LD_RESET_TOKEN']);
  assert.throws(() => tokensFor('recreate', { GH_DEMO_TOKEN: 'x', LD_DEMO_TOKEN: 'y' }));
  assert.throws(() => tokensFor('run', env), /Unknown command/); assert.throws(() => tokensFor('unknown', env), /Unknown command/);
});
test('detailed probe events are explicit non-secret configuration', () => {
  assert.equal(detailedEventsFor(env), false); assert.equal(detailedEventsFor({ ...env, LD_PROBE_DETAILED_EVENTS: 'true' }), true);
  assert.equal(detailedEventsFor({ ...env, LD_PROBE_DETAILED_EVENTS: 'false' }), false);
  assert.throws(() => detailedEventsFor({ ...env, LD_PROBE_DETAILED_EVENTS: 'yes' }), /true or false/);
});
test('traffic generations combine project identity with a stable UTC run marker', () => {
  assert.equal(generationIdFor('project-id', new Date('2026-08-15T12:34:56.789Z')), 'project-id-20260815123456789');
  assert.throws(() => generationIdFor('unsafe/id', new Date()), /Invalid generation/);
});
test('destructive commands require exact configured-project confirmation', () => { assert.throws(() => requireConfirmation('wrong', env.LD_PROJECT_KEY)); assert.doesNotThrow(() => requireConfirmation(env.LD_PROJECT_KEY, env.LD_PROJECT_KEY)); });
test('failed or incomplete evidence cannot become stale or dead', () => {
  for (const evidence of [null, { complete: false, files: [] }, { complete: true, error: true, files: [] }, { complete: true, capped: true, files: [] }, { complete: true, malformed: true, files: [] }]) assert.equal(outcome(evidence), 'UNKNOWN');
  assert.equal(outcome({ complete: true, files: [] }), 'DEAD CANDIDATE');
});
test('specification constants agree with implementation constants', () => {
  const spec = fs.readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
  assert.equal(ORG_ENV, 'GH_ORG'); assert.equal(PROJECT_ENV, 'LD_PROJECT_KEY');
  assert.deepEqual(REPOS, ['demo-orders', 'demo-storefront', 'demo-profile']); assert.deepEqual(FLAGS, ['demo-checkout-rollout', 'demo-legacy-profile', 'demo-retired-banner']);
  assert.deepEqual(ENVIRONMENTS.map((environment) => environment.key), ['production', 'staging', 'test', 'dev']);
  assert.deepEqual(ENVIRONMENTS.map((environment) => environment.critical), [true, true, false, false]);
  for (const value of [ORG_ENV, PROJECT_ENV, ...REPOS, ...FLAGS, ...ENVIRONMENTS.map((environment) => environment.key)]) assert.equal(spec.includes(value), true);
});
test('operator snippets use portable basic Bash on Linux, macOS, and Git Bash', () => {
  const spec = fs.readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const credentials = fs.readFileSync(new URL('../CREDENTIALS.md', import.meta.url), 'utf8');
  const runtime = fs.readFileSync(new URL('../runtime/README.md', import.meta.url), 'utf8');
  for (const name of ['Linux', 'macOS', 'Git Bash']) assert.equal(spec.includes(name), true);
  for (const document of [readme, credentials, runtime]) {
    assert.equal(document.includes('```console'), false); assert.equal(document.includes('```powershell'), false); assert.equal(document.includes('$env:'), false);
  }
  assert.match(readme, /\. \.\/\.env/); assert.equal(readme.includes('--confirm <'), false);
  assert.equal([...readme.matchAll(/--confirm "\$LD_PROJECT_KEY"/g)].length >= 4, true);
  assert.match(readme, /DEMO_EVALUATIONS_PER_HOUR=1200 \\\nDEMO_CONTEXT_POOL_SIZE=1000 \\\n/);
});
test('recreate progress renders a fixed sanitized bar', () => {
  assert.equal(progressLine({ completed: 3, total: 15, label: 'Creating\nrepositories' }), '[####----------------] 3/15 Creating repositories');
  assert.equal(progressLine({ completed: 15, total: 15, label: 'Recreate complete' }), '[####################] 15/15 Recreate complete');
  assert.throws(() => progressLine({ completed: 16, total: 15, label: 'invalid' }), /Invalid progress/);
});
test('tokens never appear in redacted output or errors', () => {
  const message = redact(new Error(`failed ${env.GH_RESET_TOKEN} Authorization=${env.LD_DEMO_TOKEN}`), Object.values(env));
  for (const token of Object.values(env)) assert.equal(message.includes(token), false);
  assert.equal(redact('GH_DEMO_TOKEN authentication failed', Object.values(env)), 'GH_DEMO_TOKEN authentication failed');
});
test('mocked HTTP responses reject an unexpected origin', async () => {
  const fetcher = async () => ({ ok: true, status: 200, url: 'https://example.invalid/response', json: async () => ({}) });
  await assert.rejects(() => request(fetcher, GH, '/user', 'not-a-real-token'), /expected official origin/);
});
test('API errors include a redacted server message but never a token', async () => {
  const fetcher = async () => ({ ok: false, status: 409, url: 'https://api.github.com/orgs/example-demo-org/repos', json: async () => ({ message: 'Repository creation blocked: gh-reset-secret' }) });
  await assert.rejects(() => request(fetcher, GH, '/orgs/example-demo-org/repos', env.GH_RESET_TOKEN), (error) => error.message === 'API request failed (409): Repository creation blocked: [REDACTED]');
});
test('every request retries 429 after Retry-After before succeeding', async () => {
  let attempts = 0; const delays = [];
  const fetcher = async (url) => { attempts += 1; return attempts === 1
    ? { ok: false, status: 429, url: String(url), headers: { 'Retry-After': '2' }, json: async () => ({ message: 'rate limited' }) }
    : { ok: true, status: 200, url: String(url), headers: {}, json: async () => ({ ok: true }) }; };
  const result = await request(fetcher, LD, '/api/v2/projects', env.LD_RESET_TOKEN, {}, { sleep: async (delay) => delays.push(delay), random: () => 0 });
  assert.deepEqual(result, { ok: true }); assert.equal(attempts, 2); assert.deepEqual(delays, [2000]);
});
test('rate-limit progress reports bounded countdown chunks before sleeping', async () => {
  let attempts = 0; const sequence = [];
  const fetcher = async (url) => { attempts += 1; return attempts === 1
    ? { ok: false, status: 429, url: String(url), headers: { 'Retry-After': '0.025' }, json: async () => ({}) }
    : { ok: true, status: 200, url: String(url), headers: {}, json: async () => ({ ok: true }) }; };
  await request(fetcher, LD, '/api/v2/projects', env.LD_RESET_TOKEN, {}, {
    random: () => 0,
    rateLimitTickMs: 10,
    onRateLimit: async (event) => sequence.push(['progress', event]),
    sleep: async (delay) => sequence.push(['sleep', delay])
  });
  assert.deepEqual(sequence.map(([kind]) => kind), ['progress', 'sleep', 'progress', 'sleep', 'progress', 'sleep']);
  assert.deepEqual(sequence.filter(([kind]) => kind === 'sleep').map(([, delay]) => delay), [10, 10, 5]);
  assert.deepEqual(sequence.filter(([kind]) => kind === 'progress').map(([, event]) => event.remainingMs), [25, 15, 5]);
  for (const [, event] of sequence.filter(([kind]) => kind === 'progress')) assert.deepEqual({ provider: event.provider, status: event.status, retry: event.retry, maxRetries: event.maxRetries }, { provider: 'LaunchDarkly', status: 429, retry: 1, maxRetries: 5 });
});
test('rate-limit reset headers use each provider epoch unit', () => {
  assert.equal(rateLimitDelayMs({ headers: { 'X-RateLimit-Reset': '5000' } }, LD, 0, () => 1000, () => 0), 4000);
  assert.equal(rateLimitDelayMs({ headers: { 'X-RateLimit-Reset': '5' } }, GH, 0, () => 1000, () => 0), 4000);
});
test('GitHub rate-limit 403 retries but an ordinary 403 does not', async () => {
  let rateAttempts = 0; const delays = [];
  const rateLimited = async (url) => { rateAttempts += 1; return rateAttempts === 1
    ? { ok: false, status: 403, url: String(url), headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '5' }, json: async () => ({ message: 'rate limit exceeded' }) }
    : { ok: true, status: 200, url: String(url), headers: {}, json: async () => ({}) }; };
  await request(rateLimited, GH, '/user', env.GH_DEMO_TOKEN, {}, { sleep: async (delay) => delays.push(delay), now: () => 1000, random: () => 0 });
  assert.equal(rateAttempts, 2); assert.deepEqual(delays, [4000]);
  let deniedAttempts = 0; const denied = async (url) => { deniedAttempts += 1; return { ok: false, status: 403, url: String(url), headers: {}, json: async () => ({ message: 'forbidden' }) }; };
  await assert.rejects(() => request(denied, GH, '/user', env.GH_DEMO_TOKEN, {}, { sleep: async () => assert.fail('must not sleep') }), /API request failed \(403\)/);
  assert.equal(deniedAttempts, 1);
});
test('rate-limit retry count is bounded', async () => {
  let attempts = 0; const fetcher = async (url) => { attempts += 1; return { ok: false, status: 429, url: String(url), headers: { 'Retry-After': '0' }, json: async () => ({ message: 'still limited' }) }; };
  await assert.rejects(() => request(fetcher, LD, '/api/v2/projects', env.LD_RESET_TOKEN, {}, { sleep: async () => {}, random: () => 0, maxRetries: 2 }), /API request failed \(429\)/);
  assert.equal(attempts, 3);
});
test('rate-limit waits above the local cap fail without retrying early', async () => {
  let attempts = 0; let progress = 0; const fetcher = async (url) => { attempts += 1; return { ok: false, status: 429, url: String(url), headers: { 'Retry-After': '301' }, json: async () => ({}) }; };
  await assert.rejects(() => request(fetcher, LD, '/api/v2/projects', env.LD_RESET_TOKEN, {}, { sleep: async () => assert.fail('must not sleep'), onRateLimit: async () => { progress += 1; }, random: () => 0 }), /five-minute local cap/);
  assert.equal(attempts, 1); assert.equal(progress, 0);
});
test('mocked requests use each API provider’s required authorization form', async () => {
  const headers = [];
  const fetcher = async (url, options) => { headers.push(options.headers); return { ok: true, status: 200, url: String(url), json: async () => ({}) }; };
  await request(fetcher, GH, '/user', 'github-secret'); await request(fetcher, LD, '/api/v2/projects/example-demo-project', 'launchdarkly-secret', { method: 'POST', body: '{}' });
  assert.equal(headers[0].Authorization, 'Bearer github-secret'); assert.equal(headers[1].Authorization, 'launchdarkly-secret'); assert.equal(headers[1]['Content-Type'], 'application/json');
});
test('doctor identifies a failed token check without exposing its value', async () => {
  const fetcher = async () => ({ ok: false, status: 401, url: 'https://api.github.com/user', json: async () => ({}) });
  await assert.rejects(() => doctor(fetcher, env), (error) => error.message.includes('GH_DEMO_TOKEN GitHub authentication/read access failed: API request failed (401).') && !error.message.includes(env.GH_DEMO_TOKEN));
});
test('failed recreate never reports completion', async () => {
  const progress = []; const fetcher = async (url) => ({ ok: false, status: 401, url: String(url), headers: {}, json: async () => ({}) });
  await assert.rejects(() => recreate(fetcher, env, env.LD_PROJECT_KEY, { assertRuntimeStopped: async () => {}, onProgress: async (event) => progress.push(event) }), /GH_RESET_TOKEN/);
  assert.deepEqual(progress.map((event) => event.completed), [0]); assert.equal(progress.some((event) => event.label === 'Recreate complete'), false);
});
test('LaunchDarkly project-list check requests a bounded result set', async () => {
  const calls = []; const fetcher = async (url) => { calls.push(String(url)); return { ok: true, status: 200, url: String(url), json: async () => ({ items: [] }) }; };
  await checkLaunchDarkly(fetcher, env.LD_DEMO_TOKEN, settingsFor(env));
  assert.equal(calls[0], 'https://app.launchdarkly.com/api/v2/projects?limit=100');
});
test('destructive failures identify the reset-token role and exact disposable target', async () => {
  const fetcher = async () => ({ ok: false, status: 403, url: 'https://api.github.com/repos/example-demo-org/demo-orders', json: async () => ({}) });
  await assert.rejects(() => removeIfPresent(fetcher, GH, '/repos/example-demo-org/demo-orders', env.GH_RESET_TOKEN, 'GH_RESET_TOKEN delete repository example-demo-org/demo-orders'), (error) => error.message.includes('GH_RESET_TOKEN delete repository example-demo-org/demo-orders failed: API request failed (403).') && !error.message.includes(env.GH_RESET_TOKEN));
});
test('recreate waits for a deleted repository name to become available', async () => {
  let requests = 0; let sleeps = 0;
  const fetcher = async () => { requests += 1; return requests === 1 ? { ok: true, status: 200, url: 'https://api.github.com/repos/example-demo-org/demo-orders', json: async () => ({}) } : { ok: false, status: 404, url: 'https://api.github.com/repos/example-demo-org/demo-orders', json: async () => ({}) }; };
  await waitForRepositoryAbsence(fetcher, env.GH_RESET_TOKEN, settingsFor(env), 'demo-orders', async () => { sleeps += 1; });
  assert.equal(requests, 2); assert.equal(sleeps, 1);
});
test('recreate waits for the deleted project key to become available', async () => {
  let requests = 0; let sleeps = 0;
  const fetcher = async () => { requests += 1; return requests === 1 ? { ok: true, status: 200, url: 'https://app.launchdarkly.com/api/v2/projects/example-demo-project', json: async () => ({}) } : { ok: false, status: 404, url: 'https://app.launchdarkly.com/api/v2/projects/example-demo-project', json: async () => ({}) }; };
  await waitForProjectAbsence(fetcher, env.LD_RESET_TOKEN, settingsFor(env), async () => { sleeps += 1; });
  assert.equal(requests, 2); assert.equal(sleeps, 1);
});
test('repository provisioning creates an initial commit before its dated synthetic evaluator commit', async () => {
  const calls = []; const responses = [{ default_branch: 'main' }, { object: { sha: 'initial-commit' } }, { tree: { sha: 'initial-tree' } }, ...Array.from({ length: 6 }, (_, index) => ({ sha: `blob-${index}` })), { sha: 'source-tree' }, { sha: 'source-commit' }, {}];
  const fetcher = async (url, options) => { calls.push({ url: String(url), method: options.method, body: options.body }); return { ok: true, status: 200, url: String(url), json: async () => responses.shift() }; };
  await createRepositoryWithSource(fetcher, env.GH_RESET_TOKEN, settingsFor(env), 'demo-orders', SOURCES['demo-orders']);
  assert.equal(JSON.parse(calls[0].body).auto_init, true);
  assert.match(calls[1].url, /git\/ref\/heads\/main$/); assert.match(calls[2].url, /git\/commits\/initial-commit$/);
  const tree = JSON.parse(calls[9].body);
  assert.equal(tree.base_tree, 'initial-tree'); assert.deepEqual(tree.tree.map((entry) => entry.path), ['package.json', 'app.mjs', 'traffic.mjs', 'Dockerfile', '.gitignore', 'README.md']);
  assert.match(SOURCES['demo-orders'].files.find((file) => file.path === 'app.mjs').content, /boolVariation\(flag, context, false\)/);
  assert.match(SOURCES['demo-orders'].files.find((file) => file.path === 'app.mjs').content, /LD_EVALUATION_SDK_KEY/);
  assert.match(SOURCES['demo-orders'].files.find((file) => file.path === 'app.mjs').content, /await client\.flush\(\)/);
  assert.deepEqual(JSON.parse(calls[10].body).parents, ['initial-commit']);
  assert.equal(calls[11].method, 'PATCH'); assert.match(calls[11].url, /git\/refs\/heads\/main$/);
});
test('generated evaluators own only the active flags and flush their evaluations', () => {
  const source = (repo) => SOURCES[repo].files.find((file) => file.path === 'app.mjs').content;
  assert.match(source('demo-orders'), /demo-checkout-rollout/); assert.match(source('demo-storefront'), /demo-checkout-rollout/);
  assert.match(source('demo-profile'), /demo-legacy-profile/); assert.equal(source('demo-orders').includes('demo-retired-banner') || source('demo-storefront').includes('demo-retired-banner') || source('demo-profile').includes('demo-retired-banner'), false);
  for (const repo of REPOS) {
    assert.match(source(repo), /await client\.flush\(\)/); assert.match(source(repo), /evaluations: 10/); assert.match(source(repo), /contextForOneShot/); assert.match(source(repo), /index < options\.evaluations/);
    assert.match(SOURCES[repo].files.find((file) => file.path === 'Dockerfile').content, /ENV NPM_CONFIG_UPDATE_NOTIFIER=false/);
    const parsed = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source(repo), encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});
test('generated multi-contexts have stable kinds, exact cluster weights, and targeting distributions', async () => {
  const source = SOURCES['demo-orders'].files.find((file) => file.path === 'traffic.mjs').content;
  const traffic = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const checkoutTrue = {}; const legacyTrue = {}; const clusterCounts = {};
  for (const profile of ENVIRONMENTS.map((environment) => environment.key)) {
    const checkout = Array.from({ length: 100 }, (_, index) => traffic.contextForTraffic('demo-orders', profile, index, { generation: 'generation-1', contextPoolSize: 17 }));
    const legacy = Array.from({ length: 100 }, (_, index) => traffic.contextForTraffic('demo-profile', profile, index, { generation: 'generation-1' }));
    for (const context of checkout) {
      assert.deepEqual(Object.keys(context), ['kind', 'user', 'service', 'cluster']); assert.equal(context.kind, 'multi');
      assert.equal(context.service.key, 'demo-orders'); assert.equal(context.cluster.environment, profile); assert.equal(context.cluster.generation, 'generation-1');
      assert.match(context.cluster.key, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
    }
    assert.equal(new Set(checkout.map((context) => context.user.key)).size, 17);
    checkoutTrue[profile] = checkout.filter((context) => context.cluster.releaseRing === 'canary' || context.user.plan === 'enterprise' || context.user.cohort === 'checkout-beta').length;
    legacyTrue[profile] = legacy.filter((context) => context.user.region === 'legacy').length;
    clusterCounts[profile] = Object.fromEntries([...new Set(checkout.map((context) => context.cluster.key))].map((cluster) => [cluster, checkout.filter((context) => context.cluster.key === cluster).length]));
  }
  assert.deepEqual(checkoutTrue, { production: 48, staging: 80, test: 91, dev: 40 });
  assert.deepEqual(legacyTrue, { production: 8, staging: 20, test: 30, dev: 12 });
  assert.deepEqual(clusterCounts.production, { 'prod-eu-west-01': 50, 'prod-emea-central-04': 30, 'prod-sa-east-02': 20 });
  assert.deepEqual(clusterCounts.staging, { 'stg-eu-central-01': 60, 'stg-eu-central-02': 40 });
  assert.deepEqual(clusterCounts.test, { 'test-eu-central-01': 75, 'test-eu-central-02': 25 }); assert.deepEqual(clusterCounts.dev, { 'dev-local-01': 100 });
  const busy = new Date('2026-08-17T10:00:00Z'); const quiet = new Date('2026-08-16T10:00:00Z');
  assert.deepEqual(ENVIRONMENTS.map(({ key }) => traffic.batchSize(key, busy)), [100, 30, 10, 2]);
  assert.deepEqual(ENVIRONMENTS.map(({ key }) => traffic.batchSize(key, quiet)), [40, 12, 4, 1]);
  const options = { contextKey: 'demo-user', plan: 'enterprise', region: 'eu', cohort: 'control', cluster: 'prod-eu-west-01', profile: 'production', generation: 'generation-1', evaluations: 10 };
  const oneShot = Array.from({ length: options.evaluations }, (_, index) => traffic.contextForOneShot('demo-orders', options, index));
  assert.equal(new Set(oneShot.map((context) => context.user.key)).size, 10); assert.equal(oneShot[0].user.key, 'demo-user-001'); assert.equal(oneShot.at(-1).user.key, 'demo-user-010');
  assert.equal(oneShot.every((context) => context.cluster.key === 'prod-eu-west-01' && context.user.plan === 'enterprise'), true);
  assert.equal(traffic.contextForOneShot('demo-orders', { ...options, evaluations: 1 }, 0).user.key, 'demo-user');
  assert.throws(() => traffic.contextForOneShot('demo-orders', { ...options, cluster: 'stg-eu-central-01' }, 0), /selected environment/);
});
test('pure load scheduler is exact and compact at all accepted rates', async () => {
  const source = SOURCES['demo-orders'].files.find((file) => file.path === 'traffic.mjs').content;
  const traffic = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#scheduler`);
  for (const rate of [10, 1200, 12347, 100000]) assert.equal(traffic.scheduledEvaluations(rate, 3600000), rate);
  assert.equal(traffic.scheduledEvaluations(12347, 1800000), 6173); assert.throws(() => traffic.scheduledEvaluations(100001, 3600000));
  const summary = traffic.probeSummary({ repository: 'demo-orders', flag: FLAGS[0], generation: 'generation-1', requestedRate: 100000, attempted: 100000, elapsedMs: 3600000, variations: { true: 48000, false: 52000 }, clusters: { 'prod-eu-west-01': 50000, 'prod-emea-central-04': 30000, 'prod-sa-east-02': 20000 }, contextPoolSize: 1000, errors: 0, flush: 'ok', final: true });
  assert.equal(summary.attempted, 100000); assert.equal(summary.achievedEvaluationsPerHour, 100000); assert.equal(summary.contextPoolSize, 1000);
  assert.equal(summary.sdkWarnings, 0); assert.equal(summary.droppedEventWarnings, 0); assert.equal(JSON.stringify(summary).split('\n').length, 1); assert.equal(JSON.stringify(summary).includes(env.LD_RESET_TOKEN), false);
});
test('generated SDK configuration makes probe delivery and graceful flush explicit', () => {
  const orders = SOURCES['demo-orders'].files.find((file) => file.path === 'app.mjs').content;
  for (const expected of [/capacity: 10000/, /flushInterval: 5/, /enableEventCompression: true/, /contextKeysCapacity:/, /contextKeysFlushInterval: 300, logger/, /droppedEventWarnings/, /application:/, /versionName: probe/, /await client\.flush\(\); await client\.close\(\)/]) assert.match(orders, expected);
  assert.match(orders, /integer\([^\n]+10, 100000, 'Evaluations per hour'/); assert.match(orders, /integer\([^\n]+1, 10000, 'Context pool size'/);
  assert.match(orders, /isLoadProbe\(repository, options\.profile\)/); assert.equal(orders.includes('--instance'), false);
});
test('runtime stop guard fails closed when generated Compose services may still run', async () => {
  const present = { existsSync: () => true };
  await assert.doesNotReject(() => assertRuntimeStopped(process.cwd(), { fileSystem: { existsSync: () => false } }));
  await assert.doesNotReject(() => assertRuntimeStopped(process.cwd(), { fileSystem: present, inspect: async () => ({ stdout: '' }) }));
  await assert.rejects(() => assertRuntimeStopped(process.cwd(), { fileSystem: present, inspect: async () => ({ stdout: 'orders-production\n' }) }), /still running/);
  await assert.rejects(() => assertRuntimeStopped(process.cwd(), { fileSystem: present, inspect: async () => { throw new Error('docker unavailable'); } }), /Cannot verify/);
});
test('runtime preparation writes ignored SDK keys and clones only exact public repositories', async () => {
  const writes = []; const clones = []; const operations = [];
  const fileSystem = { rmSync: (...args) => operations.push(['rm', ...args]), mkdirSync: (...args) => operations.push(['mkdir', ...args]), writeFileSync: (...args) => writes.push(args) };
  const environments = ENVIRONMENTS.map((environment) => ({ ...environment, apiKey: `sdk-${environment.key}` }));
  await prepareRuntime(settingsFor(env), environments, 'generation-1', { root: process.cwd(), fileSystem, clone: async (url, target) => clones.push({ url, target }) });
  assert.equal(writes.length, 1); assert.match(writes[0][0], /runtime[\\/]sdk-keys\.env$/);
  for (const environment of ENVIRONMENTS) assert.match(writes[0][1], new RegExp(`LD_EVALUATION_SDK_KEY_${environment.key.toUpperCase()}=sdk-${environment.key}`));
  assert.deepEqual(writes[0][1].trim().split('\n').map((line) => line.split('=')[0]), [...ENVIRONMENTS.map((environment) => `LD_EVALUATION_SDK_KEY_${environment.key.toUpperCase()}`), 'DEMO_GENERATION_ID']);
  assert.match(writes[0][1], /DEMO_GENERATION_ID=generation-1/);
  assert.deepEqual(clones.map((clone) => clone.url), REPOS.map((repo) => `https://github.com/${env.GH_ORG}/${repo}.git`));
  assert.equal(clones.some((clone) => clone.url.includes('token') || clone.url.includes('@github.com')), false);
  assert.equal(operations.some(([kind]) => kind === 'rm'), true);
});
test('runtime preparation removes partial artifacts when a clone fails', async () => {
  const operations = [];
  const fileSystem = {
    rmSync: (...args) => operations.push(['rm', ...args]),
    mkdirSync: (...args) => operations.push(['mkdir', ...args]),
    writeFileSync: (...args) => operations.push(['write', ...args])
  };
  const environments = ENVIRONMENTS.map((environment) => ({ ...environment, apiKey: `sdk-${environment.key}` }));
  await assert.rejects(
    prepareRuntime(settingsFor(env), environments, 'generation-1', { root: process.cwd(), fileSystem, clone: async () => { throw new Error('synthetic clone failure'); } }),
    /synthetic clone failure/
  );
  assert.equal(operations.some(([kind]) => kind === 'write'), false);
  assert.equal(operations.filter(([kind, target]) => kind === 'rm' && /runtime[\\/]repos$/.test(target)).length, 2);
  assert.equal(operations.filter(([kind, target]) => kind === 'rm' && /runtime[\\/]sdk-keys\.env$/.test(target)).length, 2);
});
test('Compose covers every repository/environment pair without evaluating the retired flag', () => {
  const compose = fs.readFileSync(new URL('../runtime/compose.yaml', import.meta.url), 'utf8');
  for (const repo of ['orders', 'storefront', 'profile']) for (const environment of ENVIRONMENTS) assert.match(compose, new RegExp(`^  ${repo}-${environment.key}:`, 'm'));
  const headings = [...compose.matchAll(/^  (orders|storefront|profile)-(production|staging|test|dev):$/gm)].map((match) => match[0].trim().slice(0, -1));
  assert.deepEqual(headings, ENVIRONMENTS.flatMap(({ key }) => ['orders', 'storefront', 'profile'].map((repo) => `${repo}-${key}`)));
  for (const { key } of ENVIRONMENTS) {
    assert.equal([...compose.matchAll(new RegExp(`LD_EVALUATION_SDK_KEY_${key.toUpperCase()}`, 'g'))].length, 3);
    assert.equal([...compose.matchAll(new RegExp(`"--profile", "${key}"`, 'g'))].length, 3);
    assert.equal([...compose.matchAll(new RegExp(`DEMO_ENVIRONMENT: ${key}`, 'g'))].length, 3);
  }
  assert.equal([...compose.matchAll(/^      DEMO_EVALUATIONS_PER_HOUR:/gm)].length, 1); assert.equal([...compose.matchAll(/^      DEMO_CONTEXT_POOL_SIZE:/gm)].length, 1);
  assert.match(compose, /DEMO_EVALUATIONS_PER_HOUR:-1200/); assert.match(compose, /DEMO_GENERATION_ID/);
  assert.equal(compose.includes('demo-retired-banner'), false); assert.match(compose, /restart: unless-stopped/); assert.match(compose, /max-size: 10m/);
});
test('GitHub Actions checks direct pushes to main without lifecycle commands', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(workflow, /push:\s+branches:\s+- main/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /actions\/checkout@v7/); assert.match(workflow, /actions\/setup-node@v7/); assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /node --check demo\.mjs/); assert.match(workflow, /node --check lib\.mjs/); assert.match(workflow, /npm test/);
  for (const command of ['doctor', 'recreate', 'audit', 'destroy']) assert.equal(workflow.includes(`demo.mjs ${command}`), false);
});
test('CLI exposes audit and removes the pre-release run command', () => {
  const cli = fs.readFileSync(new URL('../demo.mjs', import.meta.url), 'utf8');
  assert.equal(typeof audit, 'function'); assert.equal(typeof refresh, 'function'); assert.equal(typeof baseline, 'function');
  assert.match(cli, /command === 'audit'/); assert.match(cli, /command === 'baseline'/);
  assert.match(cli, /command === 'bootstrap'/); assert.match(cli, /command === 'scenario'/);
  assert.match(cli, /<doctor\|baseline\|bootstrap\|scenario\|recreate\|refresh\|audit\|destroy>/); assert.equal(cli.includes("command === 'run'"), false);
});
test('project creation requests precisely the four demo environments', async () => {
  const calls = []; const fetcher = async (url, options) => { calls.push({ url: String(url), options }); const body = calls.length === 1 ? { key: env.LD_PROJECT_KEY, _id: 'generation-1' } : { items: ENVIRONMENTS }; return { ok: true, status: 200, url: String(url), json: async () => body }; };
  await createProject(fetcher, env.LD_RESET_TOKEN, settingsFor(env));
  assert.match(calls[0].url, /\/api\/v2\/projects$/); assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body).environments, ENVIRONMENTS);
  assert.deepEqual(JSON.parse(calls[0].options.body).environments.map(({ key, critical }) => ({ key, critical })), [
    { key: 'production', critical: true }, { key: 'staging', critical: true }, { key: 'test', critical: false }, { key: 'dev', critical: false }
  ]);
  assert.match(calls[1].url, /\/api\/v2\/projects\/example-demo-project\/environments\?limit=100$/);
});
test('LaunchDarkly targeting covers every fixed environment with deterministic rules', async () => {
  const calls = []; const fetcher = async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, status: 200, url: String(url), json: async () => ({}) }; };
  for (const key of FLAGS) for (const environment of ENVIRONMENTS) await configureFlagTargeting(fetcher, env.LD_RESET_TOKEN, settingsFor(env), environment.key, { key, variations: [{ value: true, _id: 'true-id' }, { value: false, _id: 'false-id' }] });
  assert.match(calls[0].url, /\/api\/v2\/flags\/example-demo-project\/demo-checkout-rollout$/);
  for (const call of calls) {
    assert.equal(call.options.headers['Content-Type'], 'application/json; domain-model=launchdarkly.semanticpatch');
    assert.equal(ENVIRONMENTS.some((environment) => environment.key === JSON.parse(call.options.body).environmentKey), true);
  }
  const checkout = JSON.parse(calls[0].options.body).instructions;
  assert.deepEqual(checkout.map((instruction) => instruction.kind), ['updateOffVariation', 'updateFallthroughVariationOrRollout', 'updateTrackEvents', 'replaceTargets', 'turnFlagOn', 'replaceRules']);
  assert.deepEqual(checkout.at(-1).rules.map((rule) => [rule.clauses[0].contextKind, rule.clauses[0].attribute]), [['cluster', 'releaseRing'], ['user', 'cohort'], ['user', 'plan']]);
  assert.equal(checkout[2].trackEvents, false);
  const legacy = JSON.parse(calls[4].options.body).instructions;
  assert.deepEqual(legacy.map((instruction) => instruction.kind), ['updateOffVariation', 'updateFallthroughVariationOrRollout', 'updateTrackEvents', 'replaceTargets', 'turnFlagOn', 'replaceRules']);
  assert.deepEqual([legacy.at(-1).rules[0].clauses[0].contextKind, legacy.at(-1).rules[0].clauses[0].attribute], ['user', 'region']);
  assert.deepEqual(JSON.parse(calls[8].options.body).instructions.map((instruction) => instruction.kind), ['updateOffVariation', 'updateFallthroughVariationOrRollout', 'updateTrackEvents', 'replaceTargets', 'turnFlagOff', 'replaceRules']);
  await configureFlagTargeting(fetcher, env.LD_RESET_TOKEN, settingsFor(env), 'production', { key: FLAGS[0], variations: [{ value: true, _id: 'true-id' }, { value: false, _id: 'false-id' }] }, undefined, { detailedEvents: true });
  assert.equal(JSON.parse(calls.at(-1).options.body).instructions.find((instruction) => instruction.kind === 'updateTrackEvents').trackEvents, true);
});
test('recreate resets the owned project and restores flags across all environments', async () => {
  const calls = []; let blob = 0; let userAttempts = 0; let projectReads = 0;
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname; const method = options.method || 'GET'; calls.push({ path, method, body: options.body });
    let status = 200; let body = {};
    if (path === '/user') { userAttempts += 1; if (userAttempts === 1) status = 429; else body = { login: 'demo-user' }; }
    else if (path === '/orgs/example-demo-org/repos' && method === 'GET') body = [];
    else if (path === '/api/v2/projects' && method === 'GET') body = { items: [] };
    else if (path === '/api/v2/projects/example-demo-project' && method === 'GET') { projectReads += 1; if (projectReads === 1) body = { key: env.LD_PROJECT_KEY, _id: 'old-generation' }; else status = 404; }
    else if (/^\/repos\/example-demo-org\/demo-[^/]+$/.test(path) && method === 'GET') status = 404;
    else if (method === 'DELETE') status = 404;
    else if (path.includes('/git/ref/heads/') && method === 'GET') body = { object: { sha: 'initial-commit' } };
    else if (path.includes('/git/commits/initial-commit')) body = { tree: { sha: 'initial-tree' } };
    else if (path.endsWith('/git/blobs')) body = { sha: `blob-${blob += 1}` };
    else if (path.endsWith('/git/trees')) body = { sha: 'source-tree' };
    else if (path.endsWith('/git/commits') && method === 'POST') body = { sha: 'source-commit' };
    else if (path === '/orgs/example-demo-org/repos' && method === 'POST') body = { default_branch: 'main' };
    else if (path === '/api/v2/projects' && method === 'POST') body = { key: env.LD_PROJECT_KEY, _id: 'new-generation' };
    else if (path.endsWith('/environments')) body = { items: ENVIRONMENTS };
    else if (path === '/api/v2/flags/example-demo-project' && method === 'POST') body = { key: JSON.parse(options.body).key, variations: [{ value: true, _id: 'true-id' }, { value: false, _id: 'false-id' }] };
    return { ok: status < 300, status, url: String(url), headers: status === 429 ? { 'Retry-After': '0' } : {}, json: async () => body };
  };
  let prepared = 0; let preparedAt; const progress = []; const rateLimits = [];
  const result = await recreate(fetcher, env, env.LD_PROJECT_KEY, {
    assertRuntimeStopped: async () => {},
    generation: 'traffic-generation-1',
    prepareRuntime: async () => { prepared += 1; preparedAt = progress.at(-1)?.completed; },
    onProgress: async (event) => progress.push(event),
    onRateLimit: async (event) => rateLimits.push(event),
    request: { sleep: async () => {}, random: () => 0 }
  });
  assert.equal(calls.filter((call) => call.method === 'DELETE' && call.path === '/api/v2/projects/example-demo-project').length, 1);
  assert.equal(calls.filter((call) => call.method === 'DELETE' && call.path.startsWith('/api/v2/flags/')).length, 0);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/api/v2/projects').length, 1);
  assert.equal(result.previousProjectId, 'old-generation'); assert.equal(result.projectId, 'new-generation'); assert.equal(result.generation, 'traffic-generation-1');
  const targeting = calls.filter((call) => call.method === 'PATCH' && call.path.startsWith('/api/v2/flags/'));
  assert.equal(targeting.length, FLAGS.length * ENVIRONMENTS.length);
  assert.deepEqual(new Set(targeting.map((call) => JSON.parse(call.body).environmentKey)), new Set(ENVIRONMENTS.map((environment) => environment.key)));
  assert.equal(prepared, 1); assert.equal(preparedAt, 14);
  assert.deepEqual(progress.map((event) => event.completed), Array.from({ length: 16 }, (_, index) => index));
  assert.equal(progress.every((event) => event.total === 15), true); assert.equal(progress[0].label, 'Checking GitHub reset-token access'); assert.equal(progress.at(-1).label, 'Recreate complete');
  assert.deepEqual(rateLimits, [{ provider: 'GitHub', status: 429, retry: 1, maxRetries: 5, remainingMs: 0 }]);
  for (const secret of [env.GH_RESET_TOKEN, env.GH_DEMO_TOKEN, env.LD_RESET_TOKEN, env.LD_DEMO_TOKEN]) assert.equal(JSON.stringify({ progress, rateLimits }).includes(secret), false);
});
test('refresh preserves project identity, SDK keys, flags, environments, and evaluation history boundary', async () => {
  const calls = []; let blob = 0;
  const environments = ENVIRONMENTS.map((environment) => ({ ...environment, apiKey: `sdk-${environment.key}` }));
  const flagFor = (key) => ({ key, kind: 'boolean', variations: [{ value: true, _id: `${key}-true` }, { value: false, _id: `${key}-false` }], environments: Object.fromEntries(ENVIRONMENTS.map(({ key: environment }) => [environment, { rules: [{ _id: `${key}-${environment}-old-rule` }], prerequisites: [{ key: 'old-prerequisite' }] }])) });
  const fetcher = async (url, options = {}) => {
    const parsed = new URL(url); const path = parsed.pathname; const method = options.method || 'GET'; calls.push({ path, method, body: options.body });
    let status = 200; let body = {};
    if (path === '/user') body = { login: 'demo-user' };
    else if (path === '/orgs/example-demo-org') body = {};
    else if (path === '/orgs/example-demo-org/repos' && method === 'GET') body = [];
    else if (path === '/api/v2/projects/example-demo-project') body = { key: env.LD_PROJECT_KEY, _id: 'preserved-generation' };
    else if (path.endsWith('/environments')) body = { items: environments };
    else if (path === '/api/v2/flags/example-demo-project' && method === 'GET') body = { items: FLAGS.map((key) => ({ key })) };
    else if (method === 'GET' && path.startsWith('/api/v2/flags/example-demo-project/')) body = flagFor(path.split('/').at(-1));
    else if (/^\/repos\/example-demo-org\/demo-[^/]+$/.test(path) && method === 'GET') status = 404;
    else if (method === 'DELETE') status = 404;
    else if (path.includes('/git/ref/heads/') && method === 'GET') body = { object: { sha: 'initial-commit' } };
    else if (path.includes('/git/commits/initial-commit')) body = { tree: { sha: 'initial-tree' } };
    else if (path.endsWith('/git/blobs')) body = { sha: `blob-${blob += 1}` };
    else if (path.endsWith('/git/trees')) body = { sha: 'source-tree' };
    else if (path.endsWith('/git/commits') && method === 'POST') body = { sha: 'source-commit' };
    else if (path === '/orgs/example-demo-org/repos' && method === 'POST') body = { default_branch: 'main' };
    return { ok: status < 300, status, url: String(url), headers: {}, json: async () => body };
  };
  const progress = []; let prepared;
  const result = await refresh(fetcher, env, env.LD_PROJECT_KEY, {
    assertRuntimeStopped: async () => {}, absenceSleep: async () => {}, onProgress: async (event) => progress.push(event),
    generation: 'traffic-generation-2',
    prepareRuntime: async (settings, passedEnvironments, generation) => { prepared = { settings, passedEnvironments, generation }; }
  });
  assert.equal(result.projectId, 'preserved-generation'); assert.equal(result.generation, 'traffic-generation-2'); assert.equal(prepared.generation, 'traffic-generation-2'); assert.deepEqual(prepared.passedEnvironments, environments);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.path.startsWith('/api/v2/projects/')), false);
  assert.equal(calls.some((call) => call.method === 'POST' && (call.path === '/api/v2/projects' || call.path.startsWith('/api/v2/flags/'))), false);
  assert.equal(calls.filter((call) => call.method === 'PATCH' && call.path.startsWith('/api/v2/flags/')).length, FLAGS.length * ENVIRONMENTS.length);
  for (const call of calls.filter((item) => item.method === 'PATCH' && item.path.startsWith('/api/v2/flags/'))) {
    const instructions = JSON.parse(call.body).instructions; assert.equal(instructions[0].kind, 'removePrerequisite'); assert.equal(instructions.some((instruction) => instruction.kind === 'replaceTargets'), true); assert.equal(instructions.filter((instruction) => instruction.kind === 'replaceRules').length, 1);
  }
  assert.deepEqual(progress.map((event) => event.completed), Array.from({ length: 14 }, (_, index) => index)); assert.equal(progress.every((event) => event.total === 13), true); assert.equal(progress.at(-1).label, 'Refresh complete');
});
test('refresh refuses unexpected LaunchDarkly scope before deleting a repository', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname; const method = options.method || 'GET'; calls.push({ path, method }); let body = {}; let status = 200;
    if (path === '/user') body = { login: 'demo-user' };
    else if (path === '/orgs/example-demo-org') body = {};
    else if (path === '/orgs/example-demo-org/repos') body = [];
    else if (path === '/api/v2/projects/example-demo-project') body = { key: env.LD_PROJECT_KEY, _id: 'preserved-generation' };
    else if (path.endsWith('/environments')) body = { items: ENVIRONMENTS.map((item) => ({ ...item, apiKey: `sdk-${item.key}` })) };
    else if (path === '/api/v2/flags/example-demo-project') body = { items: [...FLAGS.map((key) => ({ key })), { key: 'unexpected' }] };
    else status = 404;
    return { ok: status < 300, status, url: String(url), headers: {}, json: async () => body };
  };
  await assert.rejects(() => refresh(fetcher, env, env.LD_PROJECT_KEY, { assertRuntimeStopped: async () => {} }), /flags do not match/);
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);
});
test('destroy removes the owned project rather than individually deleting flags', async () => {
  const calls = []; const fetcher = async (url, options) => { calls.push({ path: new URL(url).pathname, method: options.method }); return { ok: false, status: 404, url: String(url), json: async () => ({}) }; };
  let cleaned = 0; await destroy(fetcher, env, env.LD_PROJECT_KEY, { assertRuntimeStopped: async () => {}, cleanRuntime: () => { cleaned += 1; } });
  assert.equal(calls.filter((call) => call.path === '/api/v2/projects/example-demo-project' && call.method === 'DELETE').length, 1);
  assert.equal(calls.some((call) => call.path.startsWith('/api/v2/flags/')), false);
  assert.equal(cleaned, 1);
});
const lockedEnv = { ...env, CAMPAIGN_LOCK: 'true' };
test('CAMPAIGN_LOCK parses exactly true or false', () => {
  assert.equal(CAMPAIGN_LOCK_ENV, 'CAMPAIGN_LOCK');
  assert.equal(campaignLocked({}), false); assert.equal(campaignLocked({ CAMPAIGN_LOCK: '' }), false); assert.equal(campaignLocked({ CAMPAIGN_LOCK: 'false' }), false);
  assert.equal(campaignLocked({ CAMPAIGN_LOCK: 'true' }), true);
  assert.throws(() => campaignLocked({ CAMPAIGN_LOCK: 'TRUE' }), /must be true or false/);
  assert.throws(() => campaignLocked({ CAMPAIGN_LOCK: '1' }), /must be true or false/);
});
test('campaign lock refuses recreate, refresh, and destroy before any preflight or request', async () => {
  let fetched = 0; const fetcher = async (url) => { fetched += 1; return { ok: true, status: 200, url: String(url), json: async () => ({}) }; };
  let runtimeChecked = 0; const controls = { assertRuntimeStopped: async () => { runtimeChecked += 1; } };
  for (const [name, action] of [['recreate', recreate], ['refresh', refresh], ['destroy', destroy]]) {
    await assert.rejects(() => action(fetcher, lockedEnv, lockedEnv.LD_PROJECT_KEY, controls), /Campaign lock is active/, name);
  }
  assert.equal(fetched, 0); assert.equal(runtimeChecked, 0);
});
test('campaign lock refuses before confirmation and token boundaries are evaluated', async () => {
  const bare = { GH_ORG: env.GH_ORG, LD_PROJECT_KEY: env.LD_PROJECT_KEY, CAMPAIGN_LOCK: 'true' };
  for (const action of [recreate, refresh, destroy]) {
    await assert.rejects(() => action(async () => ({}), bare, 'wrong-confirmation'), /Campaign lock is active/);
  }
});
test('breaking the campaign lock requires the exact typed override phrase', () => {
  const phrase = breakGlassPhrase(env.LD_PROJECT_KEY);
  assert.equal(phrase, 'BREAK CAMPAIGN LOCK example-demo-project');
  for (const wrong of [undefined, '', 'true', 'BREAK CAMPAIGN LOCK', 'break campaign lock example-demo-project', 'BREAK CAMPAIGN LOCK other-project']) {
    assert.throws(() => assertCampaignUnlocked('destroy', lockedEnv, wrong), /Campaign lock is active/, String(wrong));
  }
  assert.doesNotThrow(() => assertCampaignUnlocked('destroy', lockedEnv, phrase));
  assert.doesNotThrow(() => assertCampaignUnlocked('destroy', env, undefined));
  assert.throws(() => assertCampaignUnlocked('destroy', { CAMPAIGN_LOCK: 'true' }, 'BREAK CAMPAIGN LOCK undefined'), /Campaign lock is active/);
});
test('campaign lock refusal names the command and never prints the override phrase', () => {
  assert.throws(() => assertCampaignUnlocked('refresh', lockedEnv), (error) => {
    assert.match(error.message, /refresh is refused/); assert.match(error.message, /SPEC\.md/);
    assert.ok(!error.message.includes('BREAK CAMPAIGN LOCK')); return true;
  });
});
test('flag age evidence converts creation dates into real age and the minimum-age gate', () => {
  const at = new Date('2026-08-16T12:00:00.000Z');
  const evidence = flagAgeEvidence(Date.parse('2026-08-14T09:00:00.000Z'), at);
  assert.equal(evidence.createdAt, '2026-08-14T09:00:00.000Z');
  assert.equal(evidence.ageDaysAtCapture, 2);
  assert.equal(evidence.minimumAgeReachedAt, '2026-09-13T09:00:00.000Z');
  assert.deepEqual(flagAgeEvidence(undefined, at), { createdAt: null, ageDaysAtCapture: null, minimumAgeReachedAt: null });
});
test('campaign merge preserves the original start and scenario identity across reruns', () => {
  const first = mergeCampaign(null, { capturedAt: '2026-08-16T12:00:00.000Z', flags: [], repositories: [] });
  assert.equal(first.campaignStart, '2026-08-16T12:00:00.000Z'); assert.equal(first.scenarioId, 'campaign-2026-08-16');
  const second = mergeCampaign(first, { capturedAt: '2026-09-01T00:00:00.000Z', flags: [], repositories: [] });
  assert.equal(second.campaignStart, first.campaignStart); assert.equal(second.scenarioId, first.scenarioId);
  assert.equal(second.capturedAt, '2026-09-01T00:00:00.000Z');
});
test('baseline reads identity and age with demo tokens only and never mutates', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, method: options.method || 'GET', auth: options.headers?.Authorization });
    const reply = (body) => ({ ok: true, status: 200, url: String(url), headers: {}, json: async () => body });
    if (parsed.pathname === '/api/v2/projects/example-demo-project') return reply({ key: 'example-demo-project', _id: 'proj123', name: 'Demo' });
    if (parsed.pathname === '/api/v2/flags/example-demo-project') return reply({ items: [
      { key: 'demo-retired-banner', kind: 'boolean', temporary: true, creationDate: Date.parse('2026-08-14T09:00:00.000Z') },
      { key: 'demo-checkout-rollout', kind: 'boolean', temporary: true, creationDate: Date.parse('2026-08-13T09:00:00.000Z') }] });
    if (parsed.pathname.endsWith('/commits')) return reply([{ sha: 'abc123', commit: { committer: { date: '2026-08-15T10:00:00.000Z' } } }]);
    return reply({ id: 42, node_id: 'R_42', created_at: '2026-08-13T08:00:00.000Z', default_branch: 'main', private: false });
  };
  const result = await baseline(fetcher, env, { now: '2026-08-16T12:00:00.000Z' });
  assert.equal(result.project.id, 'proj123'); assert.equal(result.organization, 'example-demo-org');
  assert.deepEqual(result.flags.map((flag) => flag.key), ['demo-checkout-rollout', 'demo-retired-banner']);
  assert.equal(result.flags[0].ageDaysAtCapture, 3); assert.equal(result.flags[0].minimumAgeReachedAt, '2026-09-12T09:00:00.000Z');
  assert.equal(result.repositories.length, REPOS.length); assert.equal(result.repositories[0].headShaAtBaseline, 'abc123');
  assert.equal(calls.every((call) => call.method === 'GET'), true);
  assert.equal(calls.some((call) => call.auth === 'ld-reset-secret' || call.auth === 'Bearer gh-reset-secret'), false);
});
test('the tracked flag catalog satisfies the campaign contract', () => {
  const result = assertFlagCatalog(catalogFile);
  assert.equal(CATALOG_SIZE, 24); assert.equal(result.keys.length, 24);
  assert.deepEqual([...result.protected].sort(), ['demo-express-returns', 'demo-profile-preferences']);
  assert.equal(result.rehearsal.length, 2);
  for (const key of FLAGS) assert.ok(result.keys.includes(key), key);
});
test('flag catalog validation refuses malformed, unsafe, or contract-breaking catalogs', () => {
  const clone = () => JSON.parse(JSON.stringify(catalogFile));
  assert.throws(() => assertFlagCatalog({ ...clone(), schemaVersion: 2 }), /schema version/);
  const short = clone(); short.flags.pop(); assert.throws(() => assertFlagCatalog(short), /exactly 24 flags/);
  const unsafe = clone(); unsafe.flags[5].key = 'other-project-flag'; assert.throws(() => assertFlagCatalog(unsafe), /unsafe catalog flag key/);
  const duplicate = clone(); duplicate.flags[5].key = duplicate.flags[4].key; assert.throws(() => assertFlagCatalog(duplicate), /Duplicate catalog flag key/);
  const dropped = clone();
  dropped.flags = dropped.flags.filter((flag) => flag.key !== 'demo-legacy-profile');
  dropped.flags.push({ key: 'demo-filler', name: 'Filler', temporary: true, cohort: 'bootstrap', presentationRole: 'cleanup-draining' });
  assert.throws(() => assertFlagCatalog(dropped), /must adopt the pre-existing flag demo-legacy-profile/);
  const roles = clone(); roles.flags.find((flag) => flag.presentationRole === 'not-started').presentationRole = 'archived';
  assert.throws(() => assertFlagCatalog(roles), /must cover exactly/);
  const guarded = clone(); guarded.flags.find((flag) => flag.protected === true).protected = false;
  assert.throws(() => assertFlagCatalog(guarded), /two protected live-demo/);
});
test('bootstrap creates only missing catalog flags and adopts existing ones by identity', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const parsed = new URL(url); const method = options.method || 'GET';
    calls.push({ path: parsed.pathname, method, auth: options.headers?.Authorization, body: options.body });
    if (method === 'GET') return { ok: true, status: 200, url: String(url), headers: {}, json: async () => ({ items: FLAGS.map((key, index) => ({ key, _id: `existing-${index}` })) }) };
    return { ok: true, status: 200, url: String(url), headers: {}, json: async () => ({ key: JSON.parse(options.body).key, _id: 'new-id' }) };
  };
  const result = await bootstrapFlags(fetcher, env, env.LD_PROJECT_KEY, catalogFile, { scenarioId: 'campaign-2026-08-16' });
  assert.equal(result.adopted.length, 3); assert.equal(result.created.length, 21);
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 21);
  assert.equal(posts.some((call) => FLAGS.includes(JSON.parse(call.body).key)), false);
  assert.equal(calls.some((call) => ['DELETE', 'PUT', 'PATCH'].includes(call.method)), false);
  assert.equal(calls.every((call) => call.path.startsWith('/api/v2/flags/')), true);
  assert.equal(calls.some((call) => call.auth === 'ld-demo-secret' || call.auth === 'Bearer gh-reset-secret'), false);
  const first = JSON.parse(posts[0].body);
  assert.deepEqual(first.tags, ['campaign-2026-08-16']);
  assert.deepEqual(first.variations, [{ value: true }, { value: false }]);
  assert.equal(typeof first.temporary, 'boolean');
});
test('repeated bootstrap is a verified no-op that creates nothing', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ method: options.method || 'GET' });
    return { ok: true, status: 200, url: String(url), headers: {}, json: async () => ({ items: catalogFile.flags.map((flag, index) => ({ key: flag.key, _id: `id-${index}` })) }) };
  };
  const result = await bootstrapFlags(fetcher, env, env.LD_PROJECT_KEY, catalogFile, { scenarioId: 'campaign-2026-08-16' });
  assert.equal(result.created.length, 0); assert.equal(result.adopted.length, 24);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});
test('bootstrap refuses unknown project drift, inexact confirmation, and a missing scenario identity', async () => {
  const fetcher = async (url) => ({ ok: true, status: 200, url: String(url), headers: {}, json: async () => ({ items: [{ key: 'someone-elses-flag', _id: 'x' }] }) });
  await assert.rejects(() => bootstrapFlags(fetcher, env, env.LD_PROJECT_KEY, catalogFile, { scenarioId: 'campaign-2026-08-16' }), /absent from the catalog/);
  await assert.rejects(() => bootstrapFlags(fetcher, env, 'wrong-key', catalogFile, { scenarioId: 'campaign-2026-08-16' }), /exact configured project key/);
  await assert.rejects(() => bootstrapFlags(fetcher, env, env.LD_PROJECT_KEY, catalogFile, {}), /scenario identifier/);
});
const scenarioFiles = loadScenario(new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
test('the tracked scenario compiles and satisfies the topology and consumer contract', () => {
  const model = compileScenario(scenarioFiles);
  assert.equal(model.scenarioId, 'campaign-2026-08-16');
  assert.equal(model.services.length, 7);
  assert.ok(model.deployments.length <= scenarioFiles.sandbox.limits.maxEvaluatorContainers);
  assert.equal(model.checksum, compileScenario(scenarioFiles).checksum, 'checksum must be stable across compiles');
  const orders = model.services.find((service) => service.key === 'demo-orders');
  assert.deepEqual(orders.references, ['demo-checkout-rollout'], 'pre-campaign source references are seeded, not invented');
});
test('sandbox validation enforces environment order, criticality, and bounds', () => {
  const clone = () => JSON.parse(JSON.stringify(scenarioFiles.sandbox));
  assert.throws(() => assertSandbox({ ...clone(), schemaVersion: 2 }), /schema version/);
  const reordered = clone(); [reordered.environments[0], reordered.environments[1]] = [reordered.environments[1], reordered.environments[0]];
  assert.throws(() => assertSandbox(reordered), /environment order/);
  const uncritical = clone(); uncritical.environments[0].critical = false;
  assert.throws(() => assertSandbox(uncritical), /must declare critical true/);
  const overCap = clone(); overCap.limits.maxEvaluatorContainers = 40;
  assert.throws(() => assertSandbox(overCap), /maxEvaluatorContainers/);
});
test('service validation enforces catalog membership and consumer spread', () => {
  const clone = () => JSON.parse(JSON.stringify(scenarioFiles.services));
  const unknown = clone(); unknown.services[3].flags.push('demo-not-in-catalog');
  assert.throws(() => assertServices(unknown, scenarioFiles.catalog, scenarioFiles.sandbox), /consumes unknown flag/);
  const narrowed = clone();
  for (const service of narrowed.services) service.flags = service.flags.filter((key) => key !== 'demo-checkout-rollout');
  assert.throws(() => assertServices(narrowed, scenarioFiles.catalog, scenarioFiles.sandbox), /at least five services/);
});
test('the compiler is forward-only and refuses contract violations', () => {
  const base = () => JSON.parse(JSON.stringify(scenarioFiles));
  const rerun = base(); rerun.steps.push({ ...JSON.parse(JSON.stringify(rerun.steps[0])), id: 's002', recommendedDate: '2026-08-21' });
  assert.throws(() => compileScenario(rerun), /re-introduces/);
  const backward = base(); backward.steps.push({ schemaVersion: 1, id: 's002', recommendedDate: '2026-08-01', cadence: 'three-day' });
  assert.throws(() => compileScenario(backward), /forward-only/);
  const daily = base(); daily.steps.push({ schemaVersion: 1, id: 's002', recommendedDate: '2026-08-25', cadence: 'daily' });
  assert.throws(() => compileScenario(daily), /daily cadence outside the permitted/);
  const allowedDaily = base(); allowedDaily.steps.push({ schemaVersion: 1, id: 's002', recommendedDate: '2026-08-25', cadence: 'daily', transition: 'staging-canary' });
  assert.doesNotThrow(() => compileScenario(allowedDaily), 'a named short transition may use daily cadence');
  const inWindow = base(); inWindow.steps.push({ schemaVersion: 1, id: 's002', recommendedDate: '2026-09-11', cadence: 'daily' });
  assert.doesNotThrow(() => compileScenario(inWindow), 'the screenshot window permits daily cadence');
  const overCap = base();
  overCap.steps[0].deploy.push({ service: 'demo-profile', environment: 'test', traffic: 'rare' });
  assert.throws(() => compileScenario(overCap), /exceeding the cap of 12/);
  const undeclared = base(); undeclared.steps[0].sourceReferences['demo-search'] = ['demo-fraud-screening'];
  assert.throws(() => compileScenario(undeclared), /does not declare it as a consumer/);
  const gap = base(); gap.steps.push({ schemaVersion: 1, id: 's002', recommendedDate: '2026-08-19', cadence: 'three-day', minGapDaysFromPrevious: 3 });
  assert.throws(() => compileScenario(gap), /requires at least 3/);
});
test('reconcile creates missing catalog repositories and refuses ownership drift', async () => {
  const calls = [];
  const make = (markerFor) => async (url, options = {}) => {
    const parsed = new URL(url); const method = options.method || 'GET';
    calls.push({ path: parsed.pathname, method });
    const reply = (body, status = 200) => ({ ok: status < 300, status, url: String(url), headers: {}, json: async () => body });
    const repository = parsed.pathname.split('/')[3];
    const marker = markerFor(repository);
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(parsed.pathname)) return marker ? reply({ id: 7, node_id: 'R_7' }) : reply({ message: 'Not Found' }, 404);
    if (parsed.pathname.endsWith(`/contents/${OWNERSHIP_MARKER}`)) return marker ? reply({ content: Buffer.from(JSON.stringify(marker)).toString('base64') }) : reply({ message: 'Not Found' }, 404);
    if (parsed.pathname.endsWith('/repos') && method === 'POST') return reply({ id: 1, node_id: 'R_1', default_branch: 'main' });
    if (parsed.pathname.includes('/git/ref/heads/')) return reply({ object: { sha: 'parent-sha' } });
    if (parsed.pathname.includes('/git/commits/')) return reply({ tree: { sha: 'tree-sha' } });
    if (parsed.pathname.endsWith('/git/blobs')) return reply({ sha: 'blob-sha' });
    if (parsed.pathname.endsWith('/git/trees')) return reply({ sha: 'new-tree' });
    if (parsed.pathname.endsWith('/git/commits')) return reply({ sha: 'commit-sha' });
    return reply({});
  };
  const created = await reconcileStep(make(() => null), env, scenarioFiles, 's001', { confirmation: env.LD_PROJECT_KEY });
  assert.equal(created.created.length, 4); assert.equal(created.adopted.length, 0);
  assert.equal(created.created[0].commitSha, 'commit-sha');
  assert.ok(created.created[0].tag.endsWith('-v001'));
  assert.equal(calls.some((call) => call.method === 'DELETE'), false, 'the reconciler never deletes');
  const owned = await reconcileStep(make((name) => ({ scenarioId: 'campaign-2026-08-16', service: name })), env, scenarioFiles, 's001', { confirmation: env.LD_PROJECT_KEY });
  assert.equal(owned.adopted.length, 4, 'correctly marked repositories are adopted, not recreated');
  assert.equal(owned.created.length, 0);
  await assert.rejects(() => reconcileStep(make((name) => ({ scenarioId: 'someone-else', service: name })), env, scenarioFiles, 's001', { confirmation: env.LD_PROJECT_KEY }), /without this scenario's ownership marker/);
  await assert.rejects(() => reconcileStep(make(() => ({ scenarioId: 'campaign-2026-08-16', service: 'demo-wrong' })), env, scenarioFiles, 's001', { confirmation: env.LD_PROJECT_KEY }), /without this scenario's ownership marker/);
});
test('generated catalog source carries the ownership marker and literal flag keys', () => {
  const source = catalogSource('demo-search', ['demo-search-ranking-v3'], 'campaign-2026-08-16', 'nodejs');
  const marker = source.files.find((file) => file.path === OWNERSHIP_MARKER);
  assert.deepEqual(JSON.parse(marker.content), { scenarioId: 'campaign-2026-08-16', service: 'demo-search', template: 'nodejs' });
  const app = source.files.find((file) => file.path === 'app.mjs');
  assert.match(app.content, /demo-search-ranking-v3/, 'the literal flag key must appear in executable source');
  assert.throws(() => catalogSource('demo-payments', [], 'campaign-2026-08-16', 'go'), /not implemented yet/);
});
test('campaign lock leaves read-only audit unaffected', async () => {
  const fetcher = async (url) => ({ ok: true, status: 200, url: String(url), headers: {}, json: async () => ({ items: [], total_count: 0 }) });
  let message = ''; try { await audit(fetcher, lockedEnv); } catch (error) { message = error.message; }
  assert.ok(!/Campaign lock/.test(message), message);
});
