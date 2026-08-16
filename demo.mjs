import fs from 'node:fs';
import { doctor, recreate, refresh, destroy, audit, baseline, bootstrapFlags, mergeCampaign, loadScenario, compileScenario, stepsThrough, reconcileStep, scenarioStatus, settingsFor, REPOS, FLAGS, ENVIRONMENTS, progressLine, redact } from './lib.mjs';

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
    console.log('FLAG | VERIFIED FILES | REPOSITORIES | LAST FILE COMMIT | RESULT');
    for (const row of await audit(fetch, env)) { const latest = row.files.map((f) => f.commit).sort().at(-1) || '-'; console.log(`${row.key} | ${row.files.map((f) => f.path).join(',') || '-'} | ${[...new Set(row.files.map((f) => f.repo))].join(',') || '-'} | ${latest} | ${row.result}`); }
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
      console.log('No mutation performed. Targeting is unchanged and every flag stays off.');
    } else if (sub === 'apply') {
      if (!target) throw new Error('scenario apply requires --to <step>.');
      const result = await reconcileStep(fetch, env, scenario, target, { confirmation, onProgress: (state) => console.log(progressLine(state)) });
      console.log(`Applied ${result.step} | checksum ${result.checksum}`);
      console.log(`Created ${result.created.length} repository(ies); adopted ${result.adopted.length}. Nothing was deleted or recreated.`);
      for (const item of result.created) console.log(`  ${item.service} | commit ${item.commitSha} | tag ${item.tag} | references ${item.references.join(', ')}`);
      const state = readState();
      state.appliedSteps = [...state.appliedSteps.filter((item) => item.id !== result.step), { id: result.step, checksum: result.checksum, appliedAt: new Date().toISOString(), created: result.created.map((item) => ({ service: item.service, repositoryId: item.repositoryId, commitSha: item.commitSha, tag: item.tag, firstPushAt: item.firstPushAt })) }];
      fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      console.log(`Recorded applied state in ${stateFile}.`);
    } else if (sub === 'status') {
      const status = await scenarioStatus(fetch, env, scenario);
      console.log(`Scenario checksum ${status.checksum} | today ${status.today}`);
      console.log('REPOSITORY | PRESENT | TAG | EXPECTED REFERENCES');
      for (const repository of status.repositories) console.log(`${repository.key} | ${repository.present ? 'yes' : 'MISSING'} | ${repository.tag || '-'} | ${repository.expectedReferences.join(',') || '-'}`);
      console.log(`Catalog flags missing from the project: ${status.missingFlags.length ? status.missingFlags.join(', ') : 'none'}`);
      const applied = new Set(readState().appliedSteps.map((item) => item.id));
      console.log('STEP | DATE | STATE | TIMING');
      for (const step of status.steps) {
        const timing = step.overdueDays > 0 ? `${step.overdueDays} day(s) overdue` : step.dueToday ? 'due today' : 'future';
        console.log(`${step.id} | ${step.recommendedDate} | ${applied.has(step.id) ? 'applied' : 'pending'} | ${timing}`);
      }
    } else throw new Error('Usage: node demo.mjs scenario <list|plan|apply|status> [--to <step>]');
  } else throw new Error('Usage: node demo.mjs <doctor|baseline|bootstrap|scenario|recreate|refresh|audit|destroy> [--confirm $LD_PROJECT_KEY]');
} catch (error) { console.error(`Error: ${redact(error, secrets)}`); process.exitCode = 1; }
