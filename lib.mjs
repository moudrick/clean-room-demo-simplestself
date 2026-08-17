import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const ORG_ENV = 'GH_ORG';
export const PROJECT_ENV = 'LD_PROJECT_KEY';
export const REPOS = ['demo-orders', 'demo-storefront', 'demo-profile'];
export const FLAGS = ['demo-checkout-rollout', 'demo-legacy-profile', 'demo-retired-banner'];
export const ENVIRONMENTS = [
  { key: 'production', name: 'Production', color: 'D9534F', critical: true },
  { key: 'staging', name: 'Staging', color: 'F0AD4E', critical: true },
  { key: 'test', name: 'Test', color: '5BC0DE', critical: false },
  { key: 'dev', name: 'Dev', color: '5CB85C', critical: false }
];
const ENVIRONMENT_KEYS = ENVIRONMENTS.map((environment) => environment.key);
export const GH = 'https://api.github.com';
export const LD = 'https://app.launchdarkly.com';
const origins = new Set([GH, LD]);
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;
const runtimeDirectory = (root) => {
  const workspace = path.resolve(root); const runtime = path.resolve(workspace, 'runtime');
  if (path.dirname(runtime) !== workspace || path.basename(runtime) !== 'runtime') throw new Error('Refusing a runtime path outside the workspace.');
  return runtime;
};

export function settingsFor(env) {
  const org = env[ORG_ENV]; const project = env[PROJECT_ENV];
  if (![org, project].every((value) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value || ''))) throw new Error('Missing or invalid GH_ORG or LD_PROJECT_KEY.');
  return { org, project };
}
export function assertScope({ org, project, repos = REPOS, flags = FLAGS, environments = ENVIRONMENT_KEYS }) {
  if (![org, project].every((value) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value || '')) || repos.length !== REPOS.length || flags.length !== FLAGS.length || environments.length !== ENVIRONMENT_KEYS.length ||
    repos.some((x) => !REPOS.includes(x)) || flags.some((x) => !FLAGS.includes(x)) || environments.some((x) => !ENVIRONMENT_KEYS.includes(x))) throw new Error('Refusing an identifier outside the fixed disposable scope.');
}
export function requireConfirmation(value, project) {
  if (value !== project) throw new Error('Destructive command requires the exact configured project key confirmation.');
}
export function tokensFor(command, env) {
  const namesByCommand = {
    audit: ['GH_DEMO_TOKEN', 'LD_DEMO_TOKEN'],
    baseline: ['GH_DEMO_TOKEN', 'LD_DEMO_TOKEN'],
    bootstrap: ['LD_RESET_TOKEN'],
    reconcile: ['GH_RESET_TOKEN', 'LD_RESET_TOKEN'],
    scenario: ['GH_DEMO_TOKEN', 'LD_DEMO_TOKEN'],
    doctor: ['GH_DEMO_TOKEN', 'GH_RESET_TOKEN', 'LD_DEMO_TOKEN', 'LD_RESET_TOKEN'],
    recreate: ['GH_RESET_TOKEN', 'LD_RESET_TOKEN'],
    refresh: ['GH_RESET_TOKEN', 'LD_RESET_TOKEN'],
    destroy: ['GH_RESET_TOKEN', 'LD_RESET_TOKEN']
  };
  const names = namesByCommand[command];
  if (!names) throw new Error('Unknown command token boundary.');
  const result = {};
  for (const name of names) { if (!env[name]) throw new Error(`Missing required environment variable: ${name}`); result[name] = env[name]; }
  return result;
}
export function detailedEventsFor(env) {
  const value = env.LD_PROBE_DETAILED_EVENTS;
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('LD_PROBE_DETAILED_EVENTS must be true or false.');
}
export const CAMPAIGN_LOCK_ENV = 'CAMPAIGN_LOCK';
export function campaignLocked(env) {
  const value = env[CAMPAIGN_LOCK_ENV];
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('CAMPAIGN_LOCK must be true or false.');
}
export function breakGlassPhrase(project) { return `BREAK CAMPAIGN LOCK ${project}`; }
export function assertCampaignUnlocked(command, env, override) {
  if (!campaignLocked(env)) return;
  const project = env[PROJECT_ENV];
  const configured = /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(project || '');
  if (configured && override !== undefined && override === breakGlassPhrase(project)) return;
  throw new Error(`Campaign lock is active: ${command} is refused. The campaign sandbox holds irreplaceable evidence; its repositories and flags are archived, never deleted. Emergency recovery only: see the emergency-recovery section of SPEC.md.`);
}
export function generationIdFor(projectId, at = new Date()) {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(projectId) || !(at instanceof Date) || Number.isNaN(at.valueOf())) throw new Error('Invalid generation input.');
  return `${projectId}-${at.toISOString().replace(/\D/g, '')}`;
}
export function redact(value, secrets = []) {
  let text = String(value?.message || value || 'request failed');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\b(token|authorization)\s*=\s*[^\s,]+/ig, '$1=[REDACTED]');
}
export function progressLine({ completed, total, label }) {
  if (!Number.isInteger(completed) || !Number.isInteger(total) || total < 1 || completed < 0 || completed > total) throw new Error('Invalid progress state.');
  const width = 20; const filled = Math.floor((completed / total) * width);
  const safeLabel = String(label || '').replace(/[\r\n]+/g, ' ').trim();
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${completed}/${total} ${safeLabel}`;
}
export function outcome(evidence, staleBefore = '2023-01-01T00:00:00.000Z') {
  if (!evidence || !evidence.complete || evidence.error || evidence.capped || evidence.malformed) return 'UNKNOWN';
  if (!Array.isArray(evidence.files)) return 'UNKNOWN';
  if (!evidence.files.length) return 'DEAD CANDIDATE';
  if (evidence.files.every((file) => file.commit && file.commit < staleBefore)) return 'STALE CANDIDATE';
  return 'REFERENCED';
}
function checkedUrl(path, base) {
  const url = new URL(path, base);
  if (!origins.has(url.origin)) throw new Error('Refusing a non-official API origin.');
  return url;
}
function responseHeader(response, name) {
  if (typeof response.headers?.get === 'function') return response.headers.get(name);
  const entry = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] == null ? null : String(entry[1]);
}
function isRateLimited(response, base, body) {
  if (response.status === 429) return true;
  if (base !== GH || response.status !== 403) return false;
  return responseHeader(response, 'retry-after') !== null || responseHeader(response, 'x-ratelimit-remaining') === '0' || /rate limit/i.test(body?.message || '');
}
export function rateLimitDelayMs(response, base, attempt, now = Date.now, random = Math.random) {
  const retryAfter = responseHeader(response, 'retry-after');
  let wait;
  if (retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())) wait = Number(retryAfter) * 1000;
  else if (retryAfter !== null && Number.isFinite(Date.parse(retryAfter))) wait = Date.parse(retryAfter) - now();
  if (wait === undefined) {
    const reset = Number(responseHeader(response, 'x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) wait = (base === GH ? reset * 1000 : reset) - now();
  }
  if (wait === undefined) wait = 60_000 * (2 ** attempt);
  return Math.max(0, Math.ceil(wait)) + Math.floor(random() * 1001);
}
export async function request(fetcher, base, path, token, options = {}, controls = {}) {
  const url = checkedUrl(path, base);
  const authorization = base === GH ? `Bearer ${token}` : token;
  const headers = { Accept: 'application/json', Authorization: authorization, ...(base === GH ? { 'X-GitHub-Api-Version': '2022-11-28' } : { 'LD-API-Version': '20240415' }), ...(options.headers || {}) };
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const sleep = controls.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = controls.now || Date.now; const random = controls.random || Math.random;
  const maxRetries = controls.maxRetries ?? MAX_RATE_LIMIT_RETRIES; const maxWaitMs = controls.maxWaitMs ?? MAX_RATE_LIMIT_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetcher(url, { ...options, headers });
    const responseOrigin = new URL(response.url || url).origin;
    if (responseOrigin !== url.origin) throw new Error('API response did not come from the expected official origin.');
    const body = await response.json().catch(() => null);
    if (response.ok) return body;
    const message = typeof body?.message === 'string' ? redact(body.message, [token]).slice(0, 300) : '';
    const error = new Error(`API request failed (${response.status})${message ? `: ${message}` : '.'}`);
    if (!isRateLimited(response, base, body) || attempt >= maxRetries) throw error;
    const delay = rateLimitDelayMs(response, base, attempt, now, random);
    if (delay > maxWaitMs) throw new Error(`API rate limited (${response.status}); required retry wait exceeds the five-minute local cap.`);
    if (!controls.onRateLimit) await sleep(delay);
    else {
      const tickMs = controls.rateLimitTickMs ?? 10_000;
      if (!Number.isFinite(tickMs) || tickMs <= 0) throw new Error('Invalid rate-limit progress interval.');
      let remainingMs = delay;
      do {
        await controls.onRateLimit({ provider: base === GH ? 'GitHub' : 'LaunchDarkly', status: response.status, retry: attempt + 1, maxRetries, remainingMs });
        const slice = Math.min(remainingMs, tickMs);
        await sleep(slice); remainingMs -= slice;
      } while (remainingMs > 0);
    }
  }
}
const gh = (fetcher, path, token, options, controls) => request(fetcher, GH, path, token, options, controls);
const ld = (fetcher, path, token, options, controls) => request(fetcher, LD, path, token, options, controls);
export async function checkGithub(fetcher, token, settings, controls) {
  const user = await gh(fetcher, '/user', token, undefined, controls); await gh(fetcher, `/orgs/${settings.org}`, token, undefined, controls);
  const repos = await gh(fetcher, `/orgs/${settings.org}/repos?per_page=100`, token, undefined, controls);
  if (!Array.isArray(repos)) throw new Error('Malformed GitHub repository evidence.');
  for (const repo of repos.filter((r) => REPOS.includes(r.name))) await gh(fetcher, `/repos/${settings.org}/${repo.name}`, token, undefined, controls);
  return user.login || 'OK';
}
export async function checkLaunchDarkly(fetcher, token, settings, requireProject = false, controls) {
  const projects = await ld(fetcher, '/api/v2/projects?limit=100', token, undefined, controls);
  if (!Array.isArray(projects.items)) throw new Error('Malformed LaunchDarkly project evidence.');
  if (!requireProject) return 'OK';
  const project = await ld(fetcher, `/api/v2/projects/${settings.project}`, token, undefined, controls);
  if (project.key !== settings.project) throw new Error('LaunchDarkly project key mismatch.');
  const flags = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, token, undefined, controls);
  if (!Array.isArray(flags.items)) throw new Error('Malformed LaunchDarkly flag evidence.');
  return 'OK';
}
export async function doctor(fetcher, env) {
  const t = tokensFor('doctor', env); const settings = settingsFor(env); assertScope({ ...settings });
  const checks = [
    ['GH_DEMO_TOKEN', 'GitHub authentication/read access', () => checkGithub(fetcher, t.GH_DEMO_TOKEN, settings)],
    ['GH_RESET_TOKEN', 'GitHub authentication/read access', () => checkGithub(fetcher, t.GH_RESET_TOKEN, settings)],
    ['LD_DEMO_TOKEN', 'LaunchDarkly authentication/project-list access', () => checkLaunchDarkly(fetcher, t.LD_DEMO_TOKEN, settings)],
    ['LD_RESET_TOKEN', 'LaunchDarkly authentication/project-list access', () => checkLaunchDarkly(fetcher, t.LD_RESET_TOKEN, settings)]
  ];
  const rows = [];
  for (const [name, checkType, check] of checks) {
    try { rows.push([name, await check()]); }
    catch (error) { throw new Error(`${name} ${checkType} failed: ${error.message}`); }
  }
  return rows;
}
export async function removeIfPresent(fetcher, base, path, token, label, controls) {
  try { await request(fetcher, base, path, token, { method: 'DELETE' }, controls); return 'deleted'; }
  catch (error) { if (/\(404\)/.test(error.message)) return 'already absent'; throw new Error(`${label} failed: ${error.message}`); }
}
export async function waitForRepositoryAbsence(fetcher, token, settings, name, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), controls) {
  const label = `GH_RESET_TOKEN wait for repository removal ${settings.org}/${name}`;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try { await gh(fetcher, `/repos/${settings.org}/${name}`, token, undefined, controls); }
    catch (error) { if (/\(404\)/.test(error.message)) return; throw new Error(`${label} failed: ${error.message}`); }
    if (attempt < 10) await sleep(1000);
  }
  throw new Error(`${label} failed: repository still exists after 10 seconds.`);
}
export async function waitForProjectAbsence(fetcher, token, settings, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), controls) {
  const label = `LD_RESET_TOKEN wait for project removal ${settings.project}`;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try { await ld(fetcher, `/api/v2/projects/${settings.project}`, token, undefined, controls); }
    catch (error) { if (/\(404\)/.test(error.message)) return; throw new Error(`${label} failed: ${error.message}`); }
    if (attempt < 10) await sleep(1000);
  }
  throw new Error(`${label} failed: project still exists after 10 seconds.`);
}
function evaluatorSource(repository, flags, release = 'v001') {
  return `import * as LaunchDarkly from '@launchdarkly/node-server-sdk';
import { batchSize, contextForOneShot, contextForTraffic, isLoadProbe, probeSummary, scheduledEvaluations } from './traffic.mjs';

const repository = '${repository}';
const release = '${release}';
const flags = ${JSON.stringify(flags)};
const profiles = ['production', 'staging', 'test', 'dev'];
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const integer = (value, minimum, maximum, label) => {
  if (!/^\\d+$/.test(String(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error(label + ' must be from ' + minimum + ' to ' + maximum + '.');
  return Number(value);
};
const environmentRate = process.env.DEMO_EVALUATIONS_PER_HOUR ? integer(process.env.DEMO_EVALUATIONS_PER_HOUR, 10, 100000, 'Evaluations per hour') : undefined;
const defaults = {
  contextKey: 'demo-user', plan: 'free', region: 'eu', cohort: 'control', cluster: undefined,
  evaluations: 10, profile: process.env.DEMO_ENVIRONMENT || 'production', intervalSeconds: 300,
  evaluationsPerHour: undefined,
  contextPoolSize: process.env.DEMO_CONTEXT_POOL_SIZE ? integer(process.env.DEMO_CONTEXT_POOL_SIZE, 1, 10000, 'Context pool size') : 1000,
  generation: process.env.DEMO_GENERATION_ID || 'untracked', traffic: false
};
let stopRequested = false; let wake; let sdkWarnings = 0; let sdkErrors = 0; let droppedEventWarnings = 0;
const logger = {
  debug: () => {}, info: () => {},
  warn: (message) => { sdkWarnings += 1; const dropped = /drop|capacity|event buffer/i.test(String(message)); if (dropped) droppedEventWarnings += 1; console.warn(JSON.stringify({ type: 'sdk-warning', repository, droppedEventRelated: dropped })); },
  error: () => { sdkErrors += 1; console.error(JSON.stringify({ type: 'sdk-error', repository })); }
};

function optionsFrom(argv) {
  const options = { ...defaults };
  const names = new Map([['--context-key', 'contextKey'], ['--plan', 'plan'], ['--region', 'region'], ['--cohort', 'cohort'], ['--cluster', 'cluster'], ['--evaluations', 'evaluations'], ['--profile', 'profile'], ['--interval-seconds', 'intervalSeconds'], ['--evaluations-per-hour', 'evaluationsPerHour'], ['--context-pool-size', 'contextPoolSize']]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--traffic') { options.traffic = true; continue; }
    const property = names.get(name); const value = argv[index + 1];
    if (!property || value === undefined) throw new Error('Unknown or incomplete argument.');
    if (property === 'intervalSeconds') options[property] = integer(value, 10, 86400, 'Interval');
    else if (property === 'evaluations') options[property] = integer(value, 1, 1000, 'Evaluations');
    else if (property === 'evaluationsPerHour') options[property] = integer(value, 10, 100000, 'Evaluations per hour');
    else if (property === 'contextPoolSize') options[property] = integer(value, 1, 10000, 'Context pool size');
    else { if (!safeIdentifier.test(value)) throw new Error('Arguments must be safe non-empty identifiers.'); options[property] = value; }
    index += 1;
  }
  if (!profiles.includes(options.profile)) throw new Error('Unknown traffic profile.');
  const probe = isLoadProbe(repository, options.profile);
  if (options.evaluationsPerHour !== undefined && (!options.traffic || !probe)) throw new Error('Evaluations per hour is available only for demo-orders Production traffic.');
  if (options.traffic && !probe && environmentRate !== undefined) throw new Error('DEMO_EVALUATIONS_PER_HOUR is available only for demo-orders Production traffic.');
  if (options.traffic && probe) options.evaluationsPerHour ??= environmentRate ?? 1200;
  return options;
}

function wait(ms) {
  return new Promise((resolve) => {
    if (stopRequested) { resolve(); return; }
    let timer; const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
    timer = setTimeout(finish, ms); wake = finish;
  });
}
async function flushOutcome(client) {
  try { await client.flush(); return 'ok'; } catch { return 'failed'; }
}
async function evaluateOne(client, flag, context) { return client.boolVariation(flag, context, false); }
async function ordinaryBatch(client, options, firstIndex, openedAt) {
  const count = batchSize(options.profile, new Date()); let attempted = 0; const perFlag = {}; const clusters = {};
  for (const flag of flags) perFlag[flag] = { true: 0, false: 0 };
  for (let item = 0; item < count && !stopRequested; item += 1) {
    const context = contextForTraffic(repository, options.profile, firstIndex + item, { generation: options.generation, contextPoolSize: options.contextPoolSize });
    for (const flag of flags) { const value = await evaluateOne(client, flag, context); perFlag[flag][String(value)] += 1; attempted += 1; }
    clusters[context.cluster.key] = (clusters[context.cluster.key] || 0) + 1;
  }
  const flush = await flushOutcome(client);
  console.log(JSON.stringify({ type: 'traffic-batch', repository, release, flags, perFlag, profile: options.profile, generation: options.generation, contexts: count, attempted, clusters, flush, connectionMs: openedAt ? Date.now() - openedAt : null }));
  if (flush !== 'ok') throw new Error('SDK flush failed.');
  return count;
}
async function probeTraffic(client, options) {
  const started = Date.now(); let attempted = 0; let errors = 0; let nextSummary = started + 60000;
  const variations = { true: 0, false: 0 }; const clusters = {};
  const emit = async (final = false) => {
    const elapsedMs = Math.max(1, Date.now() - started); const flush = await flushOutcome(client);
    console.log(JSON.stringify(probeSummary({ repository, flag: flags[0], generation: options.generation, requestedRate: options.evaluationsPerHour, attempted, elapsedMs, variations, clusters, contextPoolSize: options.contextPoolSize, errors, sdkWarnings, sdkErrors, droppedEventWarnings, flush, final })));
    if (flush !== 'ok') throw new Error('SDK flush failed.');
  };
  while (!stopRequested) {
    const elapsedMs = Date.now() - started; const target = scheduledEvaluations(options.evaluationsPerHour, elapsedMs);
    while (attempted < target && !stopRequested) {
      const context = contextForTraffic(repository, options.profile, attempted, { generation: options.generation, contextPoolSize: options.contextPoolSize });
      try { const value = await evaluateOne(client, flags[0], context); variations[String(value)] += 1; } catch { errors += 1; }
      clusters[context.cluster.key] = (clusters[context.cluster.key] || 0) + 1; attempted += 1;
    }
    const now = Date.now();
    if (now >= nextSummary) { await emit(); while (nextSummary <= now) nextSummary += 60000; }
    if (!stopRequested) await wait(Math.min(1000, Math.max(1, nextSummary - Date.now())));
  }
  await emit(true);
}

async function main() {
  const sdkKey = process.env.LD_EVALUATION_SDK_KEY;
  if (!sdkKey) throw new Error('LD_EVALUATION_SDK_KEY is required.');
  const options = optionsFrom(process.argv.slice(2)); const probe = options.traffic && isLoadProbe(repository, options.profile);
  const connect = () => LaunchDarkly.init(sdkKey, {
    capacity: 10000, flushInterval: 5, enableEventCompression: true,
    contextKeysCapacity: Math.min(options.contextPoolSize, 10000), contextKeysFlushInterval: 300, logger,
    application: { id: repository, name: repository, version: release, versionName: probe ? 'production-load-probe' : 'standard-traffic' }
  });
  const stop = () => { stopRequested = true; if (wake) wake(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (!options.traffic) {
      const client = connect();
      try {
        await client.waitForInitialization({ timeout: 10 });
        for (let index = 0; index < options.evaluations; index += 1) {
          const context = contextForOneShot(repository, options, index);
          for (const flag of flags) console.log(JSON.stringify({ repository, release, flag, value: await evaluateOne(client, flag, context), context }));
        }
      } finally { await client.flush(); await client.close(); }
    } else if (probe) {
      // The bounded rate probe keeps one sustained connection on purpose: its
      // evaluations-per-hour figure only means anything if pacing stays continuous.
      const client = connect();
      try { await client.waitForInitialization({ timeout: 10 }); await probeTraffic(client, options); }
      finally { await client.flush(); await client.close(); }
    } else {
      // Ordinary traffic connects only for the duration of each batch. LaunchDarkly
      // meters average concurrent service connections, so a client held open between
      // batches would cost a full connection while evaluating nothing.
      let index = 0;
      while (!stopRequested) {
        const openedAt = Date.now(); const client = connect();
        try {
          await client.waitForInitialization({ timeout: 10 });
          index += await ordinaryBatch(client, options, index, openedAt);
        } finally { await client.flush(); await client.close(); }
        if (!stopRequested) await wait(options.intervalSeconds * 1000);
      }
    }
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch(() => { console.error('Error: evaluator failed.'); process.exitCode = 1; });
`;
}
export const DEFAULT_CLUSTER_TOPOLOGY = {
  production: [
    { key: 'prod-eu-west-01', name: 'Production EU West 01', environment: 'production', region: 'eu-west', ordinal: 1, releaseRing: 'stable', weight: 50 },
    { key: 'prod-emea-central-04', name: 'Production EMEA Central 04', environment: 'production', region: 'emea-central', ordinal: 4, releaseRing: 'canary', weight: 30 },
    { key: 'prod-sa-east-02', name: 'Production South America East 02', environment: 'production', region: 'sa-east', ordinal: 2, releaseRing: 'stable', weight: 20 }
  ],
  staging: [
    { key: 'stg-eu-central-01', name: 'Staging EU Central 01', environment: 'staging', region: 'eu-central', ordinal: 1, releaseRing: 'canary', weight: 60 },
    { key: 'stg-eu-central-02', name: 'Staging EU Central 02', environment: 'staging', region: 'eu-central', ordinal: 2, releaseRing: 'stable', weight: 40 }
  ],
  test: [
    { key: 'test-eu-central-01', name: 'Test EU Central 01', environment: 'test', region: 'eu-central', ordinal: 1, releaseRing: 'canary', weight: 75 },
    { key: 'test-eu-central-02', name: 'Test EU Central 02', environment: 'test', region: 'eu-central', ordinal: 2, releaseRing: 'stable', weight: 25 }
  ],
  dev: [{ key: 'dev-local-01', name: 'Development Local 01', environment: 'dev', region: 'local', ordinal: 1, releaseRing: 'stable', weight: 100 }]
};
export function clusterTopologyFor(environments) {
  return Object.fromEntries(environments.map((environment) => [environment.key,
    [...environment.clusters].sort((a, b) => a.rolloutOrder - b.rolloutOrder).map((cluster) => ({
      key: cluster.key, name: cluster.name, environment: environment.key, region: cluster.region,
      ordinal: cluster.ordinal, releaseRing: cluster.releaseRing, weight: cluster.weight
    }))]));
}
function trafficSource(topology = DEFAULT_CLUSTER_TOPOLOGY) {
  return `const profiles = {
  production: { enterprise: 10, beta: 15, legacy: 8, busy: 100, quiet: 40 },
  staging: { enterprise: 20, beta: 30, legacy: 20, busy: 30, quiet: 12 },
  test: { enterprise: 30, beta: 35, legacy: 30, busy: 10, quiet: 4 },
  dev: { enterprise: 15, beta: 25, legacy: 12, busy: 2, quiet: 1 }
};
export const clusters = ${JSON.stringify(topology, null, 2)};
const offsets = { 'demo-orders': 11, 'demo-storefront': 43, 'demo-profile': 71 };
const clusterKey = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const knownService = (repository) => typeof repository === 'string' && clusterKey.test(repository);
const offsetFor = (repository) => {
  if (Object.hasOwn(offsets, repository)) return offsets[repository];
  let hash = 7;
  for (let index = 0; index < repository.length; index += 1) hash = (hash * 31 + repository.charCodeAt(index)) % 100;
  return hash;
};

export function isLoadProbe(repository, profile) { return repository === 'demo-orders' && profile === 'production'; }
export function clusterFor(repository, profile, index) {
  const choices = clusters[profile];
  if (!choices || !knownService(repository) || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid cluster input.');
  const bucket = (index * 17 + offsetFor(repository)) % 100; let boundary = 0;
  const selected = choices.find((item) => { boundary += item.weight; return bucket < boundary; });
  if (!selected || !clusterKey.test(selected.key)) throw new Error('Invalid cluster configuration.');
  const { weight, ...context } = selected; return context;
}
function multiContext(repository, user, cluster, generation) {
  return { kind: 'multi', user, service: { key: repository, name: repository }, cluster: { ...cluster, generation } };
}
export function contextForOneShot(repository, options, index) {
  if (!knownService(repository) || !Number.isSafeInteger(options?.evaluations) || options.evaluations < 1 || !Number.isSafeInteger(index) || index < 0 || index >= options.evaluations) throw new Error('Invalid one-shot input.');
  const choices = clusters[options.profile]; const selected = choices?.find((item) => item.key === (options.cluster || choices[0].key));
  if (!selected) throw new Error('Cluster does not belong to the selected environment.');
  const { weight, ...cluster } = selected;
  const key = options.evaluations === 1 ? options.contextKey : options.contextKey + '-' + String(index + 1).padStart(3, '0');
  return multiContext(repository, { key, plan: options.plan, region: options.region, cohort: options.cohort }, cluster, options.generation || 'untracked');
}
export function contextForTraffic(repository, profile, index, options = {}) {
  const settings = profiles[profile]; const contextPoolSize = options.contextPoolSize ?? 10000;
  if (!settings || !knownService(repository) || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(contextPoolSize) || contextPoolSize < 1 || contextPoolSize > 10000) throw new Error('Invalid traffic input.');
  const bucket = (index * 37 + offsetFor(repository)) % 100;
  const user = { key: [repository, profile, index % contextPoolSize].join('-'), plan: 'free', region: 'eu', cohort: 'control' };
  if (repository === 'demo-profile') { if (bucket < settings.legacy) user.region = 'legacy'; }
  else if (bucket < settings.enterprise) user.plan = 'enterprise';
  else if (bucket < settings.enterprise + settings.beta) user.cohort = 'checkout-beta';
  return multiContext(repository, user, clusterFor(repository, profile, index), options.generation || 'untracked');
}
export function scheduledEvaluations(rate, elapsedMs) {
  if (!Number.isSafeInteger(rate) || rate < 10 || rate > 100000 || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error('Invalid probe schedule input.');
  return Math.floor((rate * elapsedMs) / 3600000);
}
export function probeSummary(input) {
  const elapsedHours = input.elapsedMs / 3600000;
  return { type: 'load-probe-summary', repository: input.repository, service: input.repository, flag: input.flag, profile: 'production', generation: input.generation, requestedEvaluationsPerHour: input.requestedRate, attempted: input.attempted, elapsedSeconds: Number((input.elapsedMs / 1000).toFixed(3)), achievedEvaluationsPerHour: elapsedHours > 0 ? Number((input.attempted / elapsedHours).toFixed(2)) : 0, variations: input.variations, clusters: input.clusters, contextPoolSize: input.contextPoolSize, errors: input.errors, sdkWarnings: input.sdkWarnings || 0, sdkErrors: input.sdkErrors || 0, droppedEventWarnings: input.droppedEventWarnings || 0, flush: input.flush, final: Boolean(input.final) };
}
export function batchSize(profile, at) {
  const settings = profiles[profile];
  if (!settings || !(at instanceof Date) || Number.isNaN(at.valueOf())) throw new Error('Invalid traffic schedule input.');
  const day = at.getUTCDay(); const hour = at.getUTCHours(); const businessHours = day >= 1 && day <= 5 && hour >= 7 && hour < 19;
  return businessHours ? settings.busy : settings.quiet;
}
`;
}
function repositoryFiles(repository, flags, release = 'v001', topology = DEFAULT_CLUSTER_TOPOLOGY) {
  return [
    { path: 'package.json', content: `${JSON.stringify({ name: repository, private: true, type: 'module', scripts: { evaluate: 'node app.mjs', traffic: 'node app.mjs --traffic' }, dependencies: { '@launchdarkly/node-server-sdk': '^9.0.0' } }, null, 2)}\n` },
    { path: 'app.mjs', content: evaluatorSource(repository, flags, release) },
    { path: 'traffic.mjs', content: trafficSource(topology) },
    { path: 'Dockerfile', content: "FROM node:24-alpine\nENV NPM_CONFIG_UPDATE_NOTIFIER=false\nWORKDIR /app\nCOPY package.json ./\nRUN npm install --omit=dev\nCOPY app.mjs traffic.mjs ./\nUSER node\nCMD [\"npm\", \"run\", \"traffic\"]\n" },
    { path: '.gitignore', content: 'node_modules/\n.env\n' },
    { path: 'README.md', content: `# ${repository} synthetic evaluator\n\nRun \`npm install\`, set \`LD_EVALUATION_SDK_KEY\`, then use \`npm run evaluate -- --cohort checkout-beta --cluster prod-eu-west-01\` for a ten-evaluation one-shot batch or \`npm run traffic -- --profile production\` for cumulative traffic. One-shot count can be changed with \`--evaluations\`; \`--cluster\` selects a fixed synthetic cluster. Only demo-orders Production accepts \`--evaluations-per-hour 10..100000\` and \`--context-pool-size 1..10000\`. Stop traffic with Ctrl+C so pending events flush.\n` }
  ];
}
const PROFILE_TABLE = {
  production: { enterprise: 10, beta: 15, legacy: 8, busy: 100, quiet: 40 },
  staging: { enterprise: 20, beta: 30, legacy: 20, busy: 30, quiet: 12 },
  test: { enterprise: 30, beta: 35, legacy: 30, busy: 10, quiet: 4 },
  dev: { enterprise: 15, beta: 25, legacy: 12, busy: 2, quiet: 1 }
};
const KNOWN_OFFSETS = { 'demo-orders': 11, 'demo-storefront': 43, 'demo-profile': 71 };
// Every template reproduces the same cluster weighting, context shape and batch sizing as Node.
// The shape must match exactly or LaunchDarkly sees inconsistent contexts across languages.
function typescriptFiles(repository, flags, release, topology) {
  const app = `import * as LaunchDarkly from '@launchdarkly/node-server-sdk';
import { batchSize, contextForTraffic, type Multi } from './traffic.ts';

const repository = '${repository}';
const release = '${release}';
const flags: string[] = ${JSON.stringify(flags)};

let stopRequested = false;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const profile = (() => {
  const index = process.argv.indexOf('--profile');
  const value = index > 0 ? process.argv[index + 1] : process.env.DEMO_ENVIRONMENT;
  if (!value || !['production', 'staging', 'test', 'dev'].includes(value)) throw new Error('A valid --profile is required.');
  return value;
})();

async function batch(client: LaunchDarkly.LDClient, firstIndex: number, openedAt: number): Promise<number> {
  const count = batchSize(profile, new Date());
  const perFlag: Record<string, { true: number; false: number }> = {};
  const clusters: Record<string, number> = {};
  for (const flag of flags) perFlag[flag] = { true: 0, false: 0 };
  let attempted = 0;
  for (let item = 0; item < count && !stopRequested; item += 1) {
    const context: Multi = contextForTraffic(repository, profile, firstIndex + item, process.env.DEMO_GENERATION_ID || 'untracked');
    for (const flag of flags) {
      const value = await client.boolVariation(flag, context as never, false);
      perFlag[flag][value ? 'true' : 'false'] += 1;
      attempted += 1;
    }
    clusters[context.cluster.key] = (clusters[context.cluster.key] || 0) + 1;
  }
  let flush = 'ok';
  try { await client.flush(); } catch { flush = 'failed'; }
  console.log(JSON.stringify({ type: 'traffic-batch', repository, release, flags, perFlag, profile, generation: process.env.DEMO_GENERATION_ID || 'untracked', contexts: count, attempted, clusters, flush, connectionMs: Date.now() - openedAt }));
  if (flush !== 'ok') throw new Error('SDK flush failed.');
  return count;
}

async function main(): Promise<void> {
  const sdkKey = process.env.LD_EVALUATION_SDK_KEY;
  if (!sdkKey) throw new Error('LD_EVALUATION_SDK_KEY is required.');
  const stop = () => { stopRequested = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let index = 0;
  while (!stopRequested) {
    const openedAt = Date.now();
    const client = LaunchDarkly.init(sdkKey, {
      capacity: 10000, flushInterval: 5,
      application: { id: repository, name: repository, version: release }
    });
    try {
      await client.waitForInitialization({ timeout: 10 });
      index += await batch(client, index, openedAt);
    } finally { await client.close(); }
    if (!stopRequested) await wait(300000);
  }
}

main().catch((error: unknown) => { console.error('Error: evaluator failed.', error instanceof Error ? error.message : ''); process.exitCode = 1; });
`;
  const traffic = `export type Cluster = { key: string; name: string; environment: string; region: string; ordinal: number; releaseRing: string; weight: number };
export type Multi = { kind: 'multi'; user: Record<string, string>; service: { key: string; name: string }; cluster: Cluster & { generation: string } };

const profiles: Record<string, { enterprise: number; beta: number; legacy: number; busy: number; quiet: number }> = ${JSON.stringify(PROFILE_TABLE, null, 2)};
export const clusters: Record<string, Cluster[]> = ${JSON.stringify(topology, null, 2)};
const offsets: Record<string, number> = ${JSON.stringify(KNOWN_OFFSETS)};

function offsetFor(repository: string): number {
  if (Object.hasOwn(offsets, repository)) return offsets[repository];
  let hash = 7;
  for (let index = 0; index < repository.length; index += 1) hash = (hash * 31 + repository.charCodeAt(index)) % 100;
  return hash;
}

export function batchSize(profile: string, at: Date): number {
  const settings = profiles[profile];
  if (!settings) throw new Error('Invalid traffic schedule input.');
  const day = at.getUTCDay(); const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 7 && hour < 19 ? settings.busy : settings.quiet;
}

export function clusterFor(repository: string, profile: string, index: number): Cluster {
  const choices = clusters[profile];
  if (!choices) throw new Error('Invalid cluster input.');
  const bucket = (index * 17 + offsetFor(repository)) % 100;
  let boundary = 0;
  const selected = choices.find((item) => { boundary += item.weight; return bucket < boundary; });
  if (!selected) throw new Error('Invalid cluster configuration.');
  return selected;
}

export function contextForTraffic(repository: string, profile: string, index: number, generation: string): Multi {
  const settings = profiles[profile];
  if (!settings) throw new Error('Invalid traffic input.');
  const bucket = (index * 37 + offsetFor(repository)) % 100;
  const user: Record<string, string> = { key: [repository, profile, index % 1000].join('-'), plan: 'free', region: 'eu', cohort: 'control' };
  if (bucket < settings.enterprise) user.plan = 'enterprise';
  else if (bucket < settings.enterprise + settings.beta) user.cohort = 'checkout-beta';
  return { kind: 'multi', user, service: { key: repository, name: repository }, cluster: { ...clusterFor(repository, profile, index), generation } };
}
`;
  return [
    { path: 'package.json', content: `${JSON.stringify({ name: repository, private: true, type: 'module', scripts: { traffic: 'node app.ts', typecheck: 'tsc --noEmit' }, dependencies: { '@launchdarkly/node-server-sdk': '^9.0.0' }, devDependencies: { typescript: '^5.6.0', '@types/node': '^24.0.0' } }, null, 2)}\n` },
    { path: 'tsconfig.json', content: `${JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, allowImportingTsExtensions: true, types: ['node'] }, include: ['*.ts'] }, null, 2)}\n` },
    { path: 'app.ts', content: app },
    { path: 'traffic.ts', content: traffic },
    { path: 'Dockerfile', content: 'FROM node:24-alpine\nENV NPM_CONFIG_UPDATE_NOTIFIER=false\nWORKDIR /app\nCOPY package.json ./\nRUN npm install --omit=dev\nCOPY app.ts traffic.ts ./\nUSER node\nCMD ["node", "app.ts"]\n' },
    { path: '.gitignore', content: 'node_modules/\n.env\n' },
    { path: 'README.md', content: `# ${repository} synthetic evaluator (TypeScript)\n\nTypeScript source run directly by Node's native type stripping, so there is no build step. Set \`LD_EVALUATION_SDK_KEY\` and \`DEMO_ENVIRONMENT\`, then \`npm run traffic -- --profile staging\`. \`npm run typecheck\` runs \`tsc --noEmit\`.\n` }
  ];
}
function goFiles(repository, flags, release, topology, org) {
  const main = `package main

import (
\t"encoding/json"
\t"fmt"
\t"os"
\t"os/signal"
\t"syscall"
\t"time"

\t"github.com/launchdarkly/go-sdk-common/v3/ldcontext"
\t"github.com/launchdarkly/go-sdk-common/v3/ldvalue"
\tld "github.com/launchdarkly/go-server-sdk/v7"
\t"github.com/launchdarkly/go-server-sdk/v7/interfaces"
)

const repository = "${repository}"
const release = "${release}"

var flags = []string{${flags.map((flag) => `"${flag}"`).join(', ')}}

const topologyJSON = \`${JSON.stringify(topology)}\`
const profilesJSON = \`${JSON.stringify(PROFILE_TABLE)}\`
const offsetsJSON = \`${JSON.stringify(KNOWN_OFFSETS)}\`

type cluster struct {
\tKey         string \`json:"key"\`
\tName        string \`json:"name"\`
\tEnvironment string \`json:"environment"\`
\tRegion      string \`json:"region"\`
\tOrdinal     int    \`json:"ordinal"\`
\tReleaseRing string \`json:"releaseRing"\`
\tWeight      int    \`json:"weight"\`
}

type profile struct {
\tEnterprise int \`json:"enterprise"\`
\tBeta       int \`json:"beta"\`
\tLegacy     int \`json:"legacy"\`
\tBusy       int \`json:"busy"\`
\tQuiet      int \`json:"quiet"\`
}

var clusters map[string][]cluster
var profiles map[string]profile
var offsets map[string]int

func offsetFor(name string) int {
\tif value, ok := offsets[name]; ok {
\t\treturn value
\t}
\thash := 7
\tfor _, char := range name {
\t\thash = (hash*31 + int(char)) % 100
\t}
\treturn hash
}

func batchSize(name string, at time.Time) int {
\tsettings := profiles[name]
\tday := int(at.UTC().Weekday())
\thour := at.UTC().Hour()
\tif day >= 1 && day <= 5 && hour >= 7 && hour < 19 {
\t\treturn settings.Busy
\t}
\treturn settings.Quiet
}

func clusterFor(name string, env string, index int) cluster {
\tchoices := clusters[env]
\tbucket := (index*17 + offsetFor(name)) % 100
\tboundary := 0
\tfor _, item := range choices {
\t\tboundary += item.Weight
\t\tif bucket < boundary {
\t\t\treturn item
\t\t}
\t}
\treturn choices[len(choices)-1]
}

func contextForTraffic(name string, env string, index int, generation string) ldcontext.Context {
\tsettings := profiles[env]
\tbucket := (index*37 + offsetFor(name)) % 100
\tplan, region, cohort := "free", "eu", "control"
\tif bucket < settings.Enterprise {
\t\tplan = "enterprise"
\t} else if bucket < settings.Enterprise+settings.Beta {
\t\tcohort = "checkout-beta"
\t}
\tuser := ldcontext.NewBuilder(fmt.Sprintf("%s-%s-%d", name, env, index%1000)).Kind("user").
\t\tSetString("plan", plan).SetString("region", region).SetString("cohort", cohort).Build()
\tselected := clusterFor(name, env, index)
\tservice := ldcontext.NewBuilder(name).Kind("service").SetString("name", name).Build()
\tclusterContext := ldcontext.NewBuilder(selected.Key).Kind("cluster").
\t\tSetString("name", selected.Name).SetString("environment", selected.Environment).
\t\tSetString("region", selected.Region).SetValue("ordinal", ldvalue.Int(selected.Ordinal)).
\t\tSetString("releaseRing", selected.ReleaseRing).SetString("generation", generation).Build()
\treturn ldcontext.NewMulti(user, service, clusterContext)
}

func main() {
\tif err := json.Unmarshal([]byte(topologyJSON), &clusters); err != nil {
\t\tpanic(err)
\t}
\tif err := json.Unmarshal([]byte(profilesJSON), &profiles); err != nil {
\t\tpanic(err)
\t}
\tif err := json.Unmarshal([]byte(offsetsJSON), &offsets); err != nil {
\t\tpanic(err)
\t}
\tsdkKey := os.Getenv("LD_EVALUATION_SDK_KEY")
\tif sdkKey == "" {
\t\tfmt.Fprintln(os.Stderr, "LD_EVALUATION_SDK_KEY is required.")
\t\tos.Exit(1)
\t}
\tenv := os.Getenv("DEMO_ENVIRONMENT")
\tfor position, argument := range os.Args {
\t\tif argument == "--profile" && position+1 < len(os.Args) {
\t\t\tenv = os.Args[position+1]
\t\t}
\t}
\tif _, ok := profiles[env]; !ok {
\t\tfmt.Fprintln(os.Stderr, "A valid --profile is required.")
\t\tos.Exit(1)
\t}
\tgeneration := os.Getenv("DEMO_GENERATION_ID")
\tif generation == "" {
\t\tgeneration = "untracked"
\t}
\tstop := make(chan os.Signal, 1)
\tsignal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
\tindex := 0
\tfor {
\t\tselect {
\t\tcase <-stop:
\t\t\treturn
\t\tdefault:
\t\t}
\t\topenedAt := time.Now()
\t\tconfig := ld.Config{ApplicationInfo: interfaces.ApplicationInfo{ApplicationID: repository, ApplicationVersion: release}}
\t\tclient, err := ld.MakeCustomClient(sdkKey, config, 10*time.Second)
\t\tif err != nil {
\t\t\tfmt.Fprintln(os.Stderr, "Error: evaluator failed.")
\t\t\tos.Exit(1)
\t\t}
\t\tcount := batchSize(env, time.Now())
\t\tperFlag := map[string]map[string]int{}
\t\tclusterCounts := map[string]int{}
\t\tfor _, flag := range flags {
\t\t\tperFlag[flag] = map[string]int{"true": 0, "false": 0}
\t\t}
\t\tattempted := 0
\t\tfor item := 0; item < count; item++ {
\t\t\tevaluationContext := contextForTraffic(repository, env, index+item, generation)
\t\t\tfor _, flag := range flags {
\t\t\t\tvalue, _ := client.BoolVariation(flag, evaluationContext, false)
\t\t\t\tif value {
\t\t\t\t\tperFlag[flag]["true"]++
\t\t\t\t} else {
\t\t\t\t\tperFlag[flag]["false"]++
\t\t\t\t}
\t\t\t\tattempted++
\t\t\t}
\t\t\tclusterCounts[clusterFor(repository, env, index+item).Key]++
\t\t}
\t\tflush := "ok"
\t\tif !client.FlushAndWait(5 * time.Second) {
\t\t\tflush = "failed"
\t\t}
\t\tsummary := map[string]interface{}{
\t\t\t"type": "traffic-batch", "repository": repository, "release": release,
\t\t\t"flags": flags, "perFlag": perFlag, "profile": env, "generation": generation,
\t\t\t"contexts": count, "attempted": attempted, "clusters": clusterCounts,
\t\t\t"flush": flush, "connectionMs": time.Since(openedAt).Milliseconds(),
\t\t}
\t\tline, _ := json.Marshal(summary)
\t\tfmt.Println(string(line))
\t\tclient.Close()
\t\tindex += count
\t\tselect {
\t\tcase <-stop:
\t\t\treturn
\t\tcase <-time.After(300 * time.Second):
\t\t}
\t}
}
`;
  return [
    { path: 'go.mod', content: `module github.com/${org}/${repository}\n\ngo 1.23\n\nrequire (\n\tgithub.com/launchdarkly/go-sdk-common/v3 v3.1.0\n\tgithub.com/launchdarkly/go-server-sdk/v7 v7.6.1\n)\n` },
    { path: 'main.go', content: main },
    { path: 'Dockerfile', content: 'FROM golang:1.23-alpine AS build\nWORKDIR /src\nCOPY go.mod ./\nCOPY main.go ./\nRUN go mod tidy && CGO_ENABLED=0 go build -o /out/evaluator .\n\nFROM alpine:3.20\nRUN adduser -D -u 10001 evaluator\nCOPY --from=build /out/evaluator /app/evaluator\nUSER evaluator\nENTRYPOINT ["/app/evaluator"]\n' },
    { path: '.gitignore', content: 'evaluator\n.env\n' },
    { path: 'README.md', content: `# ${repository} synthetic evaluator (Go)\n\nSet \`LD_EVALUATION_SDK_KEY\` and \`DEMO_ENVIRONMENT\`, then \`go run . --profile staging\`. Each batch opens a client, evaluates every flag the release owns, flushes and closes.\n` }
  ];
}
function pythonFiles(repository, flags, release, topology) {
  const app = `import json
import os
import signal
import sys
import time
from datetime import datetime, timezone

import ldclient
from ldclient.config import Config
from ldclient.context import Context

REPOSITORY = "${repository}"
RELEASE = "${release}"
FLAGS = [${flags.map((flag) => `"${flag}"`).join(', ')}]

CLUSTERS = json.loads(r'''${JSON.stringify(topology)}''')
PROFILES = json.loads(r'''${JSON.stringify(PROFILE_TABLE)}''')
OFFSETS = json.loads(r'''${JSON.stringify(KNOWN_OFFSETS)}''')

stop_requested = False


def request_stop(_signum, _frame):
    global stop_requested
    stop_requested = True


def offset_for(name):
    if name in OFFSETS:
        return OFFSETS[name]
    value = 7
    for char in name:
        value = (value * 31 + ord(char)) % 100
    return value


def batch_size(profile, at):
    settings = PROFILES[profile]
    business = at.weekday() <= 4 and 7 <= at.hour < 19
    return settings["busy"] if business else settings["quiet"]


def cluster_for(name, environment, index):
    choices = CLUSTERS[environment]
    bucket = (index * 17 + offset_for(name)) % 100
    boundary = 0
    for item in choices:
        boundary += item["weight"]
        if bucket < boundary:
            return item
    return choices[-1]


def context_for_traffic(name, environment, index, generation):
    settings = PROFILES[environment]
    bucket = (index * 37 + offset_for(name)) % 100
    plan, region, cohort = "free", "eu", "control"
    if bucket < settings["enterprise"]:
        plan = "enterprise"
    elif bucket < settings["enterprise"] + settings["beta"]:
        cohort = "checkout-beta"
    user = (Context.builder("%s-%s-%d" % (name, environment, index % 1000)).kind("user")
            .set("plan", plan).set("region", region).set("cohort", cohort).build())
    selected = cluster_for(name, environment, index)
    service = Context.builder(name).kind("service").set("name", name).build()
    cluster = (Context.builder(selected["key"]).kind("cluster")
               .set("name", selected["name"]).set("environment", selected["environment"])
               .set("region", selected["region"]).set("ordinal", selected["ordinal"])
               .set("releaseRing", selected["releaseRing"]).set("generation", generation).build())
    return Context.create_multi(user, service, cluster)


def main():
    sdk_key = os.environ.get("LD_EVALUATION_SDK_KEY")
    if not sdk_key:
        print("LD_EVALUATION_SDK_KEY is required.", file=sys.stderr)
        sys.exit(1)
    environment = os.environ.get("DEMO_ENVIRONMENT")
    if "--profile" in sys.argv:
        environment = sys.argv[sys.argv.index("--profile") + 1]
    if environment not in PROFILES:
        print("A valid --profile is required.", file=sys.stderr)
        sys.exit(1)
    generation = os.environ.get("DEMO_GENERATION_ID", "untracked")
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    index = 0
    while not stop_requested:
        opened_at = time.time()
        ldclient.set_config(Config(sdk_key, application={"id": REPOSITORY, "version": RELEASE}))
        client = ldclient.get()
        count = batch_size(environment, datetime.now(timezone.utc))
        per_flag = {flag: {"true": 0, "false": 0} for flag in FLAGS}
        clusters = {}
        attempted = 0
        for item in range(count):
            context = context_for_traffic(REPOSITORY, environment, index + item, generation)
            for flag in FLAGS:
                value = client.variation(flag, context, False)
                per_flag[flag]["true" if value else "false"] += 1
                attempted += 1
            key = cluster_for(REPOSITORY, environment, index + item)["key"]
            clusters[key] = clusters.get(key, 0) + 1
        client.flush()
        print(json.dumps({
            "type": "traffic-batch", "repository": REPOSITORY, "release": RELEASE,
            "flags": FLAGS, "perFlag": per_flag, "profile": environment,
            "generation": generation, "contexts": count, "attempted": attempted,
            "clusters": clusters, "flush": "ok",
            "connectionMs": int((time.time() - opened_at) * 1000),
        }), flush=True)
        client.close()
        index += count
        for _ in range(300):
            if stop_requested:
                break
            time.sleep(1)


if __name__ == "__main__":
    main()
`;
  return [
    { path: 'requirements.txt', content: 'launchdarkly-server-sdk==9.8.0\n' },
    { path: 'app.py', content: app },
    { path: 'Dockerfile', content: 'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY app.py ./\nRUN useradd -u 10001 -m evaluator\nUSER evaluator\nCMD ["python", "-u", "app.py"]\n' },
    { path: '.gitignore', content: '__pycache__/\n.env\n' },
    { path: 'README.md', content: `# ${repository} synthetic evaluator (Python)\n\nSet \`LD_EVALUATION_SDK_KEY\` and \`DEMO_ENVIRONMENT\`, then \`python app.py --profile staging\`. Each batch opens a client, evaluates every flag the release owns, flushes and closes.\n` }
  ];
}
export const SOURCES = {
  'demo-orders': { files: repositoryFiles('demo-orders', ['demo-checkout-rollout']), date: null },
  'demo-storefront': { files: repositoryFiles('demo-storefront', ['demo-checkout-rollout']), date: null },
  'demo-profile': { files: repositoryFiles('demo-profile', ['demo-legacy-profile']), date: '2020-01-02T03:04:05Z' }
};
export async function createRepositoryWithSource(fetcher, token, settings, name, source, controls) {
  assertScope({ ...settings, repos: [name, ...REPOS.filter((x) => x !== name)] });
  return commitInitialSource(fetcher, token, settings, name, source, controls);
}
async function commitInitialSource(fetcher, token, settings, name, source, controls) {
  const repository = await gh(fetcher, `/orgs/${settings.org}/repos`, token, { method: 'POST', body: JSON.stringify({ name, private: false, auto_init: true, description: 'Synthetic feature-flag clean-room demo.' }) }, controls);
  const branch = repository.default_branch;
  if (!branch) throw new Error('Created repository has no default branch.');
  const ref = await gh(fetcher, `/repos/${settings.org}/${name}/git/ref/heads/${encodeURIComponent(branch)}`, token, undefined, controls);
  const parentSha = ref.object?.sha;
  if (!parentSha) throw new Error('Created repository has no initial commit reference.');
  const parent = await gh(fetcher, `/repos/${settings.org}/${name}/git/commits/${parentSha}`, token, undefined, controls);
  if (!parent.tree?.sha) throw new Error('Created repository has incomplete initial commit evidence.');
  if (!Array.isArray(source.files) || !source.files.length) throw new Error('Synthetic source files are missing.');
  const entries = [];
  for (const file of source.files) {
    const blob = await gh(fetcher, `/repos/${settings.org}/${name}/git/blobs`, token, { method: 'POST', body: JSON.stringify({ content: file.content, encoding: 'utf-8' }) }, controls);
    if (!file.path || !blob.sha) throw new Error('Synthetic source blob is incomplete.');
    entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await gh(fetcher, `/repos/${settings.org}/${name}/git/trees`, token, { method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries }) }, controls);
  const stamp = source.date || new Date().toISOString();
  const who = { name: 'Synthetic Demo', email: 'synthetic-demo@example.invalid', date: stamp };
  const commit = await gh(fetcher, `/repos/${settings.org}/${name}/git/commits`, token, { method: 'POST', body: JSON.stringify({ message: 'Add synthetic feature-flag evidence', tree: tree.sha, parents: [parentSha], author: who, committer: who }) }, controls);
  await gh(fetcher, `/repos/${settings.org}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, token, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) }, controls);
  return { repositoryId: repository.id ?? null, nodeId: repository.node_id ?? null, branch, commitSha: commit.sha };
}
function variationId(flag, value) {
  const variation = flag?.variations?.find((entry) => entry.value === value);
  if (!variation?._id) throw new Error(`Created flag ${flag?.key || 'unknown'} has no ${value} variation ID.`);
  return variation._id;
}
function rule(contextKind, attribute, value, variationId) {
  return { clauses: [{ contextKind, attribute, op: 'in', negate: false, values: [value] }], variationId };
}
export async function createProject(fetcher, token, settings, controls) {
  assertScope(settings);
  const project = await ld(fetcher, '/api/v2/projects', token, { method: 'POST', body: JSON.stringify({ key: settings.project, name: 'Synthetic feature-flag clean-room demo', environments: ENVIRONMENTS }) }, controls);
  if (project.key !== settings.project || typeof project._id !== 'string' || !project._id) throw new Error('Created LaunchDarkly project identity mismatch.');
  const environments = await ld(fetcher, `/api/v2/projects/${settings.project}/environments?limit=100`, token, undefined, controls);
  if (!Array.isArray(environments.items) || environments.items.length !== ENVIRONMENT_KEYS.length || environments.items.some((environment) => {
    const expected = ENVIRONMENTS.find((item) => item.key === environment.key);
    return !expected || environment.critical !== expected.critical;
  })) throw new Error('Created LaunchDarkly environments do not match the fixed demo scope and criticality.');
  return { project, environments: environments.items, projectId: project._id };
}
export async function prepareRuntime(settings, environments, generation, controls = {}) {
  assertScope(settings);
  if (!Array.isArray(environments) || environments.length !== ENVIRONMENT_KEYS.length || environments.some((environment) => !ENVIRONMENT_KEYS.includes(environment.key) || typeof environment.apiKey !== 'string' || !environment.apiKey || /[\r\n]/.test(environment.apiKey))) throw new Error('LaunchDarkly SDK key evidence does not match the fixed runtime scope.');
  if (typeof generation !== 'string' || !/^[A-Za-z0-9_-]+$/.test(generation)) throw new Error('LaunchDarkly project generation evidence is missing.');
  const fileSystem = controls.fileSystem || fs; const root = controls.root || process.cwd(); const runtime = runtimeDirectory(root); const repos = path.join(runtime, 'repos');
  const keyFile = path.join(runtime, 'sdk-keys.env');
  const clone = controls.clone || (async (url, target) => execFileAsync('git', ['clone', '--depth', '1', url, target], { cwd: root, windowsHide: true }));
  fileSystem.rmSync(repos, { recursive: true, force: true }); fileSystem.rmSync(keyFile, { force: true }); fileSystem.mkdirSync(repos, { recursive: true });
  const lines = ENVIRONMENT_KEYS.map((key) => {
    const environment = environments.find((item) => item.key === key); return `LD_EVALUATION_SDK_KEY_${key.toUpperCase()}=${environment.apiKey}`;
  });
  lines.push(`DEMO_GENERATION_ID=${generation}`);
  const clones = [];
  try {
    for (const repository of REPOS) {
      const url = `https://github.com/${settings.org}/${repository}.git`; const target = path.join(repos, repository);
      await clone(url, target); clones.push({ repository, url, target });
    }
    fileSystem.writeFileSync(keyFile, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    fileSystem.rmSync(keyFile, { force: true }); fileSystem.rmSync(repos, { recursive: true, force: true });
    throw error;
  }
  return { runtime, clones };
}
export function cleanRuntime(root = process.cwd(), fileSystem = fs) {
  const runtime = runtimeDirectory(root);
  fileSystem.rmSync(path.join(runtime, 'sdk-keys.env'), { force: true });
  fileSystem.rmSync(path.join(runtime, 'repos'), { recursive: true, force: true });
}
export async function assertRuntimeStopped(root = process.cwd(), controls = {}) {
  const fileSystem = controls.fileSystem || fs; const runtime = runtimeDirectory(root); const keyFile = path.join(runtime, 'sdk-keys.env');
  if (!fileSystem.existsSync(keyFile)) return;
  const inspect = controls.inspect || (async () => execFileAsync('docker', ['compose', '--env-file', keyFile, '-f', path.join(runtime, 'compose.yaml'), 'ps', '--status', 'running', '--services'], { cwd: root, windowsHide: true }));
  let result;
  try { result = await inspect(); } catch { throw new Error('Cannot verify that the tracked Compose runtime is stopped; run the documented docker compose down command first.'); }
  const running = String(typeof result === 'string' ? result : (result?.stdout ?? '')).trim();
  if (running) throw new Error('The tracked Compose runtime is still running; stop it before changing demo resources.');
}
async function projectIfPresent(fetcher, token, settings, controls) {
  try { return await ld(fetcher, `/api/v2/projects/${settings.project}`, token, undefined, controls); }
  catch (error) { if (/\(404\)/.test(error.message)) return null; throw error; }
}
export async function existingProjectState(fetcher, token, settings, controls) {
  assertScope(settings);
  const project = await ld(fetcher, `/api/v2/projects/${settings.project}`, token, undefined, controls);
  if (project.key !== settings.project || typeof project._id !== 'string' || !project._id) throw new Error('LaunchDarkly project identity mismatch.');
  const environmentResult = await ld(fetcher, `/api/v2/projects/${settings.project}/environments?limit=100`, token, undefined, controls);
  const environmentItems = environmentResult.items;
  if (!Array.isArray(environmentItems) || environmentItems.length !== ENVIRONMENT_KEYS.length || ENVIRONMENTS.some((expected) => {
    const actual = environmentItems.find((item) => item.key === expected.key);
    return !actual || actual.critical !== expected.critical || typeof actual.apiKey !== 'string' || !actual.apiKey;
  })) throw new Error('Existing LaunchDarkly environments do not match the fixed demo scope and criticality.');
  const flagResult = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, token, undefined, controls);
  if (!Array.isArray(flagResult.items) || flagResult.items.length !== FLAGS.length || FLAGS.some((key) => !flagResult.items.some((item) => item.key === key))) throw new Error('Existing LaunchDarkly flags do not match the fixed demo scope.');
  const flags = [];
  for (const key of FLAGS) {
    const flag = await ld(fetcher, `/api/v2/flags/${settings.project}/${key}`, token, undefined, controls);
    if (flag.key !== key || flag.kind !== 'boolean' || !Array.isArray(flag.variations) || flag.variations.length !== 2 || !flag.variations.some((item) => item.value === true) || !flag.variations.some((item) => item.value === false)) throw new Error('Existing LaunchDarkly flag identity or variations mismatch.');
    flags.push(flag);
  }
  return { project, environments: environmentItems, flags, projectId: project._id };
}
export async function configureFlagTargeting(fetcher, token, settings, environment, flag, controls, options = {}) {
  assertScope({ ...settings, flags: [flag?.key, ...FLAGS.filter((key) => key !== flag?.key)] });
  if (!ENVIRONMENT_KEYS.includes(environment)) throw new Error('Refusing an identifier outside the fixed disposable scope.');
  const enabled = variationId(flag, true); const disabled = variationId(flag, false);
  const existingPrerequisites = flag.environments?.[environment]?.prerequisites || [];
  if (!Array.isArray(existingPrerequisites) || existingPrerequisites.some((existing) => typeof existing.key !== 'string' || !existing.key)) throw new Error('Existing LaunchDarkly prerequisites are malformed.');
  const instructions = [
    ...existingPrerequisites.map((existing) => ({ kind: 'removePrerequisite', key: existing.key })),
    { kind: 'updateOffVariation', variationId: disabled },
    { kind: 'updateFallthroughVariationOrRollout', variationId: disabled },
    { kind: 'updateTrackEvents', trackEvents: Boolean(options.detailedEvents && environment === 'production' && flag.key === 'demo-checkout-rollout') },
    { kind: 'replaceTargets', targets: [] }
  ];
  if (flag.key === 'demo-checkout-rollout') instructions.push({ kind: 'turnFlagOn' }, { kind: 'replaceRules', rules: [rule('cluster', 'releaseRing', 'canary', enabled), rule('user', 'cohort', 'checkout-beta', enabled), rule('user', 'plan', 'enterprise', enabled)] });
  else if (flag.key === 'demo-legacy-profile') instructions.push({ kind: 'turnFlagOn' }, { kind: 'replaceRules', rules: [rule('user', 'region', 'legacy', enabled)] });
  else if (flag.key === 'demo-retired-banner') instructions.push({ kind: 'turnFlagOff' }, { kind: 'replaceRules', rules: [] });
  else throw new Error('Refusing an identifier outside the fixed disposable scope.');
  return ld(fetcher, `/api/v2/flags/${settings.project}/${flag.key}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; domain-model=launchdarkly.semanticpatch' },
    body: JSON.stringify({ environmentKey: environment, instructions })
  }, controls);
}
export async function recreate(fetcher, env, confirmation, controls = {}) {
  (controls.assertCampaignUnlocked || assertCampaignUnlocked)('recreate', env, controls.breakCampaignLock);
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('recreate', env); const detailedEvents = detailedEventsFor(env); assertScope({ ...settings });
  await (controls.assertRuntimeStopped || assertRuntimeStopped)(controls.runtimeRoot, controls.runtimeCheck);
  const total = 15; let completed = 0;
  const report = async (label) => { if (controls.onProgress) await controls.onProgress({ completed, total, label }); };
  const advance = async (label) => { completed += 1; await report(label); };
  const requestControls = { ...(controls.request || {}) };
  if (controls.onRateLimit) requestControls.onRateLimit = controls.onRateLimit;
  await report('Checking GitHub reset-token access');
  try { await checkGithub(fetcher, t.GH_RESET_TOKEN, settings, requestControls); } catch (error) { throw new Error(`GH_RESET_TOKEN GitHub authentication/read access failed: ${error.message}`); }
  await advance('Checking LaunchDarkly reset-token access');
  try { await checkLaunchDarkly(fetcher, t.LD_RESET_TOKEN, settings, false, requestControls); } catch (error) { throw new Error(`LD_RESET_TOKEN LaunchDarkly authentication/project-list access failed: ${error.message}`); }
  let previousProject;
  try { previousProject = await projectIfPresent(fetcher, t.LD_RESET_TOKEN, settings, requestControls); } catch (error) { throw new Error(`LD_RESET_TOKEN inspect project ${settings.project} failed: ${error.message}`); }
  await advance(`Deleting repository ${REPOS[0]}`);
  const deleted = [];
  for (let index = 0; index < REPOS.length; index += 1) {
    const name = REPOS[index];
    deleted.push([name, await removeIfPresent(fetcher, GH, `/repos/${settings.org}/${name}`, t.GH_RESET_TOKEN, `GH_RESET_TOKEN delete repository ${settings.org}/${name}`, requestControls)]);
    await advance(index + 1 < REPOS.length ? `Deleting repository ${REPOS[index + 1]}` : `Deleting LaunchDarkly project ${settings.project}`);
  }
  deleted.push([settings.project, await removeIfPresent(fetcher, LD, `/api/v2/projects/${settings.project}`, t.LD_RESET_TOKEN, `LD_RESET_TOKEN delete project ${settings.project}`, requestControls)]);
  await advance('Confirming remote deletions (up to 40 seconds)');
  for (const name of REPOS) await waitForRepositoryAbsence(fetcher, t.GH_RESET_TOKEN, settings, name, controls.absenceSleep, requestControls);
  await waitForProjectAbsence(fetcher, t.LD_RESET_TOKEN, settings, controls.absenceSleep, requestControls);
  await advance(`Creating repository ${REPOS[0]}`);
  for (let index = 0; index < REPOS.length; index += 1) {
    const name = REPOS[index];
    try { await createRepositoryWithSource(fetcher, t.GH_RESET_TOKEN, settings, name, SOURCES[name], requestControls); } catch (error) { throw new Error(`GH_RESET_TOKEN provision repository ${settings.org}/${name} failed: ${error.message}`); }
    await advance(index + 1 < REPOS.length ? `Creating repository ${REPOS[index + 1]}` : 'Creating LaunchDarkly project and environments');
  }
  let createdProject;
  try { createdProject = await createProject(fetcher, t.LD_RESET_TOKEN, settings, requestControls); } catch (error) { throw new Error(`LD_RESET_TOKEN create project ${settings.project} failed: ${error.message}`); }
  const generation = controls.generation || generationIdFor(createdProject.projectId, controls.generationNow || new Date());
  await advance(`Creating and configuring flag ${FLAGS[0]}`);
  for (let index = 0; index < FLAGS.length; index += 1) {
    const key = FLAGS[index];
    let flag;
    try { flag = await ld(fetcher, `/api/v2/flags/${settings.project}`, t.LD_RESET_TOKEN, { method: 'POST', body: JSON.stringify({ key, name: key, variations: [{ value: true }, { value: false }] }) }, requestControls); }
    catch (error) { throw new Error(`LD_RESET_TOKEN create flag ${settings.project}/${key} failed: ${error.message}`); }
    for (const environment of ENVIRONMENT_KEYS) try { await configureFlagTargeting(fetcher, t.LD_RESET_TOKEN, settings, environment, flag, requestControls, { detailedEvents }); }
    catch (error) { throw new Error(`LD_RESET_TOKEN configure flag ${settings.project}/${key} in environment ${environment} failed: ${error.message}`); }
    await advance(index + 1 < FLAGS.length ? `Creating and configuring flag ${FLAGS[index + 1]}` : 'Preparing local runtime clones and SDK keys');
  }
  try { await (controls.prepareRuntime || prepareRuntime)(settings, createdProject.environments, generation, controls.runtime); }
  catch (error) { throw new Error(`Prepare local runtime failed: ${error.message}`); }
  await advance('Recreate complete');
  return { deleted, previousProjectId: previousProject?._id || null, projectId: createdProject.projectId, generation };
}
export async function refresh(fetcher, env, confirmation, controls = {}) {
  (controls.assertCampaignUnlocked || assertCampaignUnlocked)('refresh', env, controls.breakCampaignLock);
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('refresh', env); const detailedEvents = detailedEventsFor(env); assertScope({ ...settings });
  await (controls.assertRuntimeStopped || assertRuntimeStopped)(controls.runtimeRoot, controls.runtimeCheck);
  const total = 13; let completed = 0;
  const report = async (label) => { if (controls.onProgress) await controls.onProgress({ completed, total, label }); };
  const advance = async (label) => { completed += 1; await report(label); };
  const requestControls = { ...(controls.request || {}) }; if (controls.onRateLimit) requestControls.onRateLimit = controls.onRateLimit;
  await report('Checking GitHub reset-token access');
  try { await checkGithub(fetcher, t.GH_RESET_TOKEN, settings, requestControls); } catch (error) { throw new Error(`GH_RESET_TOKEN GitHub authentication/read access failed: ${error.message}`); }
  await advance('Verifying exact LaunchDarkly project state');
  let state;
  try { state = await existingProjectState(fetcher, t.LD_RESET_TOKEN, settings, requestControls); } catch (error) { throw new Error(`LD_RESET_TOKEN verify preserved project ${settings.project} failed: ${error.message}`); }
  const generation = controls.generation || generationIdFor(state.projectId, controls.generationNow || new Date());
  await advance(`Deleting repository ${REPOS[0]}`);
  const deleted = [];
  for (let index = 0; index < REPOS.length; index += 1) {
    const name = REPOS[index];
    deleted.push([name, await removeIfPresent(fetcher, GH, `/repos/${settings.org}/${name}`, t.GH_RESET_TOKEN, `GH_RESET_TOKEN delete repository ${settings.org}/${name}`, requestControls)]);
    await advance(index + 1 < REPOS.length ? `Deleting repository ${REPOS[index + 1]}` : 'Confirming repository deletions (up to 30 seconds)');
  }
  for (const name of REPOS) await waitForRepositoryAbsence(fetcher, t.GH_RESET_TOKEN, settings, name, controls.absenceSleep, requestControls);
  await advance(`Creating repository ${REPOS[0]}`);
  for (let index = 0; index < REPOS.length; index += 1) {
    const name = REPOS[index];
    try { await createRepositoryWithSource(fetcher, t.GH_RESET_TOKEN, settings, name, SOURCES[name], requestControls); } catch (error) { throw new Error(`GH_RESET_TOKEN provision repository ${settings.org}/${name} failed: ${error.message}`); }
    await advance(index + 1 < REPOS.length ? `Creating repository ${REPOS[index + 1]}` : `Reconciling flag ${FLAGS[0]}`);
  }
  for (let index = 0; index < state.flags.length; index += 1) {
    const flag = state.flags[index];
    for (const environment of ENVIRONMENT_KEYS) try { await configureFlagTargeting(fetcher, t.LD_RESET_TOKEN, settings, environment, flag, requestControls, { detailedEvents }); }
    catch (error) { throw new Error(`LD_RESET_TOKEN configure flag ${settings.project}/${flag.key} in environment ${environment} failed: ${error.message}`); }
    await advance(index + 1 < FLAGS.length ? `Reconciling flag ${FLAGS[index + 1]}` : 'Preparing local runtime clones and preserved SDK keys');
  }
  try { await (controls.prepareRuntime || prepareRuntime)(settings, state.environments, generation, controls.runtime); }
  catch (error) { throw new Error(`Prepare local runtime failed: ${error.message}`); }
  await advance('Refresh complete');
  return { deleted, projectId: state.projectId, generation };
}
export async function destroy(fetcher, env, confirmation, controls = {}) {
  (controls.assertCampaignUnlocked || assertCampaignUnlocked)('destroy', env, controls.breakCampaignLock);
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('destroy', env); assertScope({ ...settings }); const result = [];
  await (controls.assertRuntimeStopped || assertRuntimeStopped)(controls.runtimeRoot, controls.runtimeCheck);
  const requestControls = controls.request || {};
  for (const name of REPOS) result.push([name, await removeIfPresent(fetcher, GH, `/repos/${settings.org}/${name}`, t.GH_RESET_TOKEN, `GH_RESET_TOKEN delete repository ${settings.org}/${name}`, requestControls)]);
  result.push([settings.project, await removeIfPresent(fetcher, LD, `/api/v2/projects/${settings.project}`, t.LD_RESET_TOKEN, `LD_RESET_TOKEN delete project ${settings.project}`, requestControls)]);
  (controls.cleanRuntime || cleanRuntime)(controls.runtimeRoot);
  return result;
}
export const DAY_MS = 86_400_000;
export const DEFAULT_MINIMUM_AGE_DAYS = 30;
export function flagAgeEvidence(creationDate, at, minimumAgeDays = DEFAULT_MINIMUM_AGE_DAYS) {
  const created = Number(creationDate);
  if (!Number.isFinite(created) || created <= 0) return { createdAt: null, ageDaysAtCapture: null, minimumAgeReachedAt: null };
  return {
    createdAt: new Date(created).toISOString(),
    ageDaysAtCapture: Math.floor((at.getTime() - created) / DAY_MS),
    minimumAgeReachedAt: new Date(created + minimumAgeDays * DAY_MS).toISOString()
  };
}
export function mergeCampaign(previous, observed) {
  const campaignStart = previous?.campaignStart || observed.capturedAt;
  const scenarioId = previous?.scenarioId || `campaign-${campaignStart.slice(0, 10)}`;
  const record = { schemaVersion: 1, scenarioId, campaignStart, ...observed };
  // Index observations are accumulated evidence, not part of any one snapshot, so a plain
  // baseline capture carries them forward instead of erasing them.
  const indexing = mergeIndexObservations(previous?.indexing, observed.indexing);
  if (indexing) record.indexing = indexing; else delete record.indexing;
  return record;
}
export async function baseline(fetcher, env, controls = {}) {
  const settings = settingsFor(env); assertScope({ ...settings }); const t = tokensFor('baseline', env);
  const requestControls = controls.request || {};
  const at = controls.now ? new Date(controls.now) : new Date();
  const project = await ld(fetcher, `/api/v2/projects/${settings.project}`, t.LD_DEMO_TOKEN, undefined, requestControls);
  if (project.key !== settings.project || typeof project._id !== 'string' || !project._id) throw new Error('LaunchDarkly project identity mismatch.');
  const flagResult = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, t.LD_DEMO_TOKEN, undefined, requestControls);
  const flags = (Array.isArray(flagResult.items) ? flagResult.items : []).map((item) => ({
    key: item.key, name: item.name ?? null, kind: item.kind ?? null, temporary: item.temporary ?? null,
    ...flagAgeEvidence(item.creationDate, at)
  })).sort((a, b) => a.key.localeCompare(b.key));
  const repositories = [];
  const names = Array.isArray(controls.repositories) && controls.repositories.length ? controls.repositories : REPOS;
  for (const name of names) {
    const repo = await gh(fetcher, `/repos/${settings.org}/${name}`, t.GH_DEMO_TOKEN, undefined, requestControls);
    const commits = await gh(fetcher, `/repos/${settings.org}/${name}/commits?per_page=1`, t.GH_DEMO_TOKEN, undefined, requestControls);
    const head = Array.isArray(commits) ? commits[0] : null;
    repositories.push({
      name, id: repo.id ?? null, nodeId: repo.node_id ?? null, createdAt: repo.created_at ?? null,
      defaultBranch: repo.default_branch ?? null, visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
      headShaAtBaseline: head?.sha ?? null, headCommittedAt: head?.commit?.committer?.date ?? null
    });
  }
  return {
    capturedAt: at.toISOString(), organization: settings.org,
    project: { key: project.key, id: project._id, name: project.name ?? null },
    flags, repositories
  };
}
export const BATCH_DUTY_DIVISOR = 50;
export const CATALOG_MAX_FLAGS = 45;
export const PRESENTATION_ROLES = {
  'not-started': 3, 'partial-rollout': 6, 'rolled-out-still-referenced': 5, 'cleanup-draining': 4,
  'protected-live-archive-candidate': 2, 'archived': 2, 'rolled-back-or-limited': 2
};
export const CATALOG_SIZE = Object.values(PRESENTATION_ROLES).reduce((total, count) => total + count, 0);
export function assertFlagCatalog(catalog) {
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.flags)) throw new Error('Flag catalog is missing or declares an unsupported schema version.');
  const flags = catalog.flags;
  if (flags.length !== CATALOG_SIZE) throw new Error(`Flag catalog must contain exactly ${CATALOG_SIZE} flags; found ${flags.length}.`);
  if (flags.length > CATALOG_MAX_FLAGS) throw new Error(`Flag catalog exceeds the maximum of ${CATALOG_MAX_FLAGS} flags.`);
  const keys = new Set();
  for (const flag of flags) {
    if (typeof flag.key !== 'string' || !/^demo-[a-z0-9]+(-[a-z0-9]+)*$/.test(flag.key)) throw new Error(`Refusing an unsafe catalog flag key: ${String(flag.key)}`);
    if (keys.has(flag.key)) throw new Error(`Duplicate catalog flag key: ${flag.key}`);
    keys.add(flag.key);
    if (typeof flag.name !== 'string' || !flag.name) throw new Error(`Flag ${flag.key} must declare a name.`);
    if (typeof flag.temporary !== 'boolean') throw new Error(`Flag ${flag.key} must declare temporary as a boolean.`);
    if (!Object.hasOwn(PRESENTATION_ROLES, flag.presentationRole)) throw new Error(`Flag ${flag.key} declares an unknown presentation role.`);
  }
  for (const key of FLAGS) {
    const flag = flags.find((item) => item.key === key);
    if (!flag) throw new Error(`Catalog must adopt the pre-existing flag ${key} rather than dropping it.`);
    if (flag.cohort !== 'pre-campaign') throw new Error(`Pre-existing flag ${key} must be marked with cohort pre-campaign.`);
  }
  const counts = {};
  for (const flag of flags) counts[flag.presentationRole] = (counts[flag.presentationRole] || 0) + 1;
  for (const [role, expected] of Object.entries(PRESENTATION_ROLES)) {
    if (counts[role] !== expected) throw new Error(`Presentation role ${role} must cover exactly ${expected} flags; found ${counts[role] || 0}.`);
  }
  const guarded = flags.filter((flag) => flag.protected === true);
  if (guarded.length !== 2) throw new Error('Exactly two protected live-demo archive candidates are required.');
  if (guarded.some((flag) => flag.presentationRole !== 'protected-live-archive-candidate')) throw new Error('Protected flags must declare the protected-live-archive-candidate role.');
  const rehearsal = flags.filter((flag) => flag.rehearsalArchiveCandidate === true);
  if (rehearsal.length !== 2) throw new Error('Exactly two reserved rehearsal archive candidates are required.');
  if (rehearsal.some((flag) => flag.protected === true)) throw new Error('Rehearsal archive candidates must not be the protected live pair.');
  return { keys: [...keys], protected: guarded.map((flag) => flag.key), rehearsal: rehearsal.map((flag) => flag.key) };
}
export async function bootstrapFlags(fetcher, env, confirmation, catalog, controls = {}) {
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('bootstrap', env);
  assertFlagCatalog(catalog);
  const scenarioId = controls.scenarioId;
  if (typeof scenarioId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(scenarioId)) throw new Error('Bootstrap requires the campaign scenario identifier from campaign.json.');
  const requestControls = controls.request || {};
  const listed = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, t.LD_RESET_TOKEN, undefined, requestControls);
  const existing = new Map((Array.isArray(listed.items) ? listed.items : []).map((item) => [item.key, item]));
  const catalogKeys = new Set(catalog.flags.map((flag) => flag.key));
  const unknown = [...existing.keys()].filter((key) => !catalogKeys.has(key));
  if (unknown.length) throw new Error(`Refusing to bootstrap: ${unknown.length} flag(s) in project ${settings.project} are absent from the catalog. Resolve the drift before creating anything.`);
  const created = []; const adopted = []; const total = catalog.flags.length; let completed = 0;
  for (const flag of catalog.flags) {
    const present = existing.get(flag.key);
    if (present) adopted.push({ key: flag.key, id: present._id ?? null });
    else {
      const body = { key: flag.key, name: flag.name, description: flag.description ?? '', temporary: flag.temporary, tags: [scenarioId], variations: [{ value: true }, { value: false }] };
      let result;
      try { result = await ld(fetcher, `/api/v2/flags/${settings.project}`, t.LD_RESET_TOKEN, { method: 'POST', body: JSON.stringify(body) }, requestControls); }
      catch (error) { throw new Error(`LD_RESET_TOKEN create flag ${settings.project}/${flag.key} failed: ${error.message}`); }
      created.push({ key: flag.key, id: result._id ?? null });
    }
    completed += 1;
    if (controls.onProgress) await controls.onProgress({ completed, total, label: present ? `Adopted existing flag ${flag.key}` : `Created flag ${flag.key}` });
  }
  return { created, adopted };
}
export const TEMPLATES = ['nodejs', 'typescript', 'go', 'python'];
export const CADENCES = ['daily', 'three-day'];
export const PRE_CAMPAIGN_REFERENCES = {
  'demo-orders': ['demo-checkout-rollout'],
  'demo-storefront': ['demo-checkout-rollout'],
  'demo-profile': ['demo-legacy-profile']
};
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DNS_LABEL = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SAFE_DEMO_KEY = /^demo-[a-z0-9]+(-[a-z0-9]+)*$/;
export const dayNumber = (iso) => {
  if (!DATE_ONLY.test(iso || '')) throw new Error(`Invalid calendar date: ${String(iso)}`);
  const value = Date.parse(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(value)) throw new Error(`Invalid calendar date: ${iso}`);
  return Math.floor(value / DAY_MS);
};
export function assertSandbox(sandbox) {
  if (!sandbox || sandbox.schemaVersion !== 1) throw new Error('sandbox.json is missing or declares an unsupported schema version.');
  const environments = sandbox.environments;
  if (!Array.isArray(environments) || environments.length !== ENVIRONMENT_KEYS.length) throw new Error('sandbox.json must define exactly the four fixed environments.');
  environments.forEach((environment, index) => {
    const expected = ENVIRONMENTS[index];
    if (environment.key !== expected.key) throw new Error(`sandbox.json environment order must be ${ENVIRONMENT_KEYS.join(', ')}.`);
    if (environment.critical !== expected.critical) throw new Error(`sandbox.json environment ${environment.key} must declare critical ${expected.critical}.`);
    const clusters = environment.clusters;
    if (!Array.isArray(clusters) || !clusters.length) throw new Error(`sandbox.json environment ${environment.key} has an invalid cluster list.`);
    let total = 0; const orders = new Set(); const keys = new Set();
    for (const cluster of clusters) {
      if (!DNS_LABEL.test(cluster?.key || '')) throw new Error(`sandbox.json environment ${environment.key} has an invalid cluster key.`);
      if (keys.has(cluster.key)) throw new Error(`sandbox.json repeats cluster ${cluster.key}.`);
      keys.add(cluster.key);
      if (!Number.isInteger(cluster.weight) || cluster.weight < 1 || cluster.weight > 100) throw new Error(`Cluster ${cluster.key} must declare an integer population weight from 1 to 100.`);
      if (!Number.isInteger(cluster.rolloutOrder) || cluster.rolloutOrder < 1) throw new Error(`Cluster ${cluster.key} must declare a positive rolloutOrder.`);
      if (orders.has(cluster.rolloutOrder)) throw new Error(`sandbox.json environment ${environment.key} repeats rolloutOrder ${cluster.rolloutOrder}.`);
      orders.add(cluster.rolloutOrder); total += cluster.weight;
    }
    if (total !== 100) throw new Error(`sandbox.json environment ${environment.key} cluster weights sum to ${total}, not 100.`);
    for (let order = 1; order <= clusters.length; order += 1) if (!orders.has(order)) throw new Error(`sandbox.json environment ${environment.key} rolloutOrder must be contiguous from 1; ${order} is missing.`);
    // Least-populated-first is what makes a rollout an accelerating curve instead of equal steps.
    const byOrder = [...clusters].sort((a, b) => a.rolloutOrder - b.rolloutOrder);
    for (let index = 1; index < byOrder.length; index += 1) {
      if (byOrder[index].weight < byOrder[index - 1].weight) throw new Error(`sandbox.json environment ${environment.key} rolls out ${byOrder[index].key} (weight ${byOrder[index].weight}) after the heavier ${byOrder[index - 1].key} (weight ${byOrder[index - 1].weight}); order least-populated first.`);
    }
  });
  const limits = sandbox.limits || {};
  for (const [key, min, max] of [['maxRepositories', 1, 20], ['maxFlags', 1, CATALOG_MAX_FLAGS], ['maxEvaluatorContainers', 1, 40], ['maxAverageServiceConnections', 1, 5], ['sustainedConnectionServices', 0, 5]]) {
    if (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max) throw new Error(`sandbox.json limit ${key} must be an integer between ${min} and ${max}.`);
  }
  // Only sustained connections cost a full average connection each. Batch evaluators hold one
  // for roughly 800ms per 300s cycle, measured live — a 0.27% duty cycle. BATCH_DUTY_DIVISOR is
  // set to 50 (2%), still seven times more pessimistic than observed, so the guard protects the
  // budget without blocking coverage the plan can comfortably afford.
  const projected = limits.sustainedConnectionServices + Math.ceil(limits.maxEvaluatorContainers / BATCH_DUTY_DIVISOR);
  if (projected > limits.maxAverageServiceConnections) throw new Error(`Projected average service connections (${projected}) exceed the plan ceiling of ${limits.maxAverageServiceConnections}. Reduce sustained connections or evaluator containers.`);
  const cadence = sandbox.cadence || {};
  if (!Array.isArray(cadence.dailyTransitions) || !Array.isArray(cadence.dailyWindows)) throw new Error('sandbox.json must define cadence.dailyTransitions and cadence.dailyWindows.');
  for (const window of cadence.dailyWindows) if (dayNumber(window.from) > dayNumber(window.to)) throw new Error('sandbox.json contains a daily window that ends before it starts.');
  return sandbox;
}
export function assertServices(services, catalog, sandbox) {
  if (!services || services.schemaVersion !== 1 || !Array.isArray(services.services)) throw new Error('services.json is missing or declares an unsupported schema version.');
  const list = services.services;
  if (list.length > sandbox.limits.maxRepositories) throw new Error(`services.json defines ${list.length} services, exceeding the maximum of ${sandbox.limits.maxRepositories}.`);
  const flagKeys = new Set(catalog.flags.map((flag) => flag.key));
  const keys = new Set(); const consumers = new Map();
  for (const service of list) {
    if (typeof service.key !== 'string' || !SAFE_DEMO_KEY.test(service.key)) throw new Error(`Refusing an unsafe service key: ${String(service.key)}`);
    if (keys.has(service.key)) throw new Error(`Duplicate service key: ${service.key}`);
    keys.add(service.key);
    if (!TEMPLATES.includes(service.template)) throw new Error(`Service ${service.key} declares an unknown template.`);
    if (!Number.isInteger(service.wave) || service.wave < 1) throw new Error(`Service ${service.key} declares an invalid wave.`);
    if (!Array.isArray(service.flags)) throw new Error(`Service ${service.key} must declare a flags array.`);
    for (const key of service.flags) {
      if (!flagKeys.has(key)) throw new Error(`Service ${service.key} consumes unknown flag ${key}.`);
      consumers.set(key, (consumers.get(key) || 0) + 1);
    }
  }
  for (const key of REPOS) if (!keys.has(key)) throw new Error(`services.json must retain the pre-campaign service ${key}.`);
  if ((consumers.get('demo-checkout-rollout') || 0) < 5) throw new Error('demo-checkout-rollout must be consumed by at least five services so organization-wide search has an obvious multi-repository example.');
  const counts = [...consumers.values()];
  const multi = counts.filter((count) => count >= 2 && count <= 4).length;
  const single = counts.filter((count) => count === 1).length;
  if (multi < 16) throw new Error(`At least sixteen flags need two to four consuming services; found ${multi}.`);
  if (single < 6) throw new Error(`At least six flags must be single-service; found ${single}.`);
  return { keys: [...keys], byKey: new Map(list.map((service) => [service.key, service])) };
}
function dailyCadenceAllowed(step, sandbox) {
  const { dailyTransitions = [], dailyWindows = [] } = sandbox.cadence || {};
  if (step.transition && dailyTransitions.includes(step.transition)) return true;
  const day = dayNumber(step.recommendedDate);
  return dailyWindows.some((window) => day >= dayNumber(window.from) && day <= dayNumber(window.to));
}
export function compileScenario({ sandbox, services, catalog, steps }) {
  assertSandbox(sandbox); assertFlagCatalog(catalog);
  const { byKey } = assertServices(services, catalog, sandbox);
  const environmentClusters = new Map(sandbox.environments.map((environment) => [environment.key, environment.clusters]));
  const patterns = new Set([...Object.keys(sandbox.trafficPatterns || {}), ...Object.keys(sandbox.drainPatterns || {})]);
  const introduced = new Map();
  for (const service of services.services) {
    if (service.cohort !== 'pre-campaign') continue;
    introduced.set(service.key, { key: service.key, template: service.template, references: [...(PRE_CAMPAIGN_REFERENCES[service.key] || [])], tag: null, introducedBy: 'pre-campaign' });
  }
  const catalogKeys = new Set(catalog.flags.map((flag) => flag.key));
  const targeting = new Map();
  let deployments = []; const seenIds = new Set(); const applied = []; let previous = null;
  for (const step of steps) {
    if (!step || step.schemaVersion !== 1) throw new Error('A scenario step is missing or declares an unsupported schema version.');
    if (typeof step.id !== 'string' || !/^s\d{3}$/.test(step.id)) throw new Error(`Invalid step id: ${String(step.id)}`);
    if (seenIds.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`);
    seenIds.add(step.id);
    if (!CADENCES.includes(step.cadence)) throw new Error(`Step ${step.id} declares an unknown cadence.`);
    const day = dayNumber(step.recommendedDate);
    if (step.cadence === 'daily' && !dailyCadenceAllowed(step, sandbox)) throw new Error(`Step ${step.id} uses daily cadence outside the permitted short transitions and windows.`);
    if (previous) {
      const gap = day - dayNumber(previous.recommendedDate);
      if (gap < 0) throw new Error(`Step ${step.id} is dated before ${previous.id}; steps are forward-only.`);
      const required = Number.isInteger(step.minGapDaysFromPrevious) ? step.minGapDaysFromPrevious : 0;
      if (gap < required) throw new Error(`Step ${step.id} falls ${gap} day(s) after ${previous.id} but requires at least ${required}.`);
    }
    for (const key of step.introduceServices || []) {
      const service = byKey.get(key);
      if (!service) throw new Error(`Step ${step.id} introduces unknown service ${key}.`);
      if (introduced.has(key)) throw new Error(`Step ${step.id} re-introduces ${key}, which already exists. Resources are never recreated.`);
      introduced.set(key, { key, template: service.template, references: [], tag: null, introducedBy: step.id });
    }
    for (const key of step.updateServices || []) {
      if (!introduced.has(key)) throw new Error(`Step ${step.id} updates ${key}, which is not introduced yet.`);
    }
    for (const [key, references] of Object.entries(step.sourceReferences || {})) {
      const target = introduced.get(key);
      if (!target) throw new Error(`Step ${step.id} adds source references to ${key}, which is not introduced yet.`);
      const declared = new Set(byKey.get(key).flags || []);
      for (const flag of references) if (!declared.has(flag)) throw new Error(`Step ${step.id} references ${flag} in ${key}, which does not declare it as a consumer.`);
      target.references = [...new Set([...target.references, ...references])].sort();
    }
    for (const [key, tag] of Object.entries(step.releaseTags || {})) {
      const target = introduced.get(key);
      if (!target) throw new Error(`Step ${step.id} tags ${key}, which is not introduced yet.`);
      if (typeof tag !== 'string' || !/^v\d{3}$/.test(tag)) throw new Error(`Step ${step.id} declares an invalid release tag for ${key}.`);
      if (target.tag && target.tag >= tag) throw new Error(`Step ${step.id} moves ${key} to tag ${tag}, which does not advance past ${target.tag}. Tags are immutable and forward-only.`);
      target.tag = tag;
    }
    if (Array.isArray(step.deploy)) {
      const next = [];
      for (const tuple of step.deploy) {
        if (!introduced.has(tuple.service)) throw new Error(`Step ${step.id} deploys ${tuple.service}, which is not introduced yet.`);
        if (!environmentClusters.has(tuple.environment)) throw new Error(`Step ${step.id} deploys ${tuple.service} to unknown environment ${tuple.environment}.`);
        if (tuple.traffic && !patterns.has(tuple.traffic)) throw new Error(`Step ${step.id} uses unknown traffic pattern ${tuple.traffic}.`);
        const identity = `${tuple.service}/${tuple.environment}`;
        if (next.some((item) => `${item.service}/${item.environment}` === identity)) throw new Error(`Step ${step.id} declares ${identity} twice.`);
        next.push({ service: tuple.service, environment: tuple.environment, traffic: tuple.traffic || 'silent' });
      }
      const cap = sandbox.limits.maxEvaluatorContainers;
      if (next.length > cap) throw new Error(`Step ${step.id} declares ${next.length} evaluator containers, exceeding the cap of ${cap}.`);
      deployments = next;
    }
    for (const entry of step.targeting || []) {
      if (!catalogKeys.has(entry.flag)) throw new Error(`Step ${step.id} targets unknown flag ${entry.flag}.`);
      const clusters = environmentClusters.get(entry.environment);
      if (!clusters) throw new Error(`Step ${step.id} targets ${entry.flag} in unknown environment ${entry.environment}.`);
      if (!['on', 'off'].includes(entry.state)) throw new Error(`Step ${step.id} sets an unknown state "${entry.state}" for ${entry.flag}.`);
      if (entry.serve !== undefined && !['true', 'false'].includes(entry.serve)) throw new Error(`Step ${step.id} sets an unknown serve value for ${entry.flag}.`);
      if (entry.serve === 'true' && (entry.clusters || []).length) throw new Error(`Step ${step.id} serves true and also lists clusters for ${entry.flag}; the fallthrough already covers every context.`);
      const known = new Map(clusters.map((cluster) => [cluster.key, cluster]));
      for (const key of entry.clusters || []) if (!known.has(key)) throw new Error(`Step ${step.id} targets cluster ${key}, which does not belong to ${entry.environment}.`);
      // Rollout goes least-populated first, so the targeted set must be a prefix of rolloutOrder.
      // A deliberate rollback or intentionally limited flag declares an exception instead.
      if (!entry.exception && (entry.clusters || []).length) {
        const orders = entry.clusters.map((key) => known.get(key).rolloutOrder).sort((a, b) => a - b);
        orders.forEach((order, index) => {
          if (order !== index + 1) throw new Error(`Step ${step.id} targets ${entry.flag} in ${entry.environment} out of rollout order; expected the least-populated clusters first. Declare "exception" to model a deliberate rollback or limited rollout.`);
        });
      }
      targeting.set(`${entry.flag}/${entry.environment}`, {
        flag: entry.flag, environment: entry.environment, state: entry.state,
        serve: entry.serve || 'false', clusters: [...(entry.clusters || [])], exception: entry.exception || null
      });
    }
    applied.push({ id: step.id, recommendedDate: step.recommendedDate, cadence: step.cadence, title: step.title || '' });
    previous = step;
  }
  const targetingList = [...targeting.values()].sort((a, b) => `${a.flag}/${a.environment}`.localeCompare(`${b.flag}/${b.environment}`));
  const model = {
    scenarioId: sandbox.scenarioId,
    services: [...introduced.values()].map((service) => ({ ...service, references: [...service.references].sort() })).sort((a, b) => a.key.localeCompare(b.key)),
    deployments: [...deployments].sort((a, b) => `${a.service}/${a.environment}`.localeCompare(`${b.service}/${b.environment}`)),
    targeting: targetingList,
    steps: applied
  };
  return { ...model, checksum: scenarioChecksum(model), distribution: targetingDistribution(targetingList, catalog, sandbox) };
}
export function targetingDistribution(targetingList, catalog, sandbox) {
  const environments = sandbox.environments.map((environment) => environment.key);
  const byFlag = new Map();
  for (const entry of targetingList) {
    if (!byFlag.has(entry.flag)) byFlag.set(entry.flag, new Map());
    byFlag.get(entry.flag).set(entry.environment, entry);
  }
  const onEverywhere = []; const onBelowProduction = []; const rollingOut = []; const untouched = [];
  for (const flag of catalog.flags) {
    const states = byFlag.get(flag.key);
    if (!states) { untouched.push(flag.key); continue; }
    const live = environments.filter((key) => states.get(key)?.state === 'on');
    const serving = environments.filter((key) => states.get(key)?.serve === 'true');
    if (serving.length === environments.length) onEverywhere.push(flag.key);
    else if (serving.length && !serving.includes('production')) onBelowProduction.push(flag.key);
    else if (live.length) rollingOut.push(flag.key);
    else untouched.push(flag.key);
  }
  return { onEverywhere, onBelowProduction, rollingOut, untouched };
}
export function scenarioChecksum(model) {
  return crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0, 16);
}
// Per-language container shape. Every template runs the same batch: connect, evaluate every flag
// the release owns, flush, close. Only the entrypoint differs.
export const TEMPLATE_RUNTIME = {
  nodejs: { command: ['npm', 'run', 'traffic', '--', '--profile'] },
  typescript: { command: ['npm', 'run', 'traffic', '--', '--profile'] },
  go: { command: ['/app/evaluator', '--traffic', '--profile'] },
  python: { command: ['python', '-u', 'app.py', '--traffic', '--profile'] }
};
export function composeServiceName(serviceKey, environment) {
  return `${serviceKey.replace(/^demo-/, '')}-${environment}`;
}
export function generateCompose(model, services, sandbox) {
  const byKey = new Map(services.services.map((service) => [service.key, service]));
  const deployed = [...new Set(model.deployments.map((tuple) => tuple.service))].sort();
  const cap = sandbox.limits.maxEvaluatorContainers;
  if (model.deployments.length > cap) throw new Error(`Compose would declare ${model.deployments.length} evaluators, exceeding the cap of ${cap}.`);
  const lines = [
    '# Generated from the compiled scenario. Do not edit by hand; change scenario/steps and reapply.',
    'x-runtime-environment: &runtime-environment',
    '  DEMO_GENERATION_ID: ${DEMO_GENERATION_ID:?missing demo generation}',
    '',
    'x-rotated-logs: &rotated-logs',
    '  driver: json-file',
    '  options:',
    '    max-size: 10m',
    '    max-file: "3"',
    ''
  ];
  for (const key of deployed) {
    const service = byKey.get(key);
    if (!service) throw new Error(`Compose generation found no catalog entry for ${key}.`);
    lines.push(`x-${key.replace(/^demo-/, '')}: &${key.replace(/^demo-/, '')}`, `  build: ./repos/${key}`, `  image: clean-room-demo/${key}:local`,
      '  init: true', '  restart: unless-stopped', '  stop_grace_period: 30s', '  logging: *rotated-logs', '');
  }
  lines.push('services:');
  const order = sandbox.environments.map((environment) => environment.key);
  const sorted = [...model.deployments].sort((a, b) => order.indexOf(a.environment) - order.indexOf(b.environment) || a.service.localeCompare(b.service));
  for (const tuple of sorted) {
    const service = byKey.get(tuple.service);
    const runtime = TEMPLATE_RUNTIME[service.template];
    if (!runtime) throw new Error(`No container runtime defined for template ${service.template}.`);
    const probe = sandbox.trafficPatterns?.[tuple.traffic]?.kind === 'paced';
    lines.push(`  ${composeServiceName(tuple.service, tuple.environment)}:`, `    <<: *${tuple.service.replace(/^demo-/, '')}`, '    environment:', '      <<: *runtime-environment',
      `      LD_EVALUATION_SDK_KEY: \${LD_EVALUATION_SDK_KEY_${tuple.environment.toUpperCase()}:?missing ${tuple.environment} SDK key}`,
      `      DEMO_ENVIRONMENT: ${tuple.environment}`);
    if (probe) lines.push('      DEMO_EVALUATIONS_PER_HOUR: ${DEMO_EVALUATIONS_PER_HOUR:-1200}', '      DEMO_CONTEXT_POOL_SIZE: ${DEMO_CONTEXT_POOL_SIZE:-1000}');
    lines.push(`    command: [${[...runtime.command, tuple.environment].map((part) => `"${part}"`).join(', ')}]`);
  }
  return `${lines.join('\n')}\n`;
}
export function loadScenario(root = process.cwd(), fileSystem = fs) {
  const directory = path.join(root, 'scenario');
  const read = (name) => JSON.parse(fileSystem.readFileSync(path.join(directory, name), 'utf8'));
  const stepsDirectory = path.join(directory, 'steps');
  const files = fileSystem.readdirSync(stepsDirectory).filter((name) => name.endsWith('.json')).sort();
  const steps = files.map((name) => JSON.parse(fileSystem.readFileSync(path.join(stepsDirectory, name), 'utf8')));
  return { sandbox: read('sandbox.json'), services: read('services.json'), catalog: read('flags.json'), steps, stepFiles: files };
}
export function targetingInstructions(entry, flag) {
  const enabled = variationId(flag, true); const disabled = variationId(flag, false);
  const instructions = [{ kind: 'updateOffVariation', variationId: disabled }];
  if (entry.state === 'off') {
    instructions.push({ kind: 'turnFlagOff' }, { kind: 'replaceRules', rules: [] });
    return instructions;
  }
  instructions.push({ kind: 'turnFlagOn' });
  // Fallthrough is what every context not matched by a cluster rule receives. A rollout
  // keeps it on false and moves clusters across one rule at a time; the terminal
  // "fully rolled out" state is fallthrough true with the rules cleared.
  instructions.push({ kind: 'updateFallthroughVariationOrRollout', variationId: entry.serve === 'true' ? enabled : disabled });
  instructions.push({ kind: 'replaceRules', rules: (entry.clusters || []).map((key) => rule('cluster', 'key', key, enabled)) });
  return instructions;
}
export async function applyTargeting(fetcher, token, settings, entries, controls = {}) {
  const applied = [];
  for (const entry of entries) {
    const flag = await ld(fetcher, `/api/v2/flags/${settings.project}/${entry.flag}`, token, undefined, controls.request);
    if (flag?.key !== entry.flag) throw new Error(`LaunchDarkly flag ${entry.flag} could not be read for targeting.`);
    const instructions = targetingInstructions(entry, flag);
    await ld(fetcher, `/api/v2/flags/${settings.project}/${entry.flag}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; domain-model=launchdarkly.semanticpatch' },
      body: JSON.stringify({ environmentKey: entry.environment, instructions, comment: entry.comment || 'Scenario targeting change' })
    }, controls.request);
    applied.push({ flag: entry.flag, environment: entry.environment, state: entry.state, serve: entry.serve || 'false', clusters: entry.clusters || [] });
    if (controls.onTargeting) await controls.onTargeting(applied.at(-1));
  }
  return applied;
}
export const OWNERSHIP_MARKER = '.scenario-owner.json';
export function catalogSource(serviceKey, flags, scenarioId, template = 'nodejs', release = 'v001', topology = DEFAULT_CLUSTER_TOPOLOGY, org = 'demo-org') {
  const builders = {
    nodejs: () => repositoryFiles(serviceKey, flags, release, topology),
    typescript: () => typescriptFiles(serviceKey, flags, release, topology),
    go: () => goFiles(serviceKey, flags, release, topology, org),
    python: () => pythonFiles(serviceKey, flags, release, topology)
  };
  if (!builders[template]) throw new Error(`Source template "${template}" is not implemented.`);
  const files = builders[template]();
  files.push({ path: OWNERSHIP_MARKER, content: `${JSON.stringify({ scenarioId, service: serviceKey, template, release }, null, 2)}\n` });
  return { files, date: null };
}
export async function repositoryIfPresent(fetcher, token, settings, name, controls) {
  try { return await gh(fetcher, `/repos/${settings.org}/${name}`, token, undefined, controls); }
  catch (error) { if (/\(404\)/.test(error.message)) return null; throw error; }
}
export async function refIfPresent(fetcher, token, settings, name, ref, controls) {
  try { return await gh(fetcher, `/repos/${settings.org}/${name}/git/ref/${ref}`, token, undefined, controls); }
  catch (error) { if (/\(404\)/.test(error.message)) return null; throw error; }
}
export async function readOwnershipMarker(fetcher, token, settings, name, controls) {
  try {
    const file = await gh(fetcher, `/repos/${settings.org}/${name}/contents/${OWNERSHIP_MARKER}`, token, undefined, controls);
    if (typeof file?.content !== 'string') return null;
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch (error) { if (/\(404\)/.test(error.message)) return null; throw error; }
}
async function mergeSourceViaPullRequest(fetcher, token, settings, name, source, meta, controls) {
  const { branch, title, body } = meta;
  const base = await gh(fetcher, `/repos/${settings.org}/${name}/git/ref/heads/main`, token, undefined, controls);
  const parentSha = base.object?.sha;
  if (!parentSha) throw new Error(`Repository ${name} has no main reference to branch from.`);
  const parent = await gh(fetcher, `/repos/${settings.org}/${name}/git/commits/${parentSha}`, token, undefined, controls);
  if (!parent.tree?.sha) throw new Error(`Repository ${name} has incomplete commit evidence.`);
  // A branch left behind by an interrupted run is cleared rather than reused, so the
  // change is always built from the current main head.
  if (await refIfPresent(fetcher, token, settings, name, `heads/${branch}`, controls)) {
    await gh(fetcher, `/repos/${settings.org}/${name}/git/refs/heads/${branch}`, token, { method: 'DELETE' }, controls);
  }
  await gh(fetcher, `/repos/${settings.org}/${name}/git/refs`, token, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: parentSha }) }, controls);
  const entries = [];
  for (const file of source.files) {
    const blob = await gh(fetcher, `/repos/${settings.org}/${name}/git/blobs`, token, { method: 'POST', body: JSON.stringify({ content: file.content, encoding: 'utf-8' }) }, controls);
    if (!blob.sha) throw new Error('Synthetic source blob is incomplete.');
    entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await gh(fetcher, `/repos/${settings.org}/${name}/git/trees`, token, { method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries }) }, controls);
  const who = { name: 'Synthetic Demo', email: 'synthetic-demo@example.invalid', date: new Date().toISOString() };
  const commit = await gh(fetcher, `/repos/${settings.org}/${name}/git/commits`, token, { method: 'POST', body: JSON.stringify({ message: title, tree: tree.sha, parents: [parentSha], author: who, committer: who }) }, controls);
  await gh(fetcher, `/repos/${settings.org}/${name}/git/refs/heads/${branch}`, token, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) }, controls);
  let pull;
  try {
    pull = await gh(fetcher, `/repos/${settings.org}/${name}/pulls`, token, { method: 'POST', body: JSON.stringify({ title, body, head: branch, base: 'main' }) }, controls);
  } catch (error) {
    // An interrupted run can leave a pull request already open for this head; adopt it.
    if (!/\(422\)/.test(error.message)) throw error;
    const open = await gh(fetcher, `/repos/${settings.org}/${name}/pulls?head=${encodeURIComponent(`${settings.org}:${branch}`)}&state=open`, token, undefined, controls);
    pull = Array.isArray(open) ? open[0] : null;
    if (!pull) throw error;
  }
  if (!Number.isInteger(pull?.number)) throw new Error(`Opening a pull request on ${name} did not return a pull number.`);
  let merged; let mergeError;
  // "Base branch was modified" is GitHub reporting its own view of main as momentarily stale right
  // after the branch was created. It resolves on its own, so retry briefly rather than failing the step.
  const sleep = controls.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      merged = await gh(fetcher, `/repos/${settings.org}/${name}/pulls/${pull.number}/merge`, token, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash', commit_title: title }) }, controls);
      mergeError = undefined; break;
    } catch (error) {
      mergeError = error;
      if (!/Base branch was modified|\(405\)|\(409\)/.test(error.message) || attempt === 3) break;
      await sleep(controls.mergeRetryMs ?? 3000);
    }
  }
  if (mergeError) throw new Error(`Squash-merging ${name}#${pull.number} failed: ${mergeError.message}. The step stops here; it never falls back to committing directly to main.`);
  if (!merged?.merged || !merged.sha) throw new Error(`Pull request ${name}#${pull.number} did not report a completed squash merge.`);
  await gh(fetcher, `/repos/${settings.org}/${name}/git/refs/heads/${branch}`, token, { method: 'DELETE' }, controls);
  return { commitSha: merged.sha, parentSha, pullNumber: pull.number };
}
export function stepsThrough(steps, targetId) {
  const index = steps.findIndex((step) => step.id === targetId);
  if (index < 0) throw new Error(`Unknown scenario step: ${targetId}`);
  return steps.slice(0, index + 1);
}
export async function reconcileStep(fetcher, env, scenario, targetId, controls = {}) {
  const settings = settingsFor(env); requireConfirmation(controls.confirmation, settings.project); const t = tokensFor('reconcile', env);
  const requestControls = controls.request || {};
  const through = stepsThrough(scenario.steps, targetId);
  const step = through.at(-1);
  const compiled = compileScenario({ ...scenario, steps: through });
  const byKey = new Map(scenario.services.services.map((service) => [service.key, service]));
  const created = []; const adopted = [];
  const introduce = step.introduceServices || [];
  const update = step.updateServices || [];
  const total = introduce.length + update.length; let completed = 0;
  for (const key of introduce) {
    const service = byKey.get(key);
    if (!service) throw new Error(`Refusing a repository outside the service catalog: ${key}`);
    const existing = await repositoryIfPresent(fetcher, t.GH_RESET_TOKEN, settings, key, requestControls);
    if (existing) {
      const marker = await readOwnershipMarker(fetcher, t.GH_RESET_TOKEN, settings, key, requestControls);
      if (!marker || marker.scenarioId !== compiled.scenarioId || marker.service !== key) {
        throw new Error(`Repository ${settings.org}/${key} already exists without this scenario's ownership marker. That is drift, not a resource to reuse; resolve it before reapplying.`);
      }
      adopted.push({ service: key, repositoryId: existing.id ?? null, nodeId: existing.node_id ?? null });
    } else {
      const references = (step.sourceReferences || {})[key] || [];
      const source = catalogSource(key, references, compiled.scenarioId, service.template, (step.releaseTags || {})[key] || "v001", clusterTopologyFor(scenario.sandbox.environments), settings.org);
      const result = await commitInitialSource(fetcher, t.GH_RESET_TOKEN, settings, key, source, requestControls);
      const version = (step.releaseTags || {})[key];
      const tag = version ? `${key}-${version}` : null;
      if (tag) await gh(fetcher, `/repos/${settings.org}/${key}/git/refs`, t.GH_RESET_TOKEN, { method: 'POST', body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: result.commitSha }) }, requestControls);
      created.push({ service: key, ...result, tag, references, firstPushAt: new Date().toISOString() });
    }
    completed += 1;
    if (controls.onProgress) await controls.onProgress({ completed, total, label: existing ? `Adopted repository ${key}` : `Created repository ${key}` });
  }
  const updated = [];
  for (const key of update) {
    const service = byKey.get(key);
    if (!service) throw new Error(`Refusing a repository outside the service catalog: ${key}`);
    const marker = await readOwnershipMarker(fetcher, t.GH_RESET_TOKEN, settings, key, requestControls);
    if (marker) {
      if (marker.scenarioId !== compiled.scenarioId || marker.service !== key) throw new Error(`Repository ${settings.org}/${key} carries a foreign ownership marker; refusing to fast-forward it.`);
    } else {
      // The three pre-campaign repositories were created before ownership markers existed.
      // Their identity evidence is the repository id captured in campaign.json at baseline,
      // and this very update is what gives them a marker from here on.
      const recorded = (controls.campaign?.repositories || []).find((repository) => repository.name === key);
      if (service.cohort !== 'pre-campaign' || !recorded) throw new Error(`Repository ${settings.org}/${key} is not marked as owned by this scenario; refusing to fast-forward it.`);
      const remote = await repositoryIfPresent(fetcher, t.GH_RESET_TOKEN, settings, key, requestControls);
      if (!remote || remote.id !== recorded.id) throw new Error(`Repository ${settings.org}/${key} does not match the repository id recorded at campaign baseline; continuity is lost, refusing to fast-forward it.`);
    }
    const references = compiled.services.find((item) => item.key === key)?.references || [];
    const version = (step.releaseTags || {})[key] || 'v001';
    const tag = `${key}-${version}`;
    const already = await refIfPresent(fetcher, t.GH_RESET_TOKEN, settings, key, `tags/${tag}`, requestControls);
    if (already) {
      updated.push({ service: key, tag, commitSha: already.object?.sha ?? null, alreadyApplied: true });
    } else {
      const source = catalogSource(key, references, compiled.scenarioId, service.template, version, clusterTopologyFor(scenario.sandbox.environments), settings.org);
      const title = `${step.id}: advance ${key} to ${version}`;
      const body = [
        step.title || '',
        '',
        `Scenario ${compiled.scenarioId}, step ${step.id}, release ${version}.`,
        references.length ? `Flags referenced by this release: ${references.join(', ')}.` : 'This release references no flags.',
        '',
        'Generated by the scenario reconciler. Synthetic content; no production system is involved.'
      ].join('\n');
      const result = await mergeSourceViaPullRequest(fetcher, t.GH_RESET_TOKEN, settings, key, source, { branch: `scenario/${step.id}-${key}`, title, body }, requestControls);
      await gh(fetcher, `/repos/${settings.org}/${key}/git/refs`, t.GH_RESET_TOKEN, { method: 'POST', body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: result.commitSha }) }, requestControls);
      updated.push({ service: key, ...result, tag, references });
    }
    completed += 1;
    if (controls.onProgress) await controls.onProgress({ completed, total, label: `${already ? 'Already at' : 'Fast-forwarded'} ${key} ${version}` });
  }
  const targeted = (step.targeting || []).length
    ? await applyTargeting(fetcher, t.LD_RESET_TOKEN, settings, step.targeting, {
        request: requestControls,
        onTargeting: (entry) => controls.onProgress?.({ completed: total, total: total || 1, label: `Targeting ${entry.flag} in ${entry.environment}: ${entry.state}, serving ${entry.serve}${entry.clusters.length ? `, clusters ${entry.clusters.join(', ')}` : ''}` })
      })
    : [];
  return { step: step.id, checksum: compiled.checksum, created, adopted, updated, targeted, distribution: compiled.distribution };
}
export async function scenarioStatus(fetcher, env, scenario, controls = {}) {
  const settings = settingsFor(env); const t = tokensFor('scenario', env);
  const requestControls = controls.request || {};
  const compiled = compileScenario(scenario);
  const today = controls.today || new Date().toISOString().slice(0, 10);
  // Status never searches. It reads the index evidence recorded by "scenario index" out of
  // campaign.json, so showing the column costs no code-search budget and, more importantly,
  // cannot touch the index of a repository the experiment deliberately leaves alone.
  const recorded = new Map(((controls.campaign?.indexing || controls.index)?.repositories || []).map((row) => [row.name, row]));
  const skipped = new Map(scenario.services.services.map((service) => [service.key, service.skipIndexingCheck === true]));
  const repositories = [];
  for (const service of compiled.services) {
    const remote = await repositoryIfPresent(fetcher, t.GH_DEMO_TOKEN, settings, service.key, requestControls);
    repositories.push({
      key: service.key, present: Boolean(remote), tag: service.tag, expectedReferences: service.references,
      index: indexStateFor({ ...recorded.get(service.key), skipped: skipped.get(service.key) === true })
    });
  }
  const listed = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, t.LD_DEMO_TOKEN, undefined, requestControls);
  const present = new Set((Array.isArray(listed.items) ? listed.items : []).map((item) => item.key));
  const missingFlags = scenario.catalog.flags.map((flag) => flag.key).filter((key) => !present.has(key));
  const steps = scenario.steps.map((step) => {
    const elapsed = dayNumber(today) - dayNumber(step.recommendedDate);
    return { id: step.id, recommendedDate: step.recommendedDate, cadence: step.cadence, overdueDays: elapsed > 0 ? elapsed : 0, dueToday: elapsed === 0, future: elapsed < 0 };
  });
  return { checksum: compiled.checksum, today, repositories, missingFlags, steps };
}
// GitHub does not index a repository until something searches it. An organization-wide code
// search answers incomplete_results: false — which reads as authoritative — while an entire
// repository is missing from the index: demo-express-returns sits in demo-shipping/app.mjs on
// main, and "demo-express-returns org:<org>" still returned total_count 0, incomplete_results
// false. The reliable detector is a per-repository probe: search a common token scoped with
// repo:<org>/<name> and read incomplete_results. true means GitHub could not search that
// repository (not indexed); false means the index answered for it (indexed).
export const INDEX_STATES = { indexed: 'indexed', indexing: 'INDEXING', notIndexed: 'not indexed', skipped: 'skipped (deliberate)' };
export const CODE_SEARCH_LIMIT_PER_MINUTE = 10;
export const CODE_SEARCH_MIN_INTERVAL_MS = Math.ceil(60_000 / CODE_SEARCH_LIMIT_PER_MINUTE);
export const INDEX_PROBE_ATTEMPTS = 3;
export const INDEX_PROBE_ROUND_DELAY_MS = 30_000;
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Measured: code_search allows 10 requests per minute, search 30, core (Contents) 5000 per hour.
// request() already retries a 429 with backoff; pacing is what keeps us from earning one.
function codeSearchPacer(controls = {}) {
  const sleep = controls.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = controls.now || Date.now;
  const interval = controls.codeSearchIntervalMs ?? CODE_SEARCH_MIN_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval < 0) throw new Error('Invalid code-search pacing interval.');
  let previous = null;
  return async () => {
    if (previous !== null) { const wait = interval - (now() - previous); if (wait > 0) await sleep(wait); }
    previous = now();
  };
}
export function indexProbeQuery(org, name) {
  if (!REPOSITORY_NAME.test(org || '') || !REPOSITORY_NAME.test(name || '')) throw new Error('Refusing an unsafe identifier in a code-search query.');
  return `import repo:${org}/${name}`;
}
export function indexManualAction(org, name, probes = 0) {
  const query = indexProbeQuery(org, name);
  return `MANUAL ACTION REQUIRED: ${org}/${name} is still absent from the code index after ${probes} probe(s). Open https://github.com/search?type=code&q=${encodeURIComponent(query)} and run this query in the GitHub web UI: ${query}`;
}
export async function probeRepositoryIndex(fetcher, token, settings, name, controls) {
  const query = indexProbeQuery(settings.org, name);
  const result = await gh(fetcher, `/search/code?q=${encodeURIComponent(query)}&per_page=1`, token, undefined, controls);
  if (typeof result?.incomplete_results !== 'boolean') throw new Error(`Malformed code-search evidence for ${settings.org}/${name}.`);
  return { name, query, indexed: result.incomplete_results === false, totalCount: Number.isInteger(result.total_count) ? result.total_count : null };
}
export function indexTargets(scenario) {
  const compiled = compileScenario(scenario);
  const declared = new Map(scenario.services.services.map((service) => [service.key, service]));
  return compiled.services.map((service) => ({ name: service.key, template: declared.get(service.key)?.template || 'nodejs', skipped: declared.get(service.key)?.skipIndexingCheck === true }));
}
export function indexStateFor(record) {
  if (record?.skipped) return INDEX_STATES.skipped;
  if (record?.firstIndexedAt) return INDEX_STATES.indexed;
  if (record?.indexRequestedAt) return INDEX_STATES.indexing;
  return INDEX_STATES.notIndexed;
}
export function unindexedRepositories(indexing, targets) {
  const recorded = new Map((indexing?.repositories || []).map((row) => [row.name, row]));
  return targets.filter((target) => !target.skipped && indexStateFor({ ...recorded.get(target.name), skipped: false }) !== INDEX_STATES.indexed).map((target) => target.name);
}
export async function warmRepositoryIndex(fetcher, env, scenario, controls = {}) {
  const settings = settingsFor(env); const t = tokensFor('scenario', env);
  const requestControls = controls.request || {};
  const now = controls.now || Date.now; const at = () => new Date(now()).toISOString();
  const sleep = controls.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pace = codeSearchPacer({ ...controls, sleep, now });
  const attempts = controls.attempts ?? INDEX_PROBE_ATTEMPTS;
  const roundDelayMs = controls.roundDelayMs ?? INDEX_PROBE_ROUND_DELAY_MS;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Index warming needs at least one attempt.');
  const pushed = controls.firstPushAt || {};
  const rows = new Map();
  for (const target of indexTargets(scenario)) {
    // A skipIndexingCheck repository is a control in the indexing experiment: the open question
    // is whether API probing alone triggers indexing or only the web UI does. It is therefore
    // never named in any request — not probed, not retried, not even paced for. Ignoring the
    // answer would not do, because issuing the request is the treatment under test.
    rows.set(target.name, {
      name: target.name, skipped: target.skipped, state: target.skipped ? INDEX_STATES.skipped : INDEX_STATES.notIndexed,
      firstPushAt: pushed[target.name] || null, indexRequestedAt: null, firstIndexedAt: null, probes: 0, totalCount: null,
      query: target.skipped ? null : indexProbeQuery(settings.org, target.name)
    });
  }
  const pending = [...rows.values()].filter((row) => !row.skipped).map((row) => row.name);
  let searches = 0;
  for (let attempt = 1; attempt <= attempts && pending.length; attempt += 1) {
    for (const name of [...pending]) {
      const row = rows.get(name);
      await pace();
      searches += 1; row.probes += 1; row.indexRequestedAt = row.indexRequestedAt || at();
      let probe;
      try { probe = await probeRepositoryIndex(fetcher, t.GH_DEMO_TOKEN, settings, name, requestControls); }
      catch (error) { row.error = redact(error, [t.GH_DEMO_TOKEN]); if (controls.onProbe) await controls.onProbe({ ...row, attempt }); continue; }
      delete row.error; row.totalCount = probe.totalCount;
      if (probe.indexed) { row.firstIndexedAt = row.firstIndexedAt || at(); row.state = INDEX_STATES.indexed; pending.splice(pending.indexOf(name), 1); }
      else row.state = INDEX_STATES.indexing;
      if (controls.onProbe) await controls.onProbe({ ...row, attempt });
    }
    if (pending.length && attempt < attempts) await sleep(roundDelayMs);
  }
  const repositories = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  // A repository that never flipped is never reported as fine. The window expiring is a result
  // that needs a human and an exact query, not a silent pass.
  const manualActions = repositories.filter((row) => !row.skipped && !row.firstIndexedAt).map((row) => indexManualAction(settings.org, row.name, row.probes));
  return {
    probedAt: at(), attempts, searches, repositories, manualActions,
    indexed: repositories.filter((row) => row.firstIndexedAt).map((row) => row.name),
    unresolved: repositories.filter((row) => !row.skipped && !row.firstIndexedAt).map((row) => row.name),
    skipped: repositories.filter((row) => row.skipped).map((row) => row.name)
  };
}
export function mergeIndexObservations(previous, observed) {
  if (!observed) return previous || undefined;
  const before = new Map((previous?.repositories || []).map((row) => [row.name, row]));
  const merged = (observed.repositories || []).map((row) => {
    const earlier = before.get(row.name) || {};
    // These three are first-observation facts. A later run never overwrites them, or the interval
    // between push, first search request, and first indexed answer stops meaning anything.
    const record = {
      ...row, firstPushAt: earlier.firstPushAt || row.firstPushAt || null,
      indexRequestedAt: earlier.indexRequestedAt || row.indexRequestedAt || null,
      firstIndexedAt: earlier.firstIndexedAt || row.firstIndexedAt || null
    };
    return { ...record, state: indexStateFor(record) };
  });
  const names = new Set(merged.map((row) => row.name));
  const carried = (previous?.repositories || []).filter((row) => !names.has(row.name));
  return { ...observed, repositories: [...merged, ...carried].sort((a, b) => a.name.localeCompare(b.name)) };
}
export function campaignWithIndexing(previous, indexing) {
  if (!previous || typeof previous !== 'object' || typeof previous.capturedAt !== 'string') throw new Error('Index evidence needs an existing campaign record; run "node demo.mjs baseline" first.');
  return mergeCampaign(previous, { ...previous, indexing });
}
// TRUTH. Read the source directly: the Contents API is 5000 requests per hour, serves the default
// branch when no ref is given, and is completely independent of the code index. This half of the
// audit is exact, which is precisely what search cannot promise.
export const ENTRY_FILES = { nodejs: 'app.mjs', typescript: 'app.ts', go: 'main.go', python: 'app.py' };
export function entryFileFor(template) {
  const file = ENTRY_FILES[template];
  if (!file) throw new Error(`No entry file is defined for template "${String(template)}".`);
  return file;
}
export function flagKeysInSource(source, keys) {
  const text = String(source || '');
  // Whole-key matching, so demo-cart never collects the evidence belonging to demo-cart-v2.
  return keys.filter((key) => new RegExp(`(?<![A-Za-z0-9._-])${String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`).test(text)).sort();
}
export async function readFlagTruth(fetcher, token, settings, repositories, keys, controls = {}) {
  const requestControls = controls.request || {};
  const rows = [];
  for (const repository of repositories) {
    const file = entryFileFor(repository.template);
    const row = { name: repository.name, path: file, template: repository.template, skipped: repository.skipped === true, read: false, keys: [], lastCommit: null };
    try {
      const contents = await gh(fetcher, `/repos/${settings.org}/${repository.name}/contents/${file}`, token, undefined, requestControls);
      if (typeof contents?.content !== 'string') throw new Error(`Malformed contents evidence for ${repository.name}/${file}.`);
      row.read = true; row.keys = flagKeysInSource(Buffer.from(contents.content, 'base64').toString('utf8'), keys);
    } catch (error) { row.error = redact(error, [token]); rows.push(row); continue; }
    try {
      const commits = await gh(fetcher, `/repos/${settings.org}/${repository.name}/commits?path=${encodeURIComponent(file)}&per_page=1`, token, undefined, requestControls);
      row.lastCommit = Array.isArray(commits) ? commits[0]?.commit?.committer?.date ?? null : null;
    } catch (error) { row.error = redact(error, [token]); }
    rows.push(row);
  }
  const byFlag = new Map(keys.map((key) => [key, []]));
  for (const row of rows) for (const key of row.keys) byFlag.get(key).push({ repo: row.name, path: row.path, commit: row.lastCommit });
  return { repositories: rows, byFlag, unreadable: rows.filter((row) => !row.read).map((row) => row.name) };
}
// EVIDENCE. The organization-wide code search, kept strictly separate from truth and run only
// where a zero-reference claim is at stake. Its answer is index-dependent and therefore never
// authoritative on its own.
export async function searchFlagEvidence(fetcher, token, settings, key, controls = {}) {
  const query = `${key} org:${settings.org}`;
  const result = await gh(fetcher, `/search/code?q=${encodeURIComponent(query)}&per_page=100`, token, undefined, controls.request);
  const items = Array.isArray(result?.items) ? result.items : [];
  const total = Number.isInteger(result?.total_count) ? result.total_count : null;
  return {
    query, totalCount: total, incomplete: result?.incomplete_results === true,
    capped: total !== null && total > items.length,
    files: items.filter((item) => item.repository?.owner?.login === settings.org).map((item) => ({ repo: item.repository?.name ?? null, path: item.path ?? null }))
  };
}
// One code-search request instead of one per flag: every generated evaluator calls boolVariation,
// so a single organization-scoped token sweep lists every file the index can see at all, and the
// repositories missing from that list are the ones search is blind to.
//
// This is a rate-limit workaround for THIS synthetic repository set, where one SDK method, one
// variation type, and literal inline keys are guaranteed because a generator wrote every file.
// It is NOT a general technique for finding flag references in real code: real code uses
// non-boolean variations, several SDK methods, in-house wrappers, and keys assembled at runtime,
// and a single-token sweep silently misses all of them.
export async function sweepEvaluationSites(fetcher, token, settings, controls = {}) {
  const query = `boolVariation org:${settings.org}`;
  const result = await gh(fetcher, `/search/code?q=${encodeURIComponent(query)}&per_page=100`, token, undefined, controls.request);
  const items = Array.isArray(result?.items) ? result.items : [];
  const files = items.filter((item) => item.repository?.owner?.login === settings.org).map((item) => ({ repo: item.repository?.name ?? null, path: item.path ?? null }));
  return { query, totalCount: Number.isInteger(result?.total_count) ? result.total_count : null, incomplete: result?.incomplete_results === true, files, repositories: [...new Set(files.map((file) => file.repo))].sort() };
}
export const AUDIT_RESULTS = { referenced: 'REFERENCED', stale: 'STALE CANDIDATE', dead: 'DEAD CANDIDATE', unknown: 'UNKNOWN', disagreement: 'DISAGREEMENT' };
export async function audit(fetcher, env, controls = {}) {
  const t = tokensFor('audit', env); const settings = settingsFor(env); assertScope({ ...settings }); await checkLaunchDarkly(fetcher, t.LD_DEMO_TOKEN, settings, true);
  const requestControls = controls.request || {};
  const listed = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, t.LD_DEMO_TOKEN, undefined, requestControls);
  if (!Array.isArray(listed.items)) throw new Error('Malformed LaunchDarkly flag evidence.');
  const keys = listed.items.map((item) => item.key).filter((key) => typeof key === 'string').sort();
  const targets = controls.scenario ? indexTargets(controls.scenario) : REPOS.map((name) => ({ name, template: 'nodejs', skipped: false }));
  const truth = await readFlagTruth(fetcher, t.GH_DEMO_TOKEN, settings, targets, keys, { request: requestControls });
  // The skip list governs the code index only. Reading a control repository's source over the
  // Contents API is a different subsystem and does not disturb the experiment — and it is what
  // keeps a flag whose only caller is a control repository from ever looking dead.
  const unindexed = unindexedRepositories(controls.index, targets);
  const claims = keys.filter((key) => !(truth.byFlag.get(key) || []).length);
  const crossCheck = (controls.crossCheck || []).filter((key) => keys.includes(key));
  const searched = [...new Set([...claims, ...crossCheck])].sort();
  const pace = codeSearchPacer(controls);
  const evidence = new Map();
  const sweep = controls.sweep ? await (async () => { await pace(); try { return await sweepEvaluationSites(fetcher, t.GH_DEMO_TOKEN, settings, { request: requestControls }); } catch (error) { return { error: redact(error, [t.GH_DEMO_TOKEN]) }; } })() : null;
  for (const key of searched) {
    await pace();
    try { evidence.set(key, await searchFlagEvidence(fetcher, t.GH_DEMO_TOKEN, settings, key, { request: requestControls })); }
    catch (error) { evidence.set(key, { query: `${key} org:${settings.org}`, error: redact(error, [t.GH_DEMO_TOKEN]), files: [], totalCount: null, incomplete: true }); }
  }
  const blockers = [
    ...(unindexed.length ? [`${unindexed.length} managed repository(ies) are not known to be in the code index (${unindexed.join(', ')})`] : []),
    ...(truth.unreadable.length ? [`source could not be read for ${truth.unreadable.join(', ')}`] : [])
  ];
  const refusal = blockers.length ? `Zero-reference claims refused: ${blockers.join('; ')}. Run "node demo.mjs scenario index", then re-run the audit.` : null;
  const rows = keys.map((key) => {
    const files = truth.byFlag.get(key) || [];
    const found = evidence.get(key) || null;
    const searchFiles = (found?.files || []).filter((file) => targets.some((target) => target.name === file.repo));
    const row = { key, truth: { files, result: files.length ? outcome({ files, complete: true }) : null }, evidence: found ? { ...found, managedFiles: searchFiles } : null, disagreement: null, refused: null, result: AUDIT_RESULTS.unknown };
    if (files.length) {
      row.result = row.truth.result;
      // Both directions are reported, and neither side is silently preferred: truth is exact,
      // so it wins the archive decision, but a search that cannot see a file we just read is
      // itself the finding.
      if (found && !found.error && !searchFiles.length) row.disagreement = { kind: 'search-under-reports', detail: `Source contains ${key} in ${files.map((file) => `${file.repo}/${file.path}`).join(', ')}, and the organization-wide search returned ${found.totalCount ?? 0} match(es) with incomplete_results ${found.incomplete}. The index, not the code, is what changed.` };
      return row;
    }
    if (found?.error || found?.incomplete || found?.capped) { row.result = AUDIT_RESULTS.unknown; row.refused = found.error || 'The organization-wide search answered incompletely.'; return row; }
    if (searchFiles.length) {
      row.result = AUDIT_RESULTS.disagreement;
      row.disagreement = { kind: 'truth-missed-a-reference', detail: `No entry file declares ${key}, but the organization-wide search found it in ${searchFiles.map((file) => `${file.repo}/${file.path}`).join(', ')}. Something references the flag outside the file the audit reads; resolve before archiving.` };
      return row;
    }
    if (refusal) { row.result = AUDIT_RESULTS.unknown; row.refused = refusal; return row; }
    row.result = AUDIT_RESULTS.dead;
    return row;
  });
  return {
    rows, truth: { repositories: truth.repositories, unreadable: truth.unreadable },
    index: { unindexed, refusal, skipped: targets.filter((target) => target.skipped).map((target) => target.name) },
    searched, sweep,
    disagreements: rows.filter((row) => row.disagreement).map((row) => ({ key: row.key, ...row.disagreement })),
    manualActions: unindexed.map((name) => indexManualAction(settings.org, name))
  };
}
