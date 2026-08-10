import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORG, PROJECT, REPOS, FLAGS, GH, request, assertScope, tokensFor, requireConfirmation, outcome, redact } from '../lib.mjs';

const env = { GH_RESET_TOKEN: 'gh-reset-secret', GH_DEMO_TOKEN: 'gh-demo-secret', LD_RESET_TOKEN: 'ld-reset-secret', LD_DEMO_TOKEN: 'ld-demo-secret' };
test('fixed scope rejects another organization, project, repository, or flag', () => {
  assert.throws(() => assertScope({ org: 'elsewhere' })); assert.throws(() => assertScope({ project: 'other' }));
  assert.throws(() => assertScope({ repos: ['other', REPOS[1], REPOS[2]] })); assert.throws(() => assertScope({ flags: [FLAGS[0], FLAGS[1], 'other'] }));
  assert.doesNotThrow(() => assertScope());
});
test('demo commands cannot access reset tokens and reset cannot fall back', () => {
  assert.deepEqual(Object.keys(tokensFor('run', env)).sort(), ['GH_DEMO_TOKEN', 'LD_DEMO_TOKEN']);
  assert.deepEqual(Object.keys(tokensFor('recreate', env)).sort(), ['GH_RESET_TOKEN', 'LD_RESET_TOKEN']);
  assert.throws(() => tokensFor('recreate', { GH_DEMO_TOKEN: 'x', LD_DEMO_TOKEN: 'y' }));
});
test('destructive commands require exact confirmation', () => { assert.throws(() => requireConfirmation('wrong')); assert.doesNotThrow(() => requireConfirmation(PROJECT)); });
test('failed or incomplete evidence cannot become stale or dead', () => {
  for (const evidence of [null, { complete: false, files: [] }, { complete: true, error: true, files: [] }, { complete: true, capped: true, files: [] }, { complete: true, malformed: true, files: [] }]) assert.equal(outcome(evidence), 'UNKNOWN');
  assert.equal(outcome({ complete: true, files: [] }), 'DEAD CANDIDATE');
});
test('specification constants agree with implementation constants', () => {
  const spec = fs.readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
  assert.equal(ORG, 'featureflag-extensiveconsumer-demo-org'); assert.equal(PROJECT, 'featureflag-extensiveconsumer-demo-key');
  assert.deepEqual(REPOS, ['demo-orders', 'demo-storefront', 'demo-profile']); assert.deepEqual(FLAGS, ['demo-checkout-rollout', 'demo-legacy-profile', 'demo-retired-banner']);
  for (const value of [ORG, PROJECT, ...REPOS, ...FLAGS]) assert.equal(spec.includes(value), true);
});
test('tokens never appear in redacted output or errors', () => {
  const message = redact(new Error(`failed ${env.GH_RESET_TOKEN} Authorization=${env.LD_DEMO_TOKEN}`), Object.values(env));
  for (const token of Object.values(env)) assert.equal(message.includes(token), false);
});
test('mocked HTTP responses reject an unexpected origin', async () => {
  const fetcher = async () => ({ ok: true, status: 200, url: 'https://example.invalid/response', json: async () => ({}) });
  await assert.rejects(() => request(fetcher, GH, '/user', 'not-a-real-token'), /expected official origin/);
});
