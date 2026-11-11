import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

/**
 * Integration tests run against a dedicated database on the docker-compose PostgreSQL, so that
 * migration round-trips never wipe the development database.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? withDatabase(requiredDatabaseUrl(), 'wagering_test');

function requiredDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set (copy .env.example to .env)');
  return url;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function ensureTestDatabase(): Promise<void> {
  const name = new URL(TEST_DATABASE_URL).pathname.slice(1);
  const admin = new SQL(withDatabase(TEST_DATABASE_URL, 'postgres'));
  try {
    const [row] = await admin`select 1 as found from pg_database where datname = ${name}`;
    if (!row) {
      await admin.unsafe(`create database "${name}"`);
    }
  } finally {
    await admin.close();
  }
}

export async function createTestOrm(): Promise<MikroORM> {
  const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DATABASE_URL });
  return MikroORM.init({ ...createOrmConfig(config), debug: false });
}

/** Migrated test database plus a raw SQL client. */
export async function setUpTestDatabase(): Promise<{ orm: MikroORM; sql: SQL }> {
  await ensureTestDatabase();
  const orm = await createTestOrm();
  await orm.getMigrator().up();
  return { orm, sql: new SQL(TEST_DATABASE_URL) };
}
