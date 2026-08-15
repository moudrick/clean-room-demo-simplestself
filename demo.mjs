import fs from 'node:fs';
import { doctor, recreate, refresh, destroy, audit, settingsFor, REPOS, FLAGS, ENVIRONMENTS, progressLine, redact } from './lib.mjs';

function loadEnv() {
  const file = '.env';
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  return process.env;
}
const command = process.argv[2];
const confirmation = process.argv[3] === '--confirm' ? process.argv[4] : undefined;
const env = loadEnv();
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
    printTargets(); const action = command === 'recreate' ? recreate : refresh; const result = await action(fetch, env, confirmation, { onProgress, onRateLimit });
    for (const [name, state] of result.deleted) console.log(`${name}: ${state}`);
    if (command === 'recreate') console.log(`Created synthetic resources and runtime. LaunchDarkly project instance: ${result.projectId}${result.previousProjectId ? ` (replaced ${result.previousProjectId})` : ' (fresh)'}; traffic generation: ${result.generation}. The old profile commit timestamp is deliberately synthetic.`);
    else console.log(`Refreshed repositories, flag configuration, and runtime while preserving LaunchDarkly project instance ${result.projectId}; new traffic generation: ${result.generation}.`);
  } else if (command === 'destroy') {
    printTargets(); for (const [name, state] of await destroy(fetch, env, confirmation)) console.log(`${name}: ${state}`);
  } else if (command === 'audit') {
    console.log('FLAG | VERIFIED FILES | REPOSITORIES | LAST FILE COMMIT | RESULT');
    for (const row of await audit(fetch, env)) { const latest = row.files.map((f) => f.commit).sort().at(-1) || '-'; console.log(`${row.key} | ${row.files.map((f) => f.path).join(',') || '-'} | ${[...new Set(row.files.map((f) => f.repo))].join(',') || '-'} | ${latest} | ${row.result}`); }
  } else throw new Error('Usage: node demo.mjs <doctor|recreate|refresh|audit|destroy> [--confirm $LD_PROJECT_KEY]');
} catch (error) { console.error(`Error: ${redact(error, secrets)}`); process.exitCode = 1; }
