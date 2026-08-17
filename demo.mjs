import fs from 'node:fs';
import { doctor, recreate, refresh, destroy, audit, baseline, bootstrapFlags, mergeCampaign, campaignWithIndexing, warmRepositoryIndex, loadScenario, compileScenario, stepsThrough, reconcileStep, scenarioStatus, settingsFor, REPOS, FLAGS, ENVIRONMENTS, progressLine, redact } from './lib.mjs';

function loadEnv() {
  const file = '.env';
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  return process.env;
}
const command = process.argv[2];
const argumentAfter = (name) => { const index = process.argv.indexOf(name); return index > 2 ? process.argv[index + 1] : undefined; };
const confirmation = process.argv[3] === '--confirm' ? process.argv[4] : argumentAfter('--confirm');
const breakIndex = process.argv.indexOf('--break-campaign-lock');
const breakCampaignLock = breakIndex > 2 ? process.argv[breakIndex + 1] : undefined;
const env = loadEnv();
function introducedRepositories() {
  try { return compileScenario(loadScenario(process.cwd())).services.map((service) => service.key); }
  catch { return REPOS; }
}
const secrets = ['GH_RESET_TOKEN', 'GH_DEMO_TOKEN', 'LD_RESET_TOKEN', 'LD_DEMO_TOKEN'].map((name) => env[name]).filter(Boolean);
try {
  const settings = settingsFor(env);
  function printTargets() { console.log(`Repositories: ${REPOS.map((x) => `${settings.org}/${x}`).join(', ')}`); console.log(`LaunchDarkly project: ${settings.project} (flags: ${FLAGS.join(', ')}; environments: ${ENVIRONMENTS.map((item) => item.key).join(', ')})`); }
  if (command === 'doctor') {
    const rows = await doctor(fetch, env);
    console.log('TOKEN           IDENTITY   SCOPE       READ   WRITE/DELETE');
    for (const [token, identity] of rows) console.log(`${token.padEnd(16)}${String(identity).padEnd(11)}EXPECTED    OK     ${token.includes('RESET') ? 'VERIFIED DURING MUTATION' : 'NOT REQUESTED'}`);
  } else if (command === 'recreate' || command === 'refresh') {
    let progress;
    const onProgress = (state) => { progress = state; console.log(progressLine(state)); };
    const onRateLimit = ({ provider, status, retry, maxRetries, remainingMs }) => {
      const wait = remainingMs > 0 ? `${Math.ceil(remainingMs / 1000)}s remaining` : 'retrying now';
      console.log(progressLine({ ...progress, label: `${progress.label}; ${provider} rate limit ${status}, retry ${retry}/${maxRetries}, ${wait}` }));
    };
    printTargets(); const action = command === 'recreate' ? recreate : refresh; const result = await action(fetch, env, confirmation, { onProgress, onRateLimit, breakCampaignLock });
    for (const [name, state] of result.deleted) console.log(`${name}: ${state}`);
    if (command === 'recreate') console.log(`Created synthetic resources and runtime. LaunchDarkly project instance: ${result.projectId}${result.previousProjectId ? ` (replaced ${result.previousProjectId})` : ' (fresh)'}; traffic generation: ${result.generation}. The old profile commit timestamp is deliberately synthetic.`);
    else console.log(`Refreshed repositories, flag configuration, and runtime while preserving LaunchDarkly project instance ${result.projectId}; new traffic generation: ${result.generation}.`);
  } else if (command === 'destroy') {
    printTargets(); for (const [name, state] of await destroy(fetch, env, confirmation, { breakCampaignLock })) console.log(`${name}: ${state}`);
  } else if (command === 'audit') {
    const campaign = fs.existsSync('campaign.json') ? JSON.parse(fs.readFileSync('campaign.json', 'utf8')) : null;
    let scenario = null; try { scenario = loadScenario(process.cwd()); } catch { scenario = null; }
    const report = await audit(fetch, env, { scenario, index: campaign?.indexing, sweep: process.argv.includes('--sweep'), crossCheck: (argumentAfter('--cross-check') || '').split(',').filter(Boolean) });
    console.log('TRUTH — source read directly through the Contents API, independent of the code index.');
    console.log('REPOSITORY | ENTRY FILE | READ | FLAG KEYS FOUND | LAST COMMIT');
    for (const row of report.truth.repositories) console.log(`${row.name} | ${row.path} | ${row.read ? 'yes' : `FAILED (${row.error || 'unknown'})`} | ${row.keys.join(',') || '-'} | ${row.lastCommit || '-'}`);
    console.log(`EVIDENCE — organization-wide code search, run for ${report.searched.length} flag(s) only: ${report.searched.join(', ') || 'none'}.`);
    if (report.sweep) console.log(`Single-token sweep "${report.sweep.query}": ${report.sweep.error ? `failed (${report.sweep.error})` : `${report.sweep.files?.length ?? 0} file(s) across ${report.sweep.repositories?.join(', ') || 'no repository'}`}`);
    console.log('FLAG | TRUTH FILES | TRUTH REPOSITORIES | LAST FILE COMMIT | SEARCH | RESULT');
    for (const row of report.rows) {
      const latest = row.truth.files.map((file) => file.commit).filter(Boolean).sort().at(-1) || '-';
      const search = row.evidence ? (row.evidence.error ? 'error' : `${row.evidence.totalCount ?? 0} hit(s)${row.evidence.incomplete ? ', INCOMPLETE' : ''}`) : 'not searched';
      console.log(`${row.key} | ${row.truth.files.map((file) => file.path).join(',') || '-'} | ${[...new Set(row.truth.files.map((file) => file.repo))].join(',') || '-'} | ${latest} | ${search} | ${row.result}`);
    }
    if (report.index.refusal) console.log(report.index.refusal);
    if (report.index.skipped.length) console.log(`Index state is unknown by design for ${report.index.skipped.join(', ')} (skipIndexingCheck). Their source is still read for truth.`);
    for (const disagreement of report.disagreements) console.log(`DISAGREEMENT (${disagreement.kind}) ${disagreement.key}: ${disagreement.detail}`);
    for (const line of report.manualActions) console.log(line);
  } else if (command === 'baseline') {
    const file = 'campaign.json';
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const merged = mergeCampaign(previous, await baseline(fetch, env, { repositories: introducedRepositories() }));
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`Wrote ${file}: scenario ${merged.scenarioId}, campaign start ${merged.campaignStart}, project ${merged.project.key} (${merged.project.id}).`);
    console.log('FLAG | CREATED (UTC) | AGE DAYS | 30-DAY AGE REACHED');
    for (const flag of merged.flags) console.log(`${flag.key} | ${flag.createdAt} | ${flag.ageDaysAtCapture} | ${flag.minimumAgeReachedAt}`);
    console.log('REPOSITORY | CREATED (UTC) | DEFAULT BRANCH | HEAD SHA AT BASELINE');
    for (const repo of merged.repositories) console.log(`${repo.name} | ${repo.createdAt} | ${repo.defaultBranch} | ${repo.headShaAtBaseline}`);
  } else if (command === 'bootstrap') {
    const file = 'campaign.json';
    if (!fs.existsSync(file)) throw new Error('Run "node demo.mjs baseline" before bootstrap so the campaign identity exists.');
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    const catalog = JSON.parse(fs.readFileSync('scenario/flags.json', 'utf8'));
    const result = await bootstrapFlags(fetch, env, confirmation, catalog, { scenarioId: previous.scenarioId, onProgress: (state) => console.log(progressLine(state)) });
    console.log(`Created ${result.created.length} flag(s); adopted ${result.adopted.length} existing flag(s) by identity. No flag was deleted or recreated.`);
    const merged = mergeCampaign(previous, await baseline(fetch, env, { repositories: introducedRepositories() }));
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`Updated ${file}: ${merged.flags.length} flags recorded with real identities and creation times.`);
    console.log('FLAG | CREATED (UTC) | 30-DAY AGE REACHED');
    for (const flag of merged.flags) console.log(`${flag.key} | ${flag.createdAt} | ${flag.minimumAgeReachedAt}`);
  } else if (command === 'scenario') {
    const sub = process.argv[3];
    const target = argumentAfter('--to');
    const scenario = loadScenario(process.cwd());
    const stateFile = 'runtime/scenario-state.json';
    const readState = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { appliedSteps: [] });
    if (sub === 'list') {
      const compiled = compileScenario(scenario);
      const applied = new Set(readState().appliedSteps.map((item) => item.id));
      console.log(`Scenario ${compiled.scenarioId} | checksum ${compiled.checksum} | ${scenario.steps.length} step(s)`);
      console.log('STEP | DATE | CADENCE | STATE | TITLE');
      for (const step of scenario.steps) console.log(`${step.id} | ${step.recommendedDate} | ${step.cadence} | ${applied.has(step.id) ? 'applied' : 'pending'} | ${step.title || ''}`);
    } else if (sub === 'plan') {
      if (!target) throw new Error('scenario plan requires --to <step>.');
      const through = stepsThrough(scenario.steps, target);
      const compiled = compileScenario({ ...scenario, steps: through });
      const step = through.at(-1);
      console.log(`Plan through ${step.id} — ${step.title || ''}`);
      console.log(`Recommended ${step.recommendedDate} | cadence ${step.cadence} | checksum ${compiled.checksum}`);
      console.log(`Repositories introduced by this step: ${(step.introduceServices || []).join(', ') || 'none'}`);
      for (const [key, references] of Object.entries(step.sourceReferences || {})) console.log(`  ${key} references ${references.join(', ')}`);
      for (const [key, version] of Object.entries(step.releaseTags || {})) console.log(`  ${key} tag ${key}-${version}`);
      console.log(`Deployment tuples after this step: ${compiled.deployments.length} of maximum ${scenario.sandbox.limits.maxEvaluatorContainers}`);
      for (const tuple of compiled.deployments) console.log(`  ${tuple.service}/${tuple.environment} ${tuple.traffic}`);
      if (step.targeting?.length) {
        console.log(`Targeting changes in this step: ${step.targeting.length}`);
        for (const entry of step.targeting) console.log(`  ${entry.flag} / ${entry.environment}: ${entry.state}, serving ${entry.serve || 'false'}${entry.clusters?.length ? `, clusters ${entry.clusters.join(', ')}` : ''}${entry.exception ? ` (exception: ${entry.exception})` : ''}`);
      } else console.log('Targeting changes in this step: none');
      const spread = compiled.distribution;
      console.log(`Flag distribution after this step — serving true everywhere: ${spread.onEverywhere.length}; true below Production only: ${spread.onBelowProduction.length}; on and rolling out: ${spread.rollingOut.length}; untouched: ${spread.untouched.length}`);
      console.log('No repository or flag is deleted by this step.');
    } else if (sub === 'apply') {
      if (!target) throw new Error('scenario apply requires --to <step>.');
      const campaign = fs.existsSync('campaign.json') ? JSON.parse(fs.readFileSync('campaign.json', 'utf8')) : null;
      const result = await reconcileStep(fetch, env, scenario, target, { confirmation, campaign, onProgress: (state) => console.log(progressLine(state)) });
      console.log(`Applied ${result.step} | checksum ${result.checksum}`);
      console.log(`Created ${result.created.length} repository(ies); adopted ${result.adopted.length}. Nothing was deleted or recreated.`);
      for (const item of result.created) console.log(`  ${item.service} | commit ${item.commitSha} | tag ${item.tag} | references ${item.references.join(', ')}`);
      const state = readState();
      state.appliedSteps = [...state.appliedSteps.filter((item) => item.id !== result.step), { id: result.step, checksum: result.checksum, appliedAt: new Date().toISOString(), created: result.created.map((item) => ({ service: item.service, repositoryId: item.repositoryId, commitSha: item.commitSha, tag: item.tag, firstPushAt: item.firstPushAt })) }];
      fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      console.log(`Recorded applied state in ${stateFile}.`);
    } else if (sub === 'index') {
      const campaignFile = 'campaign.json';
      const previous = fs.existsSync(campaignFile) ? JSON.parse(fs.readFileSync(campaignFile, 'utf8')) : null;
      const firstPushAt = { ...Object.fromEntries((previous?.indexing?.repositories || []).filter((row) => row.firstPushAt).map((row) => [row.name, row.firstPushAt])) };
      for (const step of readState().appliedSteps || []) for (const item of step.created || []) if (item.firstPushAt && !firstPushAt[item.service]) firstPushAt[item.service] = item.firstPushAt;
      const result = await warmRepositoryIndex(fetch, env, scenario, {
        firstPushAt,
        onProbe: (row) => console.log(`probe ${row.attempt}: ${row.name} | ${row.error ? `error (${row.error})` : row.state}`)
      });
      console.log(`Probed ${result.searches} code search(es) across ${result.repositories.length - result.skipped.length} repository(ies); ${result.skipped.length} skipped by design: ${result.skipped.join(', ') || 'none'}.`);
      console.log('REPOSITORY | INDEX | FIRST PUSH | INDEX REQUESTED | FIRST INDEXED | PROBES');
      for (const row of result.repositories) console.log(`${row.name} | ${row.state} | ${row.firstPushAt || '-'} | ${row.indexRequestedAt || '-'} | ${row.firstIndexedAt || '-'} | ${row.probes}`);
      for (const line of result.manualActions) console.log(line);
      if (previous) {
        fs.writeFileSync(campaignFile, `${JSON.stringify(campaignWithIndexing(previous, result), null, 2)}\n`);
        console.log(`Recorded index evidence in ${campaignFile}. No repository, flag, or remote resource was modified.`);
      } else console.log(`No ${campaignFile} to record into; run "node demo.mjs baseline" first to keep this evidence.`);
    } else if (sub === 'status') {
      const campaign = fs.existsSync('campaign.json') ? JSON.parse(fs.readFileSync('campaign.json', 'utf8')) : null;
      const status = await scenarioStatus(fetch, env, scenario, { campaign });
      console.log(`Scenario checksum ${status.checksum} | today ${status.today}`);
      console.log('REPOSITORY | PRESENT | INDEX | TAG | EXPECTED REFERENCES');
      for (const repository of status.repositories) console.log(`${repository.key} | ${repository.present ? 'yes' : 'MISSING'} | ${repository.index} | ${repository.tag || '-'} | ${repository.expectedReferences.join(',') || '-'}`);
      console.log(`Catalog flags missing from the project: ${status.missingFlags.length ? status.missingFlags.join(', ') : 'none'}`);
      const applied = new Set(readState().appliedSteps.map((item) => item.id));
      console.log('STEP | DATE | STATE | TIMING');
      for (const step of status.steps) {
        const timing = step.overdueDays > 0 ? `${step.overdueDays} day(s) overdue` : step.dueToday ? 'due today' : 'future';
        console.log(`${step.id} | ${step.recommendedDate} | ${applied.has(step.id) ? 'applied' : 'pending'} | ${timing}`);
      }
    } else throw new Error('Usage: node demo.mjs scenario <list|plan|apply|status|index> [--to <step>]');
  } else throw new Error('Usage: node demo.mjs <doctor|baseline|bootstrap|scenario|recreate|refresh|audit|destroy> [--confirm $LD_PROJECT_KEY]');
} catch (error) { console.error(`Error: ${redact(error, secrets)}`); process.exitCode = 1; }
