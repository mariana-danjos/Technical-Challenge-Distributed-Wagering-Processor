import { Migration } from '@mikro-orm/migrations';

export class Migration20261110215642_init extends Migration {

  override async up(): Promise<void> {
    this.addSql(`select 1`);
  }

  override async down(): Promise<void> {
    this.addSql(`select 1`);
  }

}
