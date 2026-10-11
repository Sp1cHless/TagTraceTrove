import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import type { T3Database } from '../../src/database/connection.js';

class StatementAdapter {
  private pluckRows = false;

  constructor(private readonly statement: StatementSync) {}

  pluck(enabled = true): this {
    this.pluckRows = enabled;
    return this;
  }

  run(...values: SQLInputValue[]): ReturnType<StatementSync['run']> {
    return this.statement.run(...values);
  }

  get(...values: SQLInputValue[]): unknown {
    const row = this.statement.get(...values);
    if (!this.pluckRows || row === undefined) return row;
    return Object.values(row)[0];
  }

  all(...values: SQLInputValue[]): unknown[] {
    const rows = this.statement.all(...values);
    return this.pluckRows ? rows.map((row) => Object.values(row)[0]) : rows;
  }
}

class DatabaseAdapter {
  readonly raw = new DatabaseSync(':memory:');

  exec(sql: string): this {
    this.raw.exec(sql);
    return this;
  }

  prepare(sql: string): StatementAdapter {
    return new StatementAdapter(this.raw.prepare(sql));
  }

  transaction<TArgs extends unknown[], TResult>(callback: (...args: TArgs) => TResult) {
    const invoke = (mode: '' | ' IMMEDIATE', args: TArgs): TResult => {
      this.raw.exec(`BEGIN${mode}`);
      try {
        const result = callback(...args);
        this.raw.exec('COMMIT');
        return result;
      } catch (cause) {
        this.raw.exec('ROLLBACK');
        throw cause;
      }
    };
    const transaction = (...args: TArgs) => invoke('', args);
    transaction.immediate = (...args: TArgs) => invoke(' IMMEDIATE', args);
    return transaction;
  }

  close(): void {
    this.raw.close();
  }
}

export function createNodeSqliteMemoryDatabase(): T3Database {
  const database = new DatabaseAdapter();
  database.exec('PRAGMA foreign_keys = ON');
  return database as unknown as T3Database;
}
