import { runDatabaseProbe } from './probe.js';

const result = runDatabaseProbe();
for (const check of result.checks) {
  console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
}

if (!result.ok) {
  process.exitCode = 1;
}
