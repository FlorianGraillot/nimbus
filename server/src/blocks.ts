import { db, now } from './db.js';

/** True when `blocker` has blocked `blocked`. */
export function hasBlocked(blockerId: string, blockedId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId));
}

/**
 * Messaging and friend requests are refused if either side blocked the other,
 * which keeps the block effective without leaking who blocked whom.
 */
export function blockedBetween(a: string, b: string): boolean {
  return hasBlocked(a, b) || hasBlocked(b, a);
}

/** Ids this user has blocked (used by the client to disable composers). */
export function blockedIds(userId: string): string[] {
  const rows = db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?').all(userId) as { blocked_id: string }[];
  return rows.map((r) => r.blocked_id);
}

/** Blocks a user and clears any pending friend requests in either direction. */
export function blockUser(blockerId: string, blockedId: string): void {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(
      blockerId,
      blockedId,
      now(),
    );
    db.prepare(
      `DELETE FROM friendships WHERE status = 'pending'
       AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
    ).run(blockerId, blockedId, blockedId, blockerId);
  })();
}

export function unblockUser(blockerId: string, blockedId: string): void {
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
}
