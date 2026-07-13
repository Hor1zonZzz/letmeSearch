// flue-blueprint: database/postgres@1
import { postgres } from '@flue/postgres';
import { sqlite } from '@flue/runtime/node';
import { Pool } from 'pg';

const databaseDriver = process.env.FLUE_DATABASE_DRIVER ?? 'sqlite';

function createDatabase() {
	if (databaseDriver === 'postgres') {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) {
			throw new Error('DATABASE_URL is required when FLUE_DATABASE_DRIVER=postgres');
		}

		const pool = new Pool({ connectionString });

		return postgres({
			query: async (text, params) => (await pool.query(text, params)).rows,
			transaction: async (fn) => {
				const client = await pool.connect();
				try {
					await client.query('BEGIN');
					const result = await fn({
						query: async (text, params) => (await client.query(text, params)).rows,
					});
					await client.query('COMMIT');
					return result;
				} catch (error) {
					await client.query('ROLLBACK');
					throw error;
				} finally {
					client.release();
				}
			},
			close: () => pool.end(),
		});
	}

	if (databaseDriver === 'sqlite') {
		return sqlite(process.env.SQLITE_DATABASE_PATH ?? './data/flue.db');
	}

	throw new Error(`Unsupported FLUE_DATABASE_DRIVER: ${databaseDriver}`);
}

export default createDatabase();
