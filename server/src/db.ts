import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const file = process.env.NIMBUS_DB ?? resolve(process.cwd(), 'data', 'nimbus.db');
mkdirSync(dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#6d5efc',
  bio           TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'online',
  custom_status TEXT NOT NULL DEFAULT '',
  simulated_presence INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS guilds (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon_color  TEXT NOT NULL DEFAULT '#6d5efc',
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id  TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname  TEXT NOT NULL DEFAULT '',
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_guild_members_user ON guild_members(user_id);

CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  guild_id       TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  name           TEXT NOT NULL DEFAULT '',
  type           TEXT NOT NULL DEFAULT 'text',
  topic          TEXT NOT NULL DEFAULT '',
  position       INTEGER NOT NULL DEFAULT 0,
  parent_id      TEXT,
  thread_root_id TEXT,
  created_by     TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_guild ON channels(guild_id, position);
CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_id);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  deleted_at INTEGER,
  system     INTEGER NOT NULL DEFAULT 0,
  pinned_at  INTEGER,
  pinned_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

CREATE TABLE IF NOT EXISTS read_states (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);

/* Pictures attached to messages. message_id stays NULL between upload and
 * send so a failed send does not leave half a message behind; abandoned rows
 * are cleaned up after a day. */
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id, message_id, created_at);

CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_addressee ON friendships(addressee_id);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  max_uses   INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);

/* Blocking is mutual for messaging: either direction prevents DMs. */
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

/* Per-channel / per-server notification levels, overriding the defaults. */
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  level      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope, target_id)
);

/* Mentions power the Inbox. One row per (message, mentioned user). */
CREATE TABLE IF NOT EXISTS mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id   TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_mentions_channel ON mentions(channel_id);

/* Small key/value store for one-off migrations that must run exactly once. */
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* ----------------------------- migrations ------------------------------ */

const guildMemberColumns = db.prepare('PRAGMA table_info(guild_members)').all() as { name: string }[];
if (!guildMemberColumns.some((column) => column.name === 'role')) {
  // Roles are 'member' or 'admin'. Ownership lives on guilds.owner_id and always wins.
  db.exec("ALTER TABLE guild_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
}

function addColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/* Pinned messages (added after the first release). */
addColumn('messages', 'pinned_at', 'INTEGER');
addColumn('messages', 'pinned_by', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(channel_id, pinned_at)');

/* Invite expiry / usage limits / revocation (added after the first release). */
addColumn('invites', 'max_uses', 'INTEGER');
addColumn('invites', 'expires_at', 'INTEGER');
addColumn('invites', 'revoked_at', 'INTEGER');

/* Profile pictures (added after the first release). The image is stored as a
 * data URL so the whole account still lives in this one database file. */
addColumn('users', 'avatar_data', 'TEXT');
addColumn('users', 'avatar_updated_at', 'INTEGER');

/* Per-channel picture policy (added after the first release). 1 = members may
 * attach pictures, 0 = text only. Owners and admins bypass it, like pins. */
addColumn('channels', 'allow_attachments', 'INTEGER NOT NULL DEFAULT 1');

/* Voice channels (added after the first release). The two demo servers get a
 * couple of them once, so a fresh checkout has somewhere to try calls. This is
 * additive only: it never edits or removes existing channels. */
const voiceSeedDone = db.prepare("SELECT 1 FROM app_meta WHERE key = 'demo_voice_channels_v1'").get();
if (!voiceSeedDone) {
  const demo: [string, string[]][] = [
    ['Nimbus HQ', ['Lounge', 'Music Room']],
    ['Pixel Club', ['Arcade']],
  ];
  for (const [guildName, names] of demo) {
    const guild = db.prepare('SELECT id FROM guilds WHERE name = ?').get(guildName) as { id: string } | undefined;
    if (!guild) continue;
    const hasVoice = db.prepare("SELECT 1 FROM channels WHERE guild_id = ? AND type = 'voice'").get(guild.id);
    if (hasVoice) continue;
    const next = (
      db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels WHERE guild_id = ?').get(guild.id) as {
        next: number;
      }
    ).next;
    names.forEach((name, index) => {
      db.prepare(
        `INSERT INTO channels (id, guild_id, name, type, topic, position, created_at)
         VALUES (?, ?, ?, 'voice', '', ?, ?)`,
      ).run(newId(), guild.id, name, next + index, Date.now());
    });
  }
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('demo_voice_channels_v1', ?)").run(String(Date.now()));
}

/** Short, roughly time-ordered id (base36 timestamp + random suffix). */
export function newId(): string {
  return Date.now().toString(36) + randomBytes(6).toString('hex');
}

export const now = () => Date.now();

/** Wrap a set of statements in a transaction. */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn)();
}
