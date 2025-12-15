import { query } from './db/index.js';
import type { Machine, MachineCapabilities, MachineInfo } from './types.js';

interface DBMachine {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  last_seen: Date;
  is_online: boolean;
  capabilities: MachineCapabilities;
  created_at: Date;
}

export async function registerMachine(
  userId: string,
  name: string,
  platform: Machine['platform'],
  capabilities: MachineCapabilities
): Promise<Machine> {
  // Upsert - update if exists, insert if not
  const result = await query<DBMachine>(
    `INSERT INTO machines (user_id, name, platform, capabilities, is_online, last_seen)
     VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, name)
     DO UPDATE SET
       platform = $3,
       capabilities = $4,
       is_online = true,
       last_seen = CURRENT_TIMESTAMP
     RETURNING *`,
    [userId, name, platform, JSON.stringify(capabilities)]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    platform: row.platform as Machine['platform'],
    lastSeen: row.last_seen,
    isOnline: row.is_online,
    capabilities: row.capabilities,
    createdAt: row.created_at,
  };
}

export async function updateMachineOnlineStatus(
  machineId: string,
  isOnline: boolean
): Promise<void> {
  await query(
    `UPDATE machines SET is_online = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2`,
    [isOnline, machineId]
  );
}

export async function updateMachineHeartbeat(machineId: string): Promise<void> {
  await query(
    `UPDATE machines SET last_seen = CURRENT_TIMESTAMP WHERE id = $1`,
    [machineId]
  );
}

export async function getMachinesForUser(userId: string): Promise<MachineInfo[]> {
  // Get all machines the user owns
  const result = await query<DBMachine>(
    `SELECT * FROM machines WHERE user_id = $1 ORDER BY name`,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform as Machine['platform'],
    isOnline: row.is_online,
    lastSeen: row.last_seen,
    isOwn: true,
  }));
}

export async function getMachineById(machineId: string): Promise<Machine | null> {
  const result = await query<DBMachine>(
    `SELECT * FROM machines WHERE id = $1`,
    [machineId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    platform: row.platform as Machine['platform'],
    lastSeen: row.last_seen,
    isOnline: row.is_online,
    capabilities: row.capabilities,
    createdAt: row.created_at,
  };
}

export async function markStaleOffline(timeoutMs: number): Promise<string[]> {
  // Find machines that haven't sent heartbeat within timeout
  const result = await query<{ id: string }>(
    `UPDATE machines
     SET is_online = false
     WHERE is_online = true
       AND last_seen < CURRENT_TIMESTAMP - INTERVAL '1 millisecond' * $1
     RETURNING id`,
    [timeoutMs]
  );

  return result.rows.map((r) => r.id);
}

export async function canUserAccessMachine(
  userId: string,
  machineId: string
): Promise<boolean> {
  // For now, users can only access their own machines
  // TODO: Add team/sharing support
  const result = await query(
    `SELECT 1 FROM machines WHERE id = $1 AND user_id = $2`,
    [machineId, userId]
  );

  return result.rows.length > 0;
}

export async function deleteMachine(
  userId: string,
  machineId: string
): Promise<boolean> {
  // Only allow users to delete their own machines
  const result = await query(
    `DELETE FROM machines WHERE id = $1 AND user_id = $2 RETURNING id`,
    [machineId, userId]
  );

  return result.rows.length > 0;
}

export async function renameMachine(
  userId: string,
  machineId: string,
  newName: string
): Promise<boolean> {
  // Only allow users to rename their own machines
  const result = await query(
    `UPDATE machines SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id`,
    [machineId, userId, newName]
  );

  return result.rows.length > 0;
}
