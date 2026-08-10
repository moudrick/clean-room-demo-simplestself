import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORG_ENV, PROJECT_ENV, REPOS, FLAGS, GH, LD, request, doctor, createRepositoryWithSource, removeIfPresent, waitForRepositoryAbsence, settingsFor, assertScope, tokensFor, requireConfirmation, outcome, redact } from '../lib.mjs';

const env = { GH_ORG: 'example-demo-org', LD_PROJECT_KEY: 'example-demo-project', GH_RESET_TOKEN: 'gh-reset-secret', GH_DEMO_TOKEN: 'gh-demo-secret', LD_RESET_TOKEN: 'ld-reset-secret', LD_DEMO_TOKEN: 'ld-demo-secret' };
test('fixed scope rejects another organization, project, repository, or flag', () => {
  const settings = settingsFor(env);
  assert.throws(() => assertScope({ ...settings, org: 'not/a-safe-org' })); assert.throws(() => assertScope({ ...settings, project: 'not/a-safe-project' }));
  assert.throws(() => assertScope({ ...settings, repos: ['other', REPOS[1], REPOS[2]] })); assert.throws(() => assertScope({ ...settings, flags: [FLAGS[0], FLAGS[1], 'other'] }));
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
  for (const value of [ORG_ENV, PROJECT_ENV, ...REPOS, ...FLAGS]) assert.equal(spec.includes(value), true);
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
test('repository provisioning creates an initial commit before its dated synthetic commit', async () => {
  const calls = []; const responses = [{ default_branch: 'main' }, { object: { sha: 'initial-commit' } }, { tree: { sha: 'initial-tree' } }, { sha: 'source-blob' }, { sha: 'source-tree' }, { sha: 'source-commit' }, {}];
  const fetcher = async (url, options) => { calls.push({ url: String(url), method: options.method, body: options.body }); return { ok: true, status: 200, url: String(url), json: async () => responses.shift() }; };
  await createRepositoryWithSource(fetcher, env.GH_RESET_TOKEN, settingsFor(env), 'demo-orders', { path: 'src/checkout.js', content: 'synthetic source', date: '2020-01-02T03:04:05Z' });
  assert.equal(JSON.parse(calls[0].body).auto_init, true);
  assert.match(calls[1].url, /git\/ref\/heads\/main$/); assert.match(calls[2].url, /git\/commits\/initial-commit$/);
  assert.equal(JSON.parse(calls[4].body).base_tree, 'initial-tree'); assert.deepEqual(JSON.parse(calls[5].body).parents, ['initial-commit']);
  assert.equal(calls[6].method, 'PATCH'); assert.match(calls[6].url, /git\/refs\/heads\/main$/);
});
