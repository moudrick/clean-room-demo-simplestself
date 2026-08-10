import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORG_ENV, PROJECT_ENV, REPOS, FLAGS, GH, request, doctor, settingsFor, assertScope, tokensFor, requireConfirmation, outcome, redact } from '../lib.mjs';

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
test('doctor identifies a failed token check without exposing its value', async () => {
  const fetcher = async () => ({ ok: false, status: 401, url: 'https://api.github.com/user', json: async () => ({}) });
  await assert.rejects(() => doctor(fetcher, env), (error) => error.message.includes('GH_DEMO_TOKEN GitHub authentication/read access failed: API request failed (401).') && !error.message.includes(env.GH_DEMO_TOKEN));
});
