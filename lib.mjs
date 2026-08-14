import fs from 'node:fs';
import path from 'node:path';
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
    doctor: ['GH_DEMO_TOKEN', 'GH_RESET_TOKEN', 'LD_DEMO_TOKEN', 'LD_RESET_TOKEN'],
    recreate: ['GH_RESET_TOKEN', 'LD_RESET_TOKEN'],
    destroy: ['GH_RESET_TOKEN', 'LD_RESET_TOKEN']
  };
  const names = namesByCommand[command];
  if (!names) throw new Error('Unknown command token boundary.');
  const result = {};
  for (const name of names) { if (!env[name]) throw new Error(`Missing required environment variable: ${name}`); result[name] = env[name]; }
  return result;
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
function evaluatorSource(repository, flags) {
  return `import * as LaunchDarkly from '@launchdarkly/node-server-sdk';
import { batchSize, contextForOneShot, contextForTraffic } from './traffic.mjs';

const repository = '${repository}';
const flags = ${JSON.stringify(flags)};
const defaults = { contextKey: 'demo-user', plan: 'free', region: 'eu', cohort: 'control', instance: 'LOCAL1', evaluations: 10, profile: 'production', intervalSeconds: 300, traffic: false };
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
let stopRequested = false; let wake;

function optionsFrom(argv) {
  const options = { ...defaults };
  const names = new Map([['--context-key', 'contextKey'], ['--plan', 'plan'], ['--region', 'region'], ['--cohort', 'cohort'], ['--instance', 'instance'], ['--evaluations', 'evaluations'], ['--profile', 'profile'], ['--interval-seconds', 'intervalSeconds']]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--traffic') { options.traffic = true; continue; }
    const property = names.get(name); const value = argv[index + 1];
    if (!property || value === undefined) throw new Error('Unknown or incomplete argument.');
    if (property === 'intervalSeconds') {
      if (!/^\\d+$/.test(value) || Number(value) < 10 || Number(value) > 86400) throw new Error('Interval must be from 10 to 86400 seconds.');
      options.intervalSeconds = Number(value);
    } else if (property === 'evaluations') {
      if (!/^\\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000) throw new Error('Evaluations must be from 1 to 1000.');
      options.evaluations = Number(value);
    } else {
      if (!safeIdentifier.test(value)) throw new Error('Arguments must be safe non-empty identifiers.');
      options[property] = value;
    }
    index += 1;
  }
  if (!['production', 'staging', 'test', 'dev'].includes(options.profile)) throw new Error('Unknown traffic profile.');
  return options;
}

function wait(ms) {
  return new Promise((resolve) => {
    if (stopRequested) { resolve(); return; }
    let timer; const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
    timer = setTimeout(finish, ms); wake = finish;
  });
}
async function evaluate(client, context) {
  for (const flag of flags) console.log(JSON.stringify({ repository, flag, value: await client.boolVariation(flag, context, false), context }));
}

async function main() {
  const sdkKey = process.env.LD_EVALUATION_SDK_KEY;
  if (!sdkKey) throw new Error('LD_EVALUATION_SDK_KEY is required.');
  const options = optionsFrom(process.argv.slice(2));
  const client = LaunchDarkly.init(sdkKey);
  const stop = () => { stopRequested = true; if (wake) wake(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await client.waitForInitialization({ timeout: 10 });
    if (!options.traffic) for (let index = 0; index < options.evaluations; index += 1) await evaluate(client, contextForOneShot(repository, options, index));
    else {
      let index = 0;
      while (!stopRequested) {
        const count = batchSize(options.profile, new Date());
        for (let item = 0; item < count && !stopRequested; item += 1) { await evaluate(client, contextForTraffic(repository, options.profile, index)); index += 1; }
        await client.flush();
        if (!stopRequested) await wait(options.intervalSeconds * 1000);
      }
    }
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await client.flush();
    await client.close();
  }
}

main().catch(() => { console.error('Error: evaluator failed.'); process.exitCode = 1; });
`;
}
function trafficSource() {
  return `const profiles = {
  production: { enterprise: 10, beta: 15, legacy: 8, busy: 100, quiet: 40, instances: ['WestEU1', 'WestEU1', 'WestEU1', 'WestEU1', 'WestEU1', 'EMEA4', 'EMEA4', 'EMEA4', 'SouthAM2', 'SouthAM2'] },
  staging: { enterprise: 20, beta: 30, legacy: 20, busy: 30, quiet: 12, instances: ['STG1', 'STG1', 'STG2'] },
  test: { enterprise: 30, beta: 35, legacy: 30, busy: 10, quiet: 4, instances: ['TEST1', 'TEST2'] },
  dev: { enterprise: 15, beta: 25, legacy: 12, busy: 2, quiet: 1, instances: ['DEV1'] }
};
const offsets = { 'demo-orders': 11, 'demo-storefront': 43, 'demo-profile': 71 };

export function contextForOneShot(repository, options, index) {
  if (!Object.hasOwn(offsets, repository) || !Number.isSafeInteger(options?.evaluations) || options.evaluations < 1 || !Number.isSafeInteger(index) || index < 0 || index >= options.evaluations) throw new Error('Invalid one-shot input.');
  const key = options.evaluations === 1 ? options.contextKey : options.contextKey + '-' + String(index + 1).padStart(3, '0');
  return { kind: 'user', key, service: repository, instance: options.instance, plan: options.plan, region: options.region, cohort: options.cohort };
}

export function contextForTraffic(repository, profile, index) {
  const settings = profiles[profile];
  if (!settings || !Object.hasOwn(offsets, repository) || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid traffic input.');
  const bucket = (index * 37 + offsets[repository]) % 100;
  const context = { kind: 'user', key: [repository, profile, index % 10000].join('-'), service: repository, instance: settings.instances[index % settings.instances.length], plan: 'free', region: 'eu', cohort: 'control' };
  if (repository === 'demo-profile') { if (bucket < settings.legacy) context.region = 'legacy'; }
  else if (bucket < settings.enterprise) context.plan = 'enterprise';
  else if (bucket < settings.enterprise + settings.beta) context.cohort = 'checkout-beta';
  return context;
}

export function batchSize(profile, at) {
  const settings = profiles[profile];
  if (!settings || !(at instanceof Date) || Number.isNaN(at.valueOf())) throw new Error('Invalid traffic schedule input.');
  const day = at.getUTCDay(); const hour = at.getUTCHours(); const businessHours = day >= 1 && day <= 5 && hour >= 7 && hour < 19;
  return businessHours ? settings.busy : settings.quiet;
}
`;
}
function repositoryFiles(repository, flags) {
  return [
    { path: 'package.json', content: `${JSON.stringify({ name: repository, private: true, type: 'module', scripts: { evaluate: 'node app.mjs', traffic: 'node app.mjs --traffic' }, dependencies: { '@launchdarkly/node-server-sdk': '^9.0.0' } }, null, 2)}\n` },
    { path: 'app.mjs', content: evaluatorSource(repository, flags) },
    { path: 'traffic.mjs', content: trafficSource() },
    { path: 'Dockerfile', content: "FROM node:24-alpine\nENV NPM_CONFIG_UPDATE_NOTIFIER=false\nWORKDIR /app\nCOPY package.json ./\nRUN npm install --omit=dev\nCOPY app.mjs traffic.mjs ./\nUSER node\nCMD [\"npm\", \"run\", \"traffic\"]\n" },
    { path: '.gitignore', content: 'node_modules/\n.env\n' },
    { path: 'README.md', content: `# ${repository} synthetic evaluator\n\nRun \`npm install\`, set \`LD_EVALUATION_SDK_KEY\`, then use \`npm run evaluate -- --cohort checkout-beta\` for a ten-evaluation one-shot batch or \`npm run traffic -- --profile production\` for cumulative traffic. One-shot count can be changed with \`--evaluations\`; synthetic deployment can be set with \`--instance\`. Stop traffic with Ctrl+C so pending events flush.\n` }
  ];
}
export const SOURCES = {
  'demo-orders': { files: repositoryFiles('demo-orders', ['demo-checkout-rollout']), date: null },
  'demo-storefront': { files: repositoryFiles('demo-storefront', ['demo-checkout-rollout']), date: null },
  'demo-profile': { files: repositoryFiles('demo-profile', ['demo-legacy-profile']), date: '2020-01-02T03:04:05Z' }
};
export async function createRepositoryWithSource(fetcher, token, settings, name, source, controls) {
  assertScope({ ...settings, repos: [name, ...REPOS.filter((x) => x !== name)] });
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
}
function variationId(flag, value) {
  const variation = flag?.variations?.find((entry) => entry.value === value);
  if (!variation?._id) throw new Error(`Created flag ${flag?.key || 'unknown'} has no ${value} variation ID.`);
  return variation._id;
}
function rule(attribute, value, variationId) {
  return { kind: 'addRule', clauses: [{ contextKind: 'user', attribute, op: 'in', negate: false, values: [value] }], variationId };
}
export async function createProject(fetcher, token, settings, controls) {
  assertScope(settings);
  const project = await ld(fetcher, '/api/v2/projects', token, { method: 'POST', body: JSON.stringify({ key: settings.project, name: 'Synthetic feature-flag clean-room demo', environments: ENVIRONMENTS }) }, controls);
  if (project.key !== settings.project) throw new Error('Created LaunchDarkly project key mismatch.');
  const environments = await ld(fetcher, `/api/v2/projects/${settings.project}/environments?limit=100`, token, undefined, controls);
  if (!Array.isArray(environments.items) || environments.items.length !== ENVIRONMENT_KEYS.length || environments.items.some((environment) => {
    const expected = ENVIRONMENTS.find((item) => item.key === environment.key);
    return !expected || environment.critical !== expected.critical;
  })) throw new Error('Created LaunchDarkly environments do not match the fixed demo scope and criticality.');
  return { project, environments: environments.items };
}
export async function prepareRuntime(settings, environments, controls = {}) {
  assertScope(settings);
  if (!Array.isArray(environments) || environments.length !== ENVIRONMENT_KEYS.length || environments.some((environment) => !ENVIRONMENT_KEYS.includes(environment.key) || typeof environment.apiKey !== 'string' || !environment.apiKey || /[\r\n]/.test(environment.apiKey))) throw new Error('LaunchDarkly SDK key evidence does not match the fixed runtime scope.');
  const fileSystem = controls.fileSystem || fs; const root = controls.root || process.cwd(); const runtime = runtimeDirectory(root); const repos = path.join(runtime, 'repos');
  const keyFile = path.join(runtime, 'sdk-keys.env');
  const clone = controls.clone || (async (url, target) => execFileAsync('git', ['clone', '--depth', '1', url, target], { cwd: root, windowsHide: true }));
  fileSystem.rmSync(repos, { recursive: true, force: true }); fileSystem.rmSync(keyFile, { force: true }); fileSystem.mkdirSync(repos, { recursive: true });
  const lines = ENVIRONMENT_KEYS.map((key) => {
    const environment = environments.find((item) => item.key === key); return `LD_EVALUATION_SDK_KEY_${key.toUpperCase()}=${environment.apiKey}`;
  });
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
export async function configureFlagTargeting(fetcher, token, settings, environment, flag, controls) {
  assertScope({ ...settings, flags: [flag?.key, ...FLAGS.filter((key) => key !== flag?.key)] });
  if (!ENVIRONMENT_KEYS.includes(environment)) throw new Error('Refusing an identifier outside the fixed disposable scope.');
  const enabled = variationId(flag, true); const disabled = variationId(flag, false);
  const instructions = [
    { kind: 'updateOffVariation', variationId: disabled },
    { kind: 'updateFallthroughVariationOrRollout', variationId: disabled }
  ];
  if (flag.key === 'demo-checkout-rollout') instructions.push({ kind: 'turnFlagOn' }, rule('cohort', 'checkout-beta', enabled), rule('plan', 'enterprise', enabled));
  else if (flag.key === 'demo-legacy-profile') instructions.push({ kind: 'turnFlagOn' }, rule('region', 'legacy', enabled));
  else if (flag.key === 'demo-retired-banner') instructions.push({ kind: 'turnFlagOff' });
  else throw new Error('Refusing an identifier outside the fixed disposable scope.');
  return ld(fetcher, `/api/v2/flags/${settings.project}/${flag.key}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; domain-model=launchdarkly.semanticpatch' },
    body: JSON.stringify({ environmentKey: environment, instructions })
  }, controls);
}
export async function recreate(fetcher, env, confirmation, controls = {}) {
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('recreate', env); assertScope({ ...settings });
  const total = 15; let completed = 0;
  const report = async (label) => { if (controls.onProgress) await controls.onProgress({ completed, total, label }); };
  const advance = async (label) => { completed += 1; await report(label); };
  const requestControls = { ...(controls.request || {}) };
  if (controls.onRateLimit) requestControls.onRateLimit = controls.onRateLimit;
  await report('Checking GitHub reset-token access');
  try { await checkGithub(fetcher, t.GH_RESET_TOKEN, settings, requestControls); } catch (error) { throw new Error(`GH_RESET_TOKEN GitHub authentication/read access failed: ${error.message}`); }
  await advance('Checking LaunchDarkly reset-token access');
  try { await checkLaunchDarkly(fetcher, t.LD_RESET_TOKEN, settings, false, requestControls); } catch (error) { throw new Error(`LD_RESET_TOKEN LaunchDarkly authentication/project-list access failed: ${error.message}`); }
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
  await advance(`Creating and configuring flag ${FLAGS[0]}`);
  for (let index = 0; index < FLAGS.length; index += 1) {
    const key = FLAGS[index];
    let flag;
    try { flag = await ld(fetcher, `/api/v2/flags/${settings.project}`, t.LD_RESET_TOKEN, { method: 'POST', body: JSON.stringify({ key, name: key, variations: [{ value: true }, { value: false }] }) }, requestControls); }
    catch (error) { throw new Error(`LD_RESET_TOKEN create flag ${settings.project}/${key} failed: ${error.message}`); }
    for (const environment of ENVIRONMENT_KEYS) try { await configureFlagTargeting(fetcher, t.LD_RESET_TOKEN, settings, environment, flag, requestControls); }
    catch (error) { throw new Error(`LD_RESET_TOKEN configure flag ${settings.project}/${key} in environment ${environment} failed: ${error.message}`); }
    await advance(index + 1 < FLAGS.length ? `Creating and configuring flag ${FLAGS[index + 1]}` : 'Preparing local runtime clones and SDK keys');
  }
  try { await (controls.prepareRuntime || prepareRuntime)(settings, createdProject.environments, controls.runtime); }
  catch (error) { throw new Error(`Prepare local runtime failed: ${error.message}`); }
  await advance('Recreate complete');
  return { deleted };
}
export async function destroy(fetcher, env, confirmation, controls = {}) {
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('destroy', env); assertScope({ ...settings }); const result = [];
  for (const name of REPOS) result.push([name, await removeIfPresent(fetcher, GH, `/repos/${settings.org}/${name}`, t.GH_RESET_TOKEN, `GH_RESET_TOKEN delete repository ${settings.org}/${name}`)]);
  result.push([settings.project, await removeIfPresent(fetcher, LD, `/api/v2/projects/${settings.project}`, t.LD_RESET_TOKEN, `LD_RESET_TOKEN delete project ${settings.project}`)]);
  (controls.cleanRuntime || cleanRuntime)(controls.runtimeRoot);
  return result;
}
export async function auditFlag(fetcher, token, settings, key) {
  const search = await gh(fetcher, `/search/code?q=${encodeURIComponent(`${key} org:${settings.org}`)}&per_page=100`, token);
  if (!search || search.incomplete_results || !Array.isArray(search.items) || search.total_count > search.items.length) return { files: [], complete: false, capped: true };
  const files = [];
  for (const item of search.items) {
    const repo = item.repository?.name;
    if (!REPOS.includes(repo) || item.repository?.owner?.login !== settings.org) continue;
    const info = await gh(fetcher, `/repos/${settings.org}/${repo}`, token); const branch = info.default_branch;
    const content = await gh(fetcher, `/repos/${settings.org}/${repo}/contents/${item.path}?ref=${encodeURIComponent(branch)}`, token);
    const decoded = Buffer.from(content.content || '', 'base64').toString('utf8');
    if (!decoded.includes(key)) continue;
    const commits = await gh(fetcher, `/repos/${settings.org}/${repo}/commits?path=${encodeURIComponent(item.path)}&sha=${encodeURIComponent(branch)}&per_page=1`, token);
    if (!Array.isArray(commits) || !commits[0]?.commit?.committer?.date) return { files: [], complete: false, malformed: true };
    files.push({ repo, path: item.path, commit: commits[0].commit.committer.date });
  }
  return { files, complete: true };
}
export async function audit(fetcher, env) {
  const t = tokensFor('audit', env); const settings = settingsFor(env); assertScope({ ...settings }); await checkLaunchDarkly(fetcher, t.LD_DEMO_TOKEN, settings, true);
  const listed = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, t.LD_DEMO_TOKEN);
  if (!Array.isArray(listed.items)) throw new Error('Malformed LaunchDarkly flag evidence.');
  const rows = [];
  for (const flag of listed.items.filter((f) => FLAGS.includes(f.key))) { let evidence; try { evidence = await auditFlag(fetcher, t.GH_DEMO_TOKEN, settings, flag.key); } catch { evidence = { files: [], complete: false, error: true }; }
    rows.push({ key: flag.key, files: evidence.files || [], result: outcome(evidence) }); }
  return rows;
}
