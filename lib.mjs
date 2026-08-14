export const ORG_ENV = 'GH_ORG';
export const PROJECT_ENV = 'LD_PROJECT_KEY';
export const REPOS = ['demo-orders', 'demo-storefront', 'demo-profile'];
export const FLAGS = ['demo-checkout-rollout', 'demo-legacy-profile', 'demo-retired-banner'];
export const ENVIRONMENTS = [
  { key: 'production', name: 'Production', color: 'D9534F' },
  { key: 'test', name: 'Test', color: '5BC0DE' },
  { key: 'staging', name: 'Staging', color: 'F0AD4E' },
  { key: 'dev', name: 'Dev', color: '5CB85C' }
];
const ENVIRONMENT_KEYS = ENVIRONMENTS.map((environment) => environment.key);
export const GH = 'https://api.github.com';
export const LD = 'https://app.launchdarkly.com';
const origins = new Set([GH, LD]);
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;

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
  const names = command === 'run' ? ['GH_DEMO_TOKEN', 'LD_DEMO_TOKEN'] : command === 'doctor'
    ? ['GH_DEMO_TOKEN', 'GH_RESET_TOKEN', 'LD_DEMO_TOKEN', 'LD_RESET_TOKEN']
    : ['GH_RESET_TOKEN', 'LD_RESET_TOKEN'];
  const result = {};
  for (const name of names) { if (!env[name]) throw new Error(`Missing required environment variable: ${name}`); result[name] = env[name]; }
  return result;
}
export function redact(value, secrets = []) {
  let text = String(value?.message || value || 'request failed');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\b(token|authorization)\s*=\s*[^\s,]+/ig, '$1=[REDACTED]');
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
    await sleep(delay);
  }
}
const gh = (fetcher, path, token, options) => request(fetcher, GH, path, token, options);
const ld = (fetcher, path, token, options) => request(fetcher, LD, path, token, options);
export async function checkGithub(fetcher, token, settings) {
  const user = await gh(fetcher, '/user', token); await gh(fetcher, `/orgs/${settings.org}`, token);
  const repos = await gh(fetcher, `/orgs/${settings.org}/repos?per_page=100`, token);
  if (!Array.isArray(repos)) throw new Error('Malformed GitHub repository evidence.');
  for (const repo of repos.filter((r) => REPOS.includes(r.name))) await gh(fetcher, `/repos/${settings.org}/${repo.name}`, token);
  return user.login || 'OK';
}
export async function checkLaunchDarkly(fetcher, token, settings, requireProject = false) {
  const projects = await ld(fetcher, '/api/v2/projects?limit=100', token);
  if (!Array.isArray(projects.items)) throw new Error('Malformed LaunchDarkly project evidence.');
  if (!requireProject) return 'OK';
  const project = await ld(fetcher, `/api/v2/projects/${settings.project}`, token);
  if (project.key !== settings.project) throw new Error('LaunchDarkly project key mismatch.');
  const flags = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, token);
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
export async function removeIfPresent(fetcher, base, path, token, label) {
  try { await request(fetcher, base, path, token, { method: 'DELETE' }); return 'deleted'; }
  catch (error) { if (/\(404\)/.test(error.message)) return 'already absent'; throw new Error(`${label} failed: ${error.message}`); }
}
export async function waitForRepositoryAbsence(fetcher, token, settings, name, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const label = `GH_RESET_TOKEN wait for repository removal ${settings.org}/${name}`;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try { await gh(fetcher, `/repos/${settings.org}/${name}`, token); }
    catch (error) { if (/\(404\)/.test(error.message)) return; throw new Error(`${label} failed: ${error.message}`); }
    if (attempt < 10) await sleep(1000);
  }
  throw new Error(`${label} failed: repository still exists after 10 seconds.`);
}
export async function waitForProjectAbsence(fetcher, token, settings, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const label = `LD_RESET_TOKEN wait for project removal ${settings.project}`;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try { await ld(fetcher, `/api/v2/projects/${settings.project}`, token); }
    catch (error) { if (/\(404\)/.test(error.message)) return; throw new Error(`${label} failed: ${error.message}`); }
    if (attempt < 10) await sleep(1000);
  }
  throw new Error(`${label} failed: project still exists after 10 seconds.`);
}
function evaluatorSource(repository, flags) {
  return `import * as LaunchDarkly from '@launchdarkly/node-server-sdk';

const repository = '${repository}';
const flags = ${JSON.stringify(flags)};
const defaults = { contextKey: 'demo-user', plan: 'free', region: 'eu', cohort: 'control' };
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function optionsFrom(argv) {
  const options = { ...defaults };
  const names = new Map([['--context-key', 'contextKey'], ['--plan', 'plan'], ['--region', 'region'], ['--cohort', 'cohort']]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1]; const property = names.get(name);
    if (!property || value === undefined || !safeIdentifier.test(value)) throw new Error('Arguments must be safe non-empty identifiers.');
    options[property] = value;
  }
  return options;
}

async function main() {
  const sdkKey = process.env.LD_EVALUATION_SDK_KEY;
  if (!sdkKey) throw new Error('LD_EVALUATION_SDK_KEY is required.');
  const options = optionsFrom(process.argv.slice(2));
  const context = { kind: 'user', key: options.contextKey, plan: options.plan, region: options.region, cohort: options.cohort };
  const client = LaunchDarkly.init(sdkKey);
  try {
    await client.waitForInitialization({ timeout: 10 });
    for (const flag of flags) console.log(JSON.stringify({ repository, flag, value: await client.boolVariation(flag, context, false), context }));
    await client.flush();
  } finally {
    await client.close();
  }
}

main().catch(() => { console.error('Error: evaluator failed.'); process.exitCode = 1; });
`;
}
function repositoryFiles(repository, flags) {
  return [
    { path: 'package.json', content: `${JSON.stringify({ name: repository, private: true, type: 'module', scripts: { evaluate: 'node app.mjs' }, dependencies: { '@launchdarkly/node-server-sdk': '^9.0.0' } }, null, 2)}\n` },
    { path: 'app.mjs', content: evaluatorSource(repository, flags) },
    { path: '.gitignore', content: 'node_modules/\n.env\n' },
    { path: 'README.md', content: `# ${repository} synthetic evaluator\n\nRun \`npm install\`, then set \`LD_EVALUATION_SDK_KEY\` and run \`npm run evaluate -- --cohort checkout-beta\`.\n` }
  ];
}
export const SOURCES = {
  'demo-orders': { files: repositoryFiles('demo-orders', ['demo-checkout-rollout']), date: null },
  'demo-storefront': { files: repositoryFiles('demo-storefront', ['demo-checkout-rollout']), date: null },
  'demo-profile': { files: repositoryFiles('demo-profile', ['demo-legacy-profile']), date: '2020-01-02T03:04:05Z' }
};
export async function createRepositoryWithSource(fetcher, token, settings, name, source) {
  assertScope({ ...settings, repos: [name, ...REPOS.filter((x) => x !== name)] });
  const repository = await gh(fetcher, `/orgs/${settings.org}/repos`, token, { method: 'POST', body: JSON.stringify({ name, private: false, auto_init: true, description: 'Synthetic feature-flag clean-room demo.' }) });
  const branch = repository.default_branch;
  if (!branch) throw new Error('Created repository has no default branch.');
  const ref = await gh(fetcher, `/repos/${settings.org}/${name}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  const parentSha = ref.object?.sha;
  if (!parentSha) throw new Error('Created repository has no initial commit reference.');
  const parent = await gh(fetcher, `/repos/${settings.org}/${name}/git/commits/${parentSha}`, token);
  if (!parent.tree?.sha) throw new Error('Created repository has incomplete initial commit evidence.');
  if (!Array.isArray(source.files) || !source.files.length) throw new Error('Synthetic source files are missing.');
  const entries = [];
  for (const file of source.files) {
    const blob = await gh(fetcher, `/repos/${settings.org}/${name}/git/blobs`, token, { method: 'POST', body: JSON.stringify({ content: file.content, encoding: 'utf-8' }) });
    if (!file.path || !blob.sha) throw new Error('Synthetic source blob is incomplete.');
    entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await gh(fetcher, `/repos/${settings.org}/${name}/git/trees`, token, { method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries }) });
  const stamp = source.date || new Date().toISOString();
  const who = { name: 'Synthetic Demo', email: 'synthetic-demo@example.invalid', date: stamp };
  const commit = await gh(fetcher, `/repos/${settings.org}/${name}/git/commits`, token, { method: 'POST', body: JSON.stringify({ message: 'Add synthetic feature-flag evidence', tree: tree.sha, parents: [parentSha], author: who, committer: who }) });
  await gh(fetcher, `/repos/${settings.org}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, token, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
}
function variationId(flag, value) {
  const variation = flag?.variations?.find((entry) => entry.value === value);
  if (!variation?._id) throw new Error(`Created flag ${flag?.key || 'unknown'} has no ${value} variation ID.`);
  return variation._id;
}
function rule(attribute, value, variationId) {
  return { kind: 'addRule', clauses: [{ contextKind: 'user', attribute, op: 'in', negate: false, values: [value] }], variationId };
}
export async function createProject(fetcher, token, settings) {
  assertScope(settings);
  const project = await ld(fetcher, '/api/v2/projects', token, { method: 'POST', body: JSON.stringify({ key: settings.project, name: 'Synthetic feature-flag clean-room demo', environments: ENVIRONMENTS }) });
  if (project.key !== settings.project) throw new Error('Created LaunchDarkly project key mismatch.');
  const environments = await ld(fetcher, `/api/v2/projects/${settings.project}/environments?limit=100`, token);
  if (!Array.isArray(environments.items) || environments.items.length !== ENVIRONMENT_KEYS.length || environments.items.some((environment) => !ENVIRONMENT_KEYS.includes(environment.key))) throw new Error('Created LaunchDarkly environments do not match the fixed demo scope.');
  return project;
}
export async function configureFlagTargeting(fetcher, token, settings, environment, flag) {
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
  });
}
export async function recreate(fetcher, env, confirmation) {
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('recreate', env); assertScope({ ...settings });
  try { await checkGithub(fetcher, t.GH_RESET_TOKEN, settings); } catch (error) { throw new Error(`GH_RESET_TOKEN GitHub authentication/read access failed: ${error.message}`); }
  try { await checkLaunchDarkly(fetcher, t.LD_RESET_TOKEN, settings); } catch (error) { throw new Error(`LD_RESET_TOKEN LaunchDarkly authentication/project-list access failed: ${error.message}`); }
  const deleted = [];
  for (const name of REPOS) deleted.push([name, await removeIfPresent(fetcher, GH, `/repos/${settings.org}/${name}`, t.GH_RESET_TOKEN, `GH_RESET_TOKEN delete repository ${settings.org}/${name}`)]);
  deleted.push([settings.project, await removeIfPresent(fetcher, LD, `/api/v2/projects/${settings.project}`, t.LD_RESET_TOKEN, `LD_RESET_TOKEN delete project ${settings.project}`)]);
  for (const name of REPOS) await waitForRepositoryAbsence(fetcher, t.GH_RESET_TOKEN, settings, name);
  await waitForProjectAbsence(fetcher, t.LD_RESET_TOKEN, settings);
  for (const name of REPOS) try { await createRepositoryWithSource(fetcher, t.GH_RESET_TOKEN, settings, name, SOURCES[name]); } catch (error) { throw new Error(`GH_RESET_TOKEN provision repository ${settings.org}/${name} failed: ${error.message}`); }
  try { await createProject(fetcher, t.LD_RESET_TOKEN, settings); } catch (error) { throw new Error(`LD_RESET_TOKEN create project ${settings.project} failed: ${error.message}`); }
  for (const key of FLAGS) {
    let flag;
    try { flag = await ld(fetcher, `/api/v2/flags/${settings.project}`, t.LD_RESET_TOKEN, { method: 'POST', body: JSON.stringify({ key, name: key, variations: [{ value: true }, { value: false }] }) }); }
    catch (error) { throw new Error(`LD_RESET_TOKEN create flag ${settings.project}/${key} failed: ${error.message}`); }
    for (const environment of ENVIRONMENT_KEYS) try { await configureFlagTargeting(fetcher, t.LD_RESET_TOKEN, settings, environment, flag); }
    catch (error) { throw new Error(`LD_RESET_TOKEN configure flag ${settings.project}/${key} in environment ${environment} failed: ${error.message}`); }
  }
  return deleted;
}
export async function destroy(fetcher, env, confirmation) {
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('destroy', env); assertScope({ ...settings }); const result = [];
  for (const name of REPOS) result.push([name, await removeIfPresent(fetcher, GH, `/repos/${settings.org}/${name}`, t.GH_RESET_TOKEN, `GH_RESET_TOKEN delete repository ${settings.org}/${name}`)]);
  result.push([settings.project, await removeIfPresent(fetcher, LD, `/api/v2/projects/${settings.project}`, t.LD_RESET_TOKEN, `LD_RESET_TOKEN delete project ${settings.project}`)]);
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
export async function run(fetcher, env) {
  const t = tokensFor('run', env); const settings = settingsFor(env); assertScope({ ...settings }); await checkLaunchDarkly(fetcher, t.LD_DEMO_TOKEN, settings, true);
  const listed = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, t.LD_DEMO_TOKEN);
  if (!Array.isArray(listed.items)) throw new Error('Malformed LaunchDarkly flag evidence.');
  const rows = [];
  for (const flag of listed.items.filter((f) => FLAGS.includes(f.key))) { let evidence; try { evidence = await auditFlag(fetcher, t.GH_DEMO_TOKEN, settings, flag.key); } catch { evidence = { files: [], complete: false, error: true }; }
    rows.push({ key: flag.key, files: evidence.files || [], result: outcome(evidence) }); }
  return rows;
}
