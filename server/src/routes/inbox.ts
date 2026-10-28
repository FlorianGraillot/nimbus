import { Router } from 'express';
import { db, now } from '../db.js';
import { requireAuth } from '../auth.js';
import { accessibleChannelIds, inboxPayload } from '../payloads.js';
import { clearAllMentions } from '../mentions.js';

export const inboxRouter = Router();
inboxRouter.use(requireAuth);

/** Unread mentions + a per-channel unread digest, newest first. */
inboxRouter.get('/inbox', (req, res) => {
  res.json(inboxPayload(req.user!.id));
});

/**
 * "Mark all read" clears the whole inbox: every channel is advanced to its
 * latest message and any outstanding mention rows are marked read.
 */
inboxRouter.post('/inbox/read', (req, res) => {
  const userId = req.user!.id;
  const ids = accessibleChannelIds(userId);
  const at = now();

  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE channel_id = ?');
  const upsert = db.prepare(
    `INSERT INTO read_states (user_id, channel_id, last_seq, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
  );

  db.transaction(() => {
    for (const channelId of ids) {
      const seq = (maxSeq.get(channelId) as { seq: number }).seq;
      if (seq > 0) upsert.run(userId, channelId, seq, at);
    }
    clearAllMentions(userId);
  })();

  res.json({ ok: true });
});
