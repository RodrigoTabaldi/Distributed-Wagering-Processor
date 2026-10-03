import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from './orm.config.js';

const action = process.argv[2];
if (!['up', 'down', 'pending'].includes(action ?? ''))
  throw new Error('Use up, down or pending');
// down é destrutivo: exige um argumento explícito e não faz parte do startup.
if (action === 'down' && !process.argv.includes('--allow-destructive'))
  throw new Error('Migration down requires --allow-destructive');
const orm = await MikroORM.init(createOrmConfig());
try {
  const migrator = orm.migrator;
  if (action === 'up') await migrator.up();
  else if (action === 'down') await migrator.down();
  else
    console.log(
      (await migrator.getPending()).map((migration) => migration.name),
    );
} finally {
  await orm.close();
}
