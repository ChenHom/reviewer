import type { Knex } from 'knex';

export async function reserve(knex: Knex, sku: string, qty: number) {
  return knex.transaction(async (trx) => {
    const row = await trx('stock').where({ sku }).forUpdate().first();
    if (row.available < qty) throw new Error('insufficient stock');
    await trx('stock').where({ sku }).update({ available: row.available - qty });
  });
}
