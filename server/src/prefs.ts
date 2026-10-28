import { db, now } from './db.js';
import type { NotificationLevel, NotificationPrefDTO } from './types.js';

/** All explicit notification overrides for a user (channel beats server). */
export function notificationPrefs(userId: string): NotificationPrefDTO[] {
  const rows = db
    .prepare('SELECT scope, target_id, level FROM notification_prefs WHERE user_id = ?')
    .all(userId) as { scope: 'channel' | 'guild'; target_id: string; level: NotificationLevel }[];
  return rows.map((r) => ({ scope: r.scope, targetId: r.target_id, level: r.level }));
}

export function setNotificationPref(
  userId: string,
  scope: 'channel' | 'guild',
  targetId: string,
  level: NotificationLevel | null,
): void {
  if (level === null) {
    db.prepare('DELETE FROM notification_prefs WHERE user_id = ? AND scope = ? AND target_id = ?').run(
      userId,
      scope,
      targetId,
    );
    return;
  }
  db.prepare(
    `INSERT INTO notification_prefs (user_id, scope, target_id, level, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, scope, target_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
  ).run(userId, scope, targetId, level, now());
}
