import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { getChannel, getGuild, HttpError, isChannelMember, isGuildMember } from '../access.js';
import { parse } from '../validate.js';
import { notificationPrefs, setNotificationPref } from '../prefs.js';

export const prefsRouter = Router();
prefsRouter.use(requireAuth);

const prefSchema = z.object({
  scope: z.enum(['channel', 'guild']),
  targetId: z.string().min(1),
  level: z.enum(['all', 'mentions', 'none']).nullable(),
});

prefsRouter.get('/notification-prefs', (req, res) => {
  res.json({ notificationPrefs: notificationPrefs(req.user!.id) });
});

prefsRouter.put('/notification-prefs', (req, res) => {
  const userId = req.user!.id;
  const body = parse(prefSchema, req.body);

  if (body.scope === 'channel') {
    const channel = getChannel(body.targetId);
    const allowed = channel.guild_id ? isGuildMember(channel.guild_id, userId) : isChannelMember(channel.id, userId);
    if (!allowed) throw new HttpError(403, 'You do not have access to that channel');
  } else {
    const guild = getGuild(body.targetId);
    if (!isGuildMember(guild.id, userId)) throw new HttpError(403, 'You are not a member of this server');
  }

  setNotificationPref(userId, body.scope, body.targetId, body.level);
  res.json({ notificationPrefs: notificationPrefs(userId) });
});
