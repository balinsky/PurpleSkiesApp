import Database from 'better-sqlite3';

// Each call to openDatabaseAsync returns a fresh in-memory database so that
// tests that call initDb() in beforeEach start with a clean slate.
export async function openDatabaseAsync(_name: string) {
  const db = new Database(':memory:');
  return {
    async execAsync(sql: string): Promise<void> {
      try {
        db.exec(sql);
      } catch (e: any) {
        // In-memory DBs don't support WAL mode; silently skip PRAGMA errors.
        if (/journal_mode|WAL/i.test(sql)) return;
        throw e;
      }
    },
    async runAsync(sql: string, params: any[] = []): Promise<void> {
      db.prepare(sql).run(params);
    },
    async getAllAsync<T>(sql: string, params: any[] = []): Promise<T[]> {
      return db.prepare(sql).all(params) as T[];
    },
    async getFirstAsync<T>(sql: string, params: any[] = []): Promise<T | null> {
      return (db.prepare(sql).get(params) as T) ?? null;
    },
  };
}
