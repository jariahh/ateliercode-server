import { pool, query } from './index.js';

const migrations = [
  // Create machines table (user_id is Keycloak sub claim, no FK to users table)
  `CREATE TABLE IF NOT EXISTS machines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    name VARCHAR(255) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_online BOOLEAN DEFAULT false,
    capabilities JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
  )`,

  // Create indexes for faster lookups
  `CREATE INDEX IF NOT EXISTS idx_machines_user_id ON machines(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_machines_is_online ON machines(is_online)`,
];

// Migration to transition from old schema (with users table FK) to new schema
const transitionMigrations = [
  // Drop old foreign key constraint if it exists (machines.user_id -> users.id)
  `DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'machines_user_id_fkey'
      AND table_name = 'machines'
    ) THEN
      ALTER TABLE machines DROP CONSTRAINT machines_user_id_fkey;
      -- Change column type from UUID to TEXT to hold Keycloak sub claims
      ALTER TABLE machines ALTER COLUMN user_id TYPE TEXT;
    END IF;
  END $$`,

  // Drop old tables that are no longer needed (Keycloak manages users/sessions)
  `DROP TABLE IF EXISTS sessions`,
  `DROP TABLE IF EXISTS users`,
];

async function migrate() {
  console.log('Running database migrations...');

  // Run transition migrations first (handle schema changes from old to new)
  for (const migration of transitionMigrations) {
    try {
      await query(migration);
      console.log('Executed transition:', migration.substring(0, 60) + '...');
    } catch (error) {
      console.error('Transition migration failed:', error);
      // Don't throw - these are idempotent cleanup steps
    }
  }

  // Run main migrations
  for (const migration of migrations) {
    try {
      await query(migration);
      console.log('Executed:', migration.substring(0, 60) + '...');
    } catch (error) {
      console.error('Migration failed:', error);
      throw error;
    }
  }

  console.log('All migrations completed successfully');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
