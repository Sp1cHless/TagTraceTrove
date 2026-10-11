import Database from 'better-sqlite3';

export type T3Database = Database.Database;

export function openDatabase(filename: string): T3Database {
  const database = new Database(filename);

  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');

  return database;
}
