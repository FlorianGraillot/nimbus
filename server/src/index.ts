import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { HttpError } from './access.js';
import { requireAuth } from './auth.js';
import { bootstrapPayload } from './payloads.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { mediaRouter } from './routes/media.js';
import { guildsRouter, channelsRouter } from './routes/guilds.js';
import { messagesRouter } from './routes/messages.js';
import { socialRouter } from './routes/social.js';
import { invitesRouter } from './routes/invites.js';
import { inboxRouter } from './routes/inbox.js';
import { prefsRouter } from './routes/prefs.js';
import { backfillMentions } from './mentions.js';
import { attachGateway } from './ws.js';
import './db.js';

const PORT = Number(process.env.NIMBUS_PORT ?? 4000);

const app = express();
app.disable('x-powered-by');
app.use(cors());
// Picture uploads are the one route that legitimately carries a large body.
// Registering its parser first means the global 256 kB limit still protects
// every other endpoint (body-parser skips a request it has already parsed).
app.use('/api/attachments', express.json({ limit: '6mb' }));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'nimbus', time: Date.now() });
});

app.get('/api/bootstrap', requireAuth, (req, res) => {
  res.json(bootstrapPayload(req.user!.id));
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/attachments', mediaRouter);
app.use('/api/guilds', guildsRouter);
app.use('/api/channels', channelsRouter);
// Invites first: the preview route is public and the routers mounted below
// apply requireAuth to every /api request that reaches them.
app.use('/api', invitesRouter);
app.use('/api', messagesRouter);
app.use('/api', socialRouter);
app.use('/api', inboxRouter);
app.use('/api', prefsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  // body-parser's own errors (request too large, bad content encoding, …).
  const transport = err as { type?: string; status?: number };
  if (transport?.type === 'entity.too.large') {
    res.status(413).json({ error: 'That upload is too large' });
    return;
  }
  console.error('[nimbus] unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on our end' });
});

const server = createServer(app);
attachGateway(server);

// Messages written before the mentions table existed still belong in the inbox.
backfillMentions();

server.listen(PORT, () => {
  console.log(`\n  Nimbus API  ready at http://localhost:${PORT}`);
  console.log(`  Gateway     ws://localhost:${PORT}/gateway\n`);
});
