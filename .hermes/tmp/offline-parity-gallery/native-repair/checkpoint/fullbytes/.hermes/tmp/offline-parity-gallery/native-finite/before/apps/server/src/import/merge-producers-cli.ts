import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../database/connection.js';
import { inspectDatabase } from '../database/doctor.js';
import {
  executeProducerMerges,
  planProducerMerges,
  type ProducerMergePlan,
} from './merge-producers.js';

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
}

function describePlan(plan: ProducerMergePlan): string {
  const display = plan.canonicalName ?? plan.keeper.name;
  const memberNames = [plan.keeper, ...plan.others]
    .map((member) => `${member.name}#${member.id} (${member.workCount} works)`)
    .join(', ');
  const rename = plan.renamed
    ? `; rename keeper ${plan.keeper.name}#${plan.keeper.id} -> ${plan.canonicalName}`
    : '';
  return `merge ${plan.others.length + 1} -> 1: "${display}" <= ${memberNames}${rename}`;
}

const args = process.argv.slice(2);
const commitMode = args.includes('--commit');
const explicitPath = args.find((arg) => !arg.startsWith('--'));

const invocationRoot = process.env.INIT_CWD ?? process.cwd();
const candidatePaths = explicitPath
  ? [resolve(invocationRoot, explicitPath)]
  : [
      resolve(invocationRoot, 'apps/server/.data/library.db'),
      resolve(invocationRoot, '.data/library.db'),
    ];
const databasePath = candidatePaths.find((candidate) => existsSync(candidate));

if (!databasePath) {
  console.error('Usage: pnpm merge:authors [<library.db path>] [--dry-run|--commit]');
  console.error('Default database: apps/server/.data/library.db (searched under the repo root).');
  process.exitCode = 1;
} else {
  const database = openDatabase(databasePath);
  try {
    const plans = planProducerMerges(database);
    if (plans.length === 0) {
      console.log('No duplicate or dictionary-equivalent authors to merge.');
    } else {
      console.log(`Planned merges for ${databasePath}:`);
      for (const plan of plans) {
        console.log(`  ${describePlan(plan)}`);
      }

      if (!commitMode) {
        console.log('\nDry run — nothing changed. Pass --commit to execute (a backup is made first).');
      } else {
        const backupPath = `${databasePath}.merge-backup-${timestamp()}`;
        await database.backup(backupPath);
        console.log(`\nBackup written to ${backupPath}`);

        database.pragma('foreign_keys = OFF');
        let executions: ReturnType<typeof executeProducerMerges> = [];
        try {
          executions = executeProducerMerges(database, plans);
        } finally {
          database.pragma('foreign_keys = ON');
        }

        const totals = executions.reduce((sum, execution) => ({
          deletedProducers: sum.deletedProducers + execution.deletedProducers,
          worksRelinked: sum.worksRelinked + execution.worksRelinked,
          tagsRelinked: sum.tagsRelinked + execution.tagsRelinked,
          directoriesMoved: sum.directoriesMoved + execution.directoriesMoved,
          directoriesMerged: sum.directoriesMerged + execution.directoriesMerged,
          membershipsMoved: sum.membershipsMoved + execution.membershipsMoved,
          membershipsRemoved: sum.membershipsRemoved + execution.membershipsRemoved,
          renamed: sum.renamed + (execution.renamedTo ? 1 : 0),
        }), {
          deletedProducers: 0,
          worksRelinked: 0,
          tagsRelinked: 0,
          directoriesMoved: 0,
          directoriesMerged: 0,
          membershipsMoved: 0,
          membershipsRemoved: 0,
          renamed: 0,
        });
        console.log(
          `Executed: deleted ${totals.deletedProducers} producer rows, `
          + `relinked ${totals.worksRelinked} work links (ignored duplicates), `
          + `relinked ${totals.tagsRelinked} tag links, `
          + `moved ${totals.directoriesMoved} directories, `
          + `merged ${totals.directoriesMerged} directories, `
          + `moved ${totals.membershipsMoved} directory memberships, `
          + `dropped ${totals.membershipsRemoved} duplicate memberships, `
          + `renamed ${totals.renamed} keepers to their dictionary name.`,
        );

        const foreignKeyIssues = database.pragma('foreign_key_check') as unknown as unknown[];
        if (foreignKeyIssues.length > 0) {
          console.error(`FAIL foreign_key_check: ${JSON.stringify(foreignKeyIssues)}`);
          process.exitCode = 1;
        } else {
          console.log('PASS foreign_key_check');
        }
        const doctor = inspectDatabase(database);
        if (doctor.ok) {
          console.log('PASS database integrity, foreign keys, and application invariants');
        } else {
          for (const issue of doctor.issues) {
            console.error(`FAIL ${issue}`);
          }
          process.exitCode = 1;
        }
      }
    }
  } finally {
    database.close();
  }
}
