import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../config/app-config';
import { createOrmConfig } from './mikro-orm.config';

const [command, name] = process.argv.slice(2);

const orm = await MikroORM.init(createOrmConfig(loadConfig(process.env)));
const migrator = orm.getMigrator();

try {
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(`Applied ${applied.length} migration(s)`);
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(`Reverted ${reverted.length} migration(s)`);
      break;
    }
    case 'create': {
      const result = await migrator.createMigration(undefined, true, false, name);
      console.log(`Created ${result.fileName}`);
      break;
    }
    default:
      console.error('Usage: migrate.ts <up|down|create> [name]');
      process.exitCode = 1;
  }
} finally {
  await orm.close();
}
