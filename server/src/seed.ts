/**
 * Seeds a demo workspace so the app has something to show on first launch.
 *   npm run seed          (safe: skips if data exists)
 *   npm run seed -- --force
 *
 * Demo login:  aria@nimbus.chat  /  nimbus123
 */
import { db, newId, now, tx } from './db.js';
import { hashPassword } from './auth.js';
import { backfillMentions } from './mentions.js';
import type { UserRow } from './types.js';

const force = process.argv.includes('--force');
const existing = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
if (existing > 0 && !force) {
  console.log('Database already has users — nothing to do. Use --force to wipe and reseed.');
  process.exit(0);
}

if (force) {
  tx(() => {
    for (const table of [
      'mentions',
      'app_meta',
      'notification_prefs',
      'blocks',
      'reactions',
      'messages',
      'read_states',
      'channel_members',
      'channels',
      'guild_members',
      'invites',
      'guilds',
      'friendships',
      'refresh_tokens',
      'users',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare(`DELETE FROM sqlite_sequence`).run();
  });
}

const t = (minutesAgo: number) => now() - Math.round(minutesAgo * 60_000);

const people = [
  { username: 'aria', display: 'Aria Chen', email: 'aria@nimbus.chat', color: '#6d5efc', status: 'online', bio: 'Design engineer. Making pixels behave.' },
  { username: 'kai', display: 'Kai Rivera', email: 'kai@nimbus.chat', color: '#23a55a', status: 'online', bio: 'Backend. Websockets are my love language.' },
  { username: 'nova', display: 'Nova Park', email: 'nova@nimbus.chat', color: '#eb459e', status: 'idle', bio: 'Motion + micro-interactions.' },
  { username: 'theo', display: 'Theo Blake', email: 'theo@nimbus.chat', color: '#00a8fc', status: 'dnd', bio: 'Shipping small things daily.' },
  { username: 'mira', display: 'Mira Osei', email: 'mira@nimbus.chat', color: '#f0b232', status: 'online', bio: 'Brand, illustration, too much coffee.' },
  { username: 'jules', display: 'Jules Fontaine', email: 'jules@nimbus.chat', color: '#f47fff', status: 'invisible', bio: 'Lurker.' },
];

const ids = new Map<string, string>();

tx(() => {
  for (const p of people) {
    const id = newId();
    ids.set(p.username, id);
    db.prepare(
      `INSERT INTO users (id, email, username, display_name, password_hash, avatar_color, bio, status, custom_status, simulated_presence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      id,
      p.email,
      p.username,
      p.display,
      hashPassword('nimbus123'),
      p.color,
      p.bio,
      p.status,
      p.username === 'aria' ? 'building nimbus' : '',
      t(60 * 24 * 30),
    );
  }
});

const uid = (username: string) => ids.get(username)!;

function createGuild(name: string, owner: string, color: string, channelNames: string[], voiceNames: string[] = []) {
  const guildId = newId();
  db.prepare('INSERT INTO guilds (id, name, icon_color, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
    guildId,
    name,
    color,
    uid(owner),
    t(60 * 24 * 20),
  );
  const channels = new Map<string, string>();
  channelNames.forEach((channelName, index) => {
    const channelId = newId();
    channels.set(channelName, channelId);
    db.prepare(
      `INSERT INTO channels (id, guild_id, name, type, topic, position, created_at)
       VALUES (?, ?, ?, 'text', ?, ?, ?)`,
    ).run(
      channelId,
      guildId,
      channelName,
      channelName === 'general' ? 'Everything and anything.' : '',
      index,
      t(60 * 24 * 20),
    );
  });
  voiceNames.forEach((channelName, index) => {
    const channelId = newId();
    channels.set(channelName, channelId);
    db.prepare(
      `INSERT INTO channels (id, guild_id, name, type, topic, position, created_at)
       VALUES (?, ?, ?, 'voice', ?, ?, ?)`,
    ).run(
      channelId,
      guildId,
      channelName,
      channelName === 'Lounge' ? 'Drop in and say hello.' : '',
      channelNames.length + index,
      t(60 * 24 * 20),
    );
  });
  return { guildId, channels };
}

const hq = createGuild(
  'Nimbus HQ',
  'aria',
  '#6d5efc',
  ['general', 'announcements', 'design', 'engineering', 'random', 'music'],
  ['Lounge', 'Music Room'],
);
const pixel = createGuild('Pixel Club', 'kai', '#23a55a', ['lobby', 'screenshots', 'clips'], ['Arcade']);

for (const username of ['aria', 'kai', 'nova', 'theo', 'mira']) {
  db.prepare('INSERT INTO guild_members (guild_id, user_id, nickname, joined_at) VALUES (?, ?, ?, ?)').run(
    hq.guildId,
    uid(username),
    '',
    t(60 * 24 * 19),
  );
}
for (const username of ['kai', 'theo', 'mira', 'aria']) {
  db.prepare('INSERT INTO guild_members (guild_id, user_id, nickname, joined_at) VALUES (?, ?, ?, ?)').run(
    pixel.guildId,
    uid(username),
    '',
    t(60 * 24 * 10),
  );
}

/* -------------------------------- roles --------------------------------- */
// Owners come from guilds.owner_id; these are the members promoted to admin.
db.prepare("UPDATE guild_members SET role = 'admin' WHERE guild_id = ? AND user_id = ?").run(hq.guildId, uid('kai'));
db.prepare("UPDATE guild_members SET role = 'admin' WHERE guild_id = ? AND user_id = ?").run(pixel.guildId, uid('theo'));

const ch = (guild: { channels: Map<string, string> }, name: string) => guild.channels.get(name)!;

interface Posted {
  id: string;
  seq: number;
}

function post(channelId: string, username: string, content: string, minutesAgo: number, replyTo?: string): Posted {
  const id = newId();
  const info = db
    .prepare(
      `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, channelId, uid(username), content, replyTo ?? null, t(minutesAgo));
  return { id, seq: Number(info.lastInsertRowid) };
}

function react(target: Posted, emoji: string, ...usernames: string[]) {
  for (const username of usernames) {
    db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(
      target.id,
      uid(username),
      emoji,
      t(1),
    );
  }
}

/* ------------------------------- #general ------------------------------- */
const general = ch(hq, 'general');
post(general, 'kai', 'morning everyone ☀️', 320);
post(general, 'nova', 'morning! coffee acquired, brain still booting up', 318);
const sidebar = post(
  general,
  'aria',
  'I pushed the new sidebar layout to staging last night — feedback welcome. Unread pills should finally make sense.',
  300,
);
post(general, 'theo', 'the rounded avatars look great, way less noisy than before', 295);
post(general, 'kai', 'agreed. and the unread pills are actually readable now', 290);
post(general, 'nova', 'small thing: can the hover state be a touch slower? feels jumpy at 60hz', 240);
post(general, 'aria', 'yep — moving it to a 120ms ease-out tonight', 236, sidebar.id);
post(general, 'mira', 'anyone up for a call later? I want to walk through the onboarding flow', 120);
post(general, 'theo', "I'm free after 3", 118);
react(sidebar, '🔥', 'kai', 'nova');
react(sidebar, '👀', 'theo');

/* ---------------------------- #announcements ---------------------------- */
const announcements = ch(hq, 'announcements');
post(announcements, 'aria', '**Nimbus 0.1 is live on staging.** Please file anything broken in #engineering.', 1500);
post(announcements, 'aria', 'Reminder: design review Friday at 2pm. Bring screenshots, not opinions.', 900);

/* -------------------------------- #design ------------------------------- */
const design = ch(hq, 'design');
post(design, 'mira', 'New logo explorations are up — three directions: **cloud**, **orbit**, and **prism**.', 600);
const orbit = post(design, 'nova', 'orbit is my favourite, it reads well at 16px', 590);
post(design, 'aria', 'prism feels a bit cold. what about orbit with the cloud gradient?', 580);
post(design, 'mira', "I'll combine them tonight 🎨", 570);
post(design, 'theo', 'the 16px favicon test is the real judge', 540);
const emptyState = post(design, 'nova', 'also we need a proper empty state for servers with no channels', 500);
post(design, 'mira', '@aria good catch — I sketched one, will post it here', 430);
react(orbit, '🚀', 'aria', 'theo');

const threadRoot = post(design, 'mira', 'Thread: what should the default server look like when you first create one?', 380);
const threadId = newId();
db.prepare(
  `INSERT INTO channels (id, guild_id, name, type, topic, position, parent_id, thread_root_id, created_by, created_at)
   VALUES (?, ?, ?, 'thread', '', 99, ?, ?, ?, ?)`,
).run(threadId, hq.guildId, 'default server design', design, threadRoot.id, uid('mira'), t(379));
post(threadId, 'aria', 'Two channels: #general and #random. Anything more is noise on day one.', 375);
post(threadId, 'theo', '@aria agreed. Maybe a pinned "start here" message in #general?', 370);
post(threadId, 'mira', 'Pinned welcome message it is. I’ll mock it up.', 360);
react(threadRoot, '🧵', 'aria');

/* ----------------------------- #engineering ----------------------------- */
const engineering = ch(hq, 'engineering');
post(engineering, 'theo', 'Gateway reconnect logic is in. Exponential backoff, capped at 30s.', 700);
post(engineering, 'aria', 'nice. did you handle the token refresh race?', 690);
const race = post(engineering, 'theo', 'yep — single in-flight refresh promise, queued requests replay after it resolves', 685);
post(engineering, 'kai', '🙌', 680);
post(engineering, 'theo', 'next up: message pagination. currently loading 50 at a time', 400);
post(engineering, 'aria', "perfect, that's exactly what the client expects", 395);
post(engineering, 'kai', 'I’ll take reactions + read states tomorrow', 200);
react(race, '🎉', 'aria', 'kai');

/* -------------------------------- #random ------------------------------- */
const random = ch(hq, 'random');
post(random, 'kai', "what's everyone listening to today", 260);
post(random, 'nova', 'lo-fi and rain sounds, the usual', 255);
post(random, 'mira', '@aria been on a Bonobo binge all week — this one is for you', 250);
post(random, 'kai', 'adding both to the queue', 245);

/* --------------------------------- #music ------------------------------- */
post(ch(hq, 'music'), 'nova', '@aria made a 4 hour playlist, no regrets, link in my bio', 1000);

/* ------------------------------ Pixel Club ------------------------------ */
const lobby = ch(pixel, 'lobby');
post(lobby, 'kai', 'game night saturday? thinking co-op', 800);
post(lobby, 'theo', 'in', 790);
post(lobby, 'mira', "in, but I'm terrible", 780);
post(lobby, 'kai', "that's the point", 775);
post(ch(pixel, 'screenshots'), 'theo', 'last night’s run. we did not survive.', 700);

/* ---------------------------------- DMs --------------------------------- */
function createDm(type: 'dm' | 'group', members: string[], name = '') {
  const id = newId();
  db.prepare('INSERT INTO channels (id, guild_id, name, type, created_at) VALUES (?, NULL, ?, ?, ?)').run(
    id,
    name,
    type,
    t(60 * 24 * 5),
  );
  for (const username of members) {
    db.prepare('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)').run(
      id,
      uid(username),
      t(60 * 24 * 5),
    );
  }
  return id;
}

const dmKai = createDm('dm', ['aria', 'kai']);
post(dmKai, 'kai', 'hey, do you have the staging link?', 340);
post(dmKai, 'aria', 'http://localhost:5173 — api runs on :4000', 338);
post(dmKai, 'kai', 'got it, thanks!', 335);
post(dmKai, 'aria', 'ping me if the websocket drops, I’m testing reconnects today', 60);

const dmNova = createDm('dm', ['aria', 'nova']);
post(dmNova, 'nova', 'sent you the motion specs for the message entrance', 500);
post(dmNova, 'aria', 'got them, thank you!', 480);

const dmGroup = createDm('group', ['aria', 'nova', 'mira'], 'design crew');
post(dmGroup, 'mira', 'dropping the logo files in #design in a bit', 210);
post(dmGroup, 'nova', '🎉', 205);
post(dmGroup, 'aria', "can't wait", 200);

/* -------------------------------- friends ------------------------------- */
function friend(a: string, b: string, status = 'accepted') {
  db.prepare('INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, ?)').run(
    uid(a),
    uid(b),
    status,
    t(60 * 24 * 12),
  );
}
friend('aria', 'kai');
friend('aria', 'nova');
friend('aria', 'mira');
friend('theo', 'aria', 'pending'); // incoming request for aria
friend('aria', 'jules', 'pending'); // aria's outgoing request
friend('kai', 'theo');
friend('kai', 'nova');

/* ---------------------------------- pins --------------------------------- */
function pin(target: Posted, username: string, minutesAgo: number) {
  db.prepare('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(t(minutesAgo), uid(username), target.id);
}

// Pins are curated by the owner and admins, so the demo data only pins as aria
// (owner of Nimbus HQ) and kai (admin there).
pin(sidebar, 'aria', 280);
pin(orbit, 'kai', 560);
pin(race, 'kai', 190);
pin(threadRoot, 'aria', 350);

/* ------------------------------ read states ----------------------------- */
function markRead(channelId: string, uptoSeq?: number) {
  const seq =
    uptoSeq ?? (db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE channel_id = ?').get(channelId) as { s: number }).s;
  db.prepare(
    'INSERT INTO read_states (user_id, channel_id, last_seq, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET last_seq = excluded.last_seq',
  ).run(uid('aria'), channelId, seq, now());
}

markRead(general);
markRead(announcements);
markRead(engineering);
markRead(lobby);
markRead(dmKai);
markRead(threadId, 0);
// #design is read up to "the 16px favicon test..." so the last few show as unread.
markRead(design, emptyState.seq);
// #random and #music are intentionally unread.

/* -------------------------------- invites ------------------------------- */
db.prepare('INSERT INTO invites (code, guild_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(
  'NIMBUS01',
  hq.guildId,
  uid('aria'),
  now(),
);

/* -------------------------------- mentions ------------------------------ */
// Mentions are normally written by the API; the seed inserts messages straight
// into SQLite, so derive them here for the demo inbox.
backfillMentions();

console.log('\n  Seeded Nimbus demo workspace.');
console.log('  Sign in with:  aria@nimbus.chat  /  nimbus123');
console.log('  Invite code:   NIMBUS01\n');
