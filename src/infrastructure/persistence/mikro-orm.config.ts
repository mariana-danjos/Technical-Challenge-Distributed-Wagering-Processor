import { resolve } from 'node:path';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import type { AppConfig } from '../config/app-config';
import { persistenceSchemas } from './records';

const migrationsPath = resolve(import.meta.dir, '../../../migrations');

export function createOrmConfig(config: AppConfig): Options {
  return defineConfig({
    clientUrl: config.databaseUrl,
    entities: persistenceSchemas,
    extensions: [Migrator],
    // Bun runs TypeScript directly, so migrations are always loaded from .ts sources.
    preferTs: true,
    migrations: {
      path: migrationsPath,
      pathTs: migrationsPath,
      glob: '!(*.d).ts',
      emit: 'ts',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
