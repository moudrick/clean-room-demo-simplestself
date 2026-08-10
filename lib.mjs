export const ORG_ENV = 'GH_ORG';
export const PROJECT_ENV = 'LD_PROJECT_KEY';
export const REPOS = ['demo-orders', 'demo-storefront', 'demo-profile'];
export const FLAGS = ['demo-checkout-rollout', 'demo-legacy-profile', 'demo-retired-banner'];
export const GH = 'https://api.github.com';
export const LD = 'https://app.launchdarkly.com';
const origins = new Set([GH, LD]);

export function settingsFor(env) {
  const org = env[ORG_ENV]; const project = env[PROJECT_ENV];
  if (!org || !project || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org) || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(project)) throw new Error('Missing or invalid GH_ORG or LD_PROJECT_KEY.');
  return { org, project };
}
export function assertScope({ org, project, repos = REPOS, flags = FLAGS }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org) || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(project) || repos.length !== REPOS.length || flags.length !== FLAGS.length ||
    repos.some((x) => !REPOS.includes(x)) || flags.some((x) => !FLAGS.includes(x))) throw new Error('Refusing an identifier outside the fixed disposable scope.');
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
export async function request(fetcher, base, path, token, options = {}) {
  const url = checkedUrl(path, base);
  const authorization = base === GH ? `Bearer ${token}` : token;
  const headers = { Accept: 'application/json', Authorization: authorization, ...(base === GH ? { 'X-GitHub-Api-Version': '2022-11-28' } : { 'LD-API-Version': '20240415' }), ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetcher(url, { ...options, headers });
  const responseOrigin = new URL(response.url || url).origin;
  if (responseOrigin !== url.origin) throw new Error('API response did not come from the expected official origin.');
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.message === 'string' ? redact(body.message, [token]).slice(0, 300) : '';
    throw new Error(`API request failed (${response.status})${message ? `: ${message}` : '.'}`);
  }
  return body;
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
export async function checkLaunchDarkly(fetcher, token, settings) {
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
    ['LD_DEMO_TOKEN', 'LaunchDarkly authentication/project access', () => checkLaunchDarkly(fetcher, t.LD_DEMO_TOKEN, settings)],
    ['LD_RESET_TOKEN', 'LaunchDarkly authentication/project access', () => checkLaunchDarkly(fetcher, t.LD_RESET_TOKEN, settings)]
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
export const SOURCES = {
  'demo-orders': { path: 'src/checkout.js', content: "export const checkoutFlag = 'demo-checkout-rollout';\n", date: null },
  'demo-storefront': { path: 'src/checkout-banner.js', content: "export const checkoutBanner = 'demo-checkout-rollout';\n", date: null },
  'demo-profile': { path: 'src/profile.js', content: "export const legacyProfile = 'demo-legacy-profile';\n", date: '2020-01-02T03:04:05Z' }
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
  const blob = await gh(fetcher, `/repos/${settings.org}/${name}/git/blobs`, token, { method: 'POST', body: JSON.stringify({ content: source.content, encoding: 'utf-8' }) });
  const tree = await gh(fetcher, `/repos/${settings.org}/${name}/git/trees`, token, { method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha, tree: [{ path: source.path, mode: '100644', type: 'blob', sha: blob.sha }] }) });
  const stamp = source.date || new Date().toISOString();
  const who = { name: 'Synthetic Demo', email: 'synthetic-demo@example.invalid', date: stamp };
  const commit = await gh(fetcher, `/repos/${settings.org}/${name}/git/commits`, token, { method: 'POST', body: JSON.stringify({ message: 'Add synthetic feature-flag evidence', tree: tree.sha, parents: [parentSha], author: who, committer: who }) });
  await gh(fetcher, `/repos/${settings.org}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, token, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
}
export async function recreate(fetcher, env, confirmation) {
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('recreate', env); assertScope({ ...settings });
  try { await checkGithub(fetcher, t.GH_RESET_TOKEN, settings); } catch (error) { throw new Error(`GH_RESET_TOKEN GitHub authentication/read access failed: ${error.message}`); }
  try { await checkLaunchDarkly(fetcher, t.LD_RESET_TOKEN, settings); } catch (error) { throw new Error(`LD_RESET_TOKEN LaunchDarkly authentication/project access failed: ${error.message}`); }
  const deleted = [];
  for (const name of REPOS) deleted.push([name, await removeIfPresent(fetcher, GH, `/repos/${settings.org}/${name}`, t.GH_RESET_TOKEN, `GH_RESET_TOKEN delete repository ${settings.org}/${name}`)]);
  for (const key of FLAGS) deleted.push([key, await removeIfPresent(fetcher, LD, `/api/v2/flags/${settings.project}/${key}`, t.LD_RESET_TOKEN, `LD_RESET_TOKEN delete flag ${settings.project}/${key}`)]);
  for (const name of REPOS) await waitForRepositoryAbsence(fetcher, t.GH_RESET_TOKEN, settings, name);
  for (const name of REPOS) try { await createRepositoryWithSource(fetcher, t.GH_RESET_TOKEN, settings, name, SOURCES[name]); } catch (error) { throw new Error(`GH_RESET_TOKEN provision repository ${settings.org}/${name} failed: ${error.message}`); }
  for (const key of FLAGS) try { await ld(fetcher, `/api/v2/flags/${settings.project}`, t.LD_RESET_TOKEN, { method: 'POST', body: JSON.stringify({ key, name: key, variations: [{ value: true }, { value: false }] }) }); } catch (error) { throw new Error(`LD_RESET_TOKEN create flag ${settings.project}/${key} failed: ${error.message}`); }
  return deleted;
}
export async function destroy(fetcher, env, confirmation) {
  const settings = settingsFor(env); requireConfirmation(confirmation, settings.project); const t = tokensFor('destroy', env); assertScope({ ...settings }); const result = [];
  for (const name of REPOS) result.push([name, await removeIfPresent(fetcher, GH, `/repos/${settings.org}/${name}`, t.GH_RESET_TOKEN, `GH_RESET_TOKEN delete repository ${settings.org}/${name}`)]);
  for (const key of FLAGS) result.push([key, await removeIfPresent(fetcher, LD, `/api/v2/flags/${settings.project}/${key}`, t.LD_RESET_TOKEN, `LD_RESET_TOKEN delete flag ${settings.project}/${key}`)]);
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
  const t = tokensFor('run', env); const settings = settingsFor(env); assertScope({ ...settings }); await checkLaunchDarkly(fetcher, t.LD_DEMO_TOKEN, settings);
  const listed = await ld(fetcher, `/api/v2/flags/${settings.project}?limit=100`, t.LD_DEMO_TOKEN);
  if (!Array.isArray(listed.items)) throw new Error('Malformed LaunchDarkly flag evidence.');
  const rows = [];
  for (const flag of listed.items.filter((f) => FLAGS.includes(f.key))) { let evidence; try { evidence = await auditFlag(fetcher, t.GH_DEMO_TOKEN, settings, flag.key); } catch { evidence = { files: [], complete: false, error: true }; }
    rows.push({ key: flag.key, files: evidence.files || [], result: outcome(evidence) }); }
  return rows;
}
