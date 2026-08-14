import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORG_ENV, PROJECT_ENV, REPOS, FLAGS, ENVIRONMENTS, GH, LD, SOURCES, request, rateLimitDelayMs, doctor, recreate, destroy, checkLaunchDarkly, createRepositoryWithSource, createProject, prepareRuntime, configureFlagTargeting, removeIfPresent, waitForRepositoryAbsence, waitForProjectAbsence, settingsFor, assertScope, tokensFor, requireConfirmation, outcome, redact } from '../lib.mjs';

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
  assert.deepEqual(Object.keys(tokensFor('run', env)).sort(), ['GH_DEMO_TOKEN', 'LD_DEMO_TOKEN']);
  assert.deepEqual(Object.keys(tokensFor('recreate', env)).sort(), ['GH_RESET_TOKEN', 'LD_RESET_TOKEN']);
  assert.throws(() => tokensFor('recreate', { GH_DEMO_TOKEN: 'x', LD_DEMO_TOKEN: 'y' }));
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
  assert.deepEqual(ENVIRONMENTS.map((environment) => environment.key), ['production', 'test', 'staging', 'dev']);
  for (const value of [ORG_ENV, PROJECT_ENV, ...REPOS, ...FLAGS, ...ENVIRONMENTS.map((environment) => environment.key)]) assert.equal(spec.includes(value), true);
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
  let attempts = 0; const fetcher = async (url) => { attempts += 1; return { ok: false, status: 429, url: String(url), headers: { 'Retry-After': '301' }, json: async () => ({}) }; };
  await assert.rejects(() => request(fetcher, LD, '/api/v2/projects', env.LD_RESET_TOKEN, {}, { sleep: async () => assert.fail('must not sleep'), random: () => 0 }), /five-minute local cap/);
  assert.equal(attempts, 1);
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
  for (const repo of REPOS) assert.match(source(repo), /await client\.flush\(\)/);
});
test('generated traffic profiles deterministically exercise targeting and quiet/busy volume', async () => {
  const source = SOURCES['demo-orders'].files.find((file) => file.path === 'traffic.mjs').content;
  const traffic = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const trueCounts = {};
  for (const profile of ENVIRONMENTS.map((environment) => environment.key)) {
    const contexts = Array.from({ length: 100 }, (_, index) => traffic.contextForTraffic('demo-orders', profile, index));
    trueCounts[profile] = contexts.filter((context) => context.plan === 'enterprise' || context.cohort === 'checkout-beta').length;
  }
  assert.equal(new Set(Object.values(trueCounts)).size, ENVIRONMENTS.length);
  assert.equal(traffic.batchSize('production', new Date('2026-08-17T10:00:00Z')), 4);
  assert.equal(traffic.batchSize('production', new Date('2026-08-16T10:00:00Z')), 1);
});
test('runtime preparation writes ignored SDK keys and clones only exact public repositories', async () => {
  const writes = []; const clones = []; const operations = [];
  const fileSystem = { rmSync: (...args) => operations.push(['rm', ...args]), mkdirSync: (...args) => operations.push(['mkdir', ...args]), writeFileSync: (...args) => writes.push(args) };
  const environments = ENVIRONMENTS.map((environment) => ({ ...environment, apiKey: `sdk-${environment.key}` }));
  await prepareRuntime(settingsFor(env), environments, { root: process.cwd(), fileSystem, clone: async (url, target) => clones.push({ url, target }) });
  assert.equal(writes.length, 1); assert.match(writes[0][0], /runtime[\\/]sdk-keys\.env$/);
  for (const environment of ENVIRONMENTS) assert.match(writes[0][1], new RegExp(`LD_EVALUATION_SDK_KEY_${environment.key.toUpperCase()}=sdk-${environment.key}`));
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
    prepareRuntime(settingsFor(env), environments, { root: process.cwd(), fileSystem, clone: async () => { throw new Error('synthetic clone failure'); } }),
    /synthetic clone failure/
  );
  assert.equal(operations.some(([kind]) => kind === 'write'), false);
  assert.equal(operations.filter(([kind, target]) => kind === 'rm' && /runtime[\\/]repos$/.test(target)).length, 2);
  assert.equal(operations.filter(([kind, target]) => kind === 'rm' && /runtime[\\/]sdk-keys\.env$/.test(target)).length, 2);
});
test('Compose covers every repository/environment pair without evaluating the retired flag', () => {
  const compose = fs.readFileSync(new URL('../runtime/compose.yaml', import.meta.url), 'utf8');
  for (const repo of ['orders', 'storefront', 'profile']) for (const environment of ENVIRONMENTS) assert.match(compose, new RegExp(`^  ${repo}-${environment.key}:`, 'm'));
  assert.equal(compose.includes('demo-retired-banner'), false); assert.match(compose, /restart: unless-stopped/); assert.match(compose, /max-size: 10m/);
});
test('GitHub Actions checks direct pushes to main without lifecycle commands', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(workflow, /push:\s+branches:\s+- main/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /node --check demo\.mjs/); assert.match(workflow, /node --check lib\.mjs/); assert.match(workflow, /npm test/);
  for (const command of ['doctor', 'recreate', 'run', 'destroy']) assert.equal(workflow.includes(`demo.mjs ${command}`), false);
});
test('project creation requests precisely the four demo environments', async () => {
  const calls = []; const fetcher = async (url, options) => { calls.push({ url: String(url), options }); const body = calls.length === 1 ? { key: env.LD_PROJECT_KEY } : { items: ENVIRONMENTS }; return { ok: true, status: 200, url: String(url), json: async () => body }; };
  await createProject(fetcher, env.LD_RESET_TOKEN, settingsFor(env));
  assert.match(calls[0].url, /\/api\/v2\/projects$/); assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body).environments, ENVIRONMENTS);
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
  assert.deepEqual(JSON.parse(calls[0].options.body).instructions.map((instruction) => instruction.kind), ['updateOffVariation', 'updateFallthroughVariationOrRollout', 'turnFlagOn', 'addRule', 'addRule']);
  assert.deepEqual(JSON.parse(calls[0].options.body).instructions.slice(-2).map((instruction) => instruction.clauses[0].attribute), ['cohort', 'plan']);
  assert.deepEqual(JSON.parse(calls[4].options.body).instructions.map((instruction) => instruction.kind), ['updateOffVariation', 'updateFallthroughVariationOrRollout', 'turnFlagOn', 'addRule']);
  assert.equal(JSON.parse(calls[4].options.body).instructions.at(-1).clauses[0].attribute, 'region');
  assert.deepEqual(JSON.parse(calls[8].options.body).instructions.map((instruction) => instruction.kind), ['updateOffVariation', 'updateFallthroughVariationOrRollout', 'turnFlagOff']);
});
test('recreate resets the owned project and restores flags across all environments', async () => {
  const calls = []; let blob = 0;
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname; const method = options.method || 'GET'; calls.push({ path, method, body: options.body });
    let status = 200; let body = {};
    if (path === '/user') body = { login: 'demo-user' };
    else if (path === '/orgs/example-demo-org/repos' && method === 'GET') body = [];
    else if (path === '/api/v2/projects' && method === 'GET') body = { items: [] };
    else if (path === '/api/v2/projects/example-demo-project' && method === 'GET') status = 404;
    else if (/^\/repos\/example-demo-org\/demo-[^/]+$/.test(path) && method === 'GET') status = 404;
    else if (method === 'DELETE') status = 404;
    else if (path.includes('/git/ref/heads/') && method === 'GET') body = { object: { sha: 'initial-commit' } };
    else if (path.includes('/git/commits/initial-commit')) body = { tree: { sha: 'initial-tree' } };
    else if (path.endsWith('/git/blobs')) body = { sha: `blob-${blob += 1}` };
    else if (path.endsWith('/git/trees')) body = { sha: 'source-tree' };
    else if (path.endsWith('/git/commits') && method === 'POST') body = { sha: 'source-commit' };
    else if (path === '/orgs/example-demo-org/repos' && method === 'POST') body = { default_branch: 'main' };
    else if (path === '/api/v2/projects' && method === 'POST') body = { key: env.LD_PROJECT_KEY };
    else if (path.endsWith('/environments')) body = { items: ENVIRONMENTS };
    else if (path === '/api/v2/flags/example-demo-project' && method === 'POST') body = { key: JSON.parse(options.body).key, variations: [{ value: true, _id: 'true-id' }, { value: false, _id: 'false-id' }] };
    return { ok: status < 300, status, url: String(url), json: async () => body };
  };
  let prepared = 0;
  await recreate(fetcher, env, env.LD_PROJECT_KEY, { prepareRuntime: async () => { prepared += 1; } });
  assert.equal(calls.filter((call) => call.method === 'DELETE' && call.path === '/api/v2/projects/example-demo-project').length, 1);
  assert.equal(calls.filter((call) => call.method === 'DELETE' && call.path.startsWith('/api/v2/flags/')).length, 0);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/api/v2/projects').length, 1);
  const targeting = calls.filter((call) => call.method === 'PATCH' && call.path.startsWith('/api/v2/flags/'));
  assert.equal(targeting.length, FLAGS.length * ENVIRONMENTS.length);
  assert.deepEqual(new Set(targeting.map((call) => JSON.parse(call.body).environmentKey)), new Set(ENVIRONMENTS.map((environment) => environment.key)));
  assert.equal(prepared, 1);
});
test('destroy removes the owned project rather than individually deleting flags', async () => {
  const calls = []; const fetcher = async (url, options) => { calls.push({ path: new URL(url).pathname, method: options.method }); return { ok: false, status: 404, url: String(url), json: async () => ({}) }; };
  let cleaned = 0; await destroy(fetcher, env, env.LD_PROJECT_KEY, { cleanRuntime: () => { cleaned += 1; } });
  assert.equal(calls.filter((call) => call.path === '/api/v2/projects/example-demo-project' && call.method === 'DELETE').length, 1);
  assert.equal(calls.some((call) => call.path.startsWith('/api/v2/flags/')), false);
  assert.equal(cleaned, 1);
});
