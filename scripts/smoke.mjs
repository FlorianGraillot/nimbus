#!/usr/bin/env node
/**
 * End-to-end smoke test for the Nimbus API + gateway.
 *
 *   node scripts/smoke.mjs            # against http://127.0.0.1:4000
 *   NIMBUS_API=http://host:port node scripts/smoke.mjs
 *
 * Creates a throwaway server + channel, exercises the main flows, then
 * removes what it created. Safe to run against the seeded demo database.
 */
const API = process.env.NIMBUS_API ?? 'http://127.0.0.1:4000';
const WS = API.replace(/^http/, 'ws');

const DEMO = { email: 'aria@nimbus.chat', password: 'nimbus123' };
const OTHER = { email: 'kai@nimbus.chat', password: 'nimbus123' };

let passed = 0;
const failures = [];

function ok(label, detail = '') {
  passed += 1;
  console.log(`  \u001b[32m✓\u001b[0m ${label}${detail ? ` \u001b[90m(${detail})\u001b[0m` : ''}`);
}

function check(label, condition, detail = '') {
  if (condition) ok(label, detail);
  else {
    failures.push(label);
    console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? ` \u001b[90m(${detail})\u001b[0m` : ''}`);
  }
}

async function req(method, path, { token, body, auth = true } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function login(account) {
  const { status, data } = await req('POST', '/api/auth/login', { body: account, auth: false });
  if (status !== 200) throw new Error(`login failed for ${account.email}: ${status} ${JSON.stringify(data)}`);
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal gateway client for the voice tests: sends frames and waits for the
 * next matching one. Voice is ephemeral, so these sockets are also what keeps
 * a participant "in" a call.
 */
function gatewayClient(accessToken) {
  const socket = new WebSocket(`${WS}/gateway?token=${accessToken}`);
  const events = [];
  let index = 0;

  socket.addEventListener('message', (event) => {
    try {
      events.push(JSON.parse(event.data));
    } catch {
      /* ignore malformed frames */
    }
  });

  return {
    socket,
    events,
    opened: new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(true), { once: true });
      socket.addEventListener('error', () => reject(new Error('gateway socket error')), { once: true });
    }),
    send(t, d) {
      socket.send(JSON.stringify({ t, d }));
    },
    async waitFor(match, timeout = 4000) {
      const test = typeof match === 'string' ? (frame) => frame.t === match : match;
      const deadline = Date.now() + timeout;
      for (;;) {
        for (let i = index; i < events.length; i += 1) {
          if (test(events[i])) {
            index = i + 1;
            return events[i];
          }
        }
        if (Date.now() > deadline) return null;
        await sleep(20);
      }
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

async function main() {
  console.log(`\nNimbus smoke test → ${API}\n`);

  /* ------------------------------- health -------------------------------- */
  const health = await req('GET', '/api/health', { auth: false });
  check('GET /api/health', health.status === 200 && health.data?.ok === true);

  /* -------------------------------- auth --------------------------------- */
  const aria = await login(DEMO);
  const kai = await login(OTHER);
  ok('login demo accounts', 'aria + kai');
  check('access + refresh tokens issued', Boolean(aria.accessToken && aria.refreshToken));

  const me = await req('GET', '/api/bootstrap', { token: aria.accessToken });
  check('GET /api/bootstrap', me.status === 200 && Array.isArray(me.data?.guilds));
  check('bootstrap has seeded workspace', (me.data?.guilds?.length ?? 0) >= 2, `${me.data?.guilds?.length} servers`);

  const refreshed = await req('POST', '/api/auth/refresh', {
    body: { refreshToken: aria.refreshToken },
    auth: false,
  });
  check('POST /api/auth/refresh rotates tokens', refreshed.status === 200 && refreshed.data.accessToken !== aria.accessToken);
  const token = refreshed.data.accessToken;

  /* -------------------------------- guild -------------------------------- */
  const stamp = Date.now().toString(36).slice(-5);
  const created = await req('POST', '/api/guilds', { token, body: { name: `Smoke ${stamp}` } });
  check('POST /api/guilds', created.status === 201 && Boolean(created.data?.guild?.id));
  const guildId = created.data.guild.id;
  check('new server seeds a default channel', (created.data.channels?.length ?? 0) > 0);

  const patchedGuild = await req('PATCH', `/api/guilds/${guildId}`, {
    token,
    body: { name: `Smoke ${stamp} ✓`, iconColor: '#3fa9ff' },
  });
  check('PATCH /api/guilds/:id', patchedGuild.status === 200 && patchedGuild.data.guild.iconColor === '#3fa9ff');

  const channel = await req('POST', `/api/guilds/${guildId}/channels`, {
    token,
    body: { name: 'smoke-room', topic: 'temporary' },
  });
  check('POST /api/guilds/:id/channels', channel.status === 201 && channel.data.channel.name === 'smoke-room');
  const channelId = channel.data.channel.id;

  const renamed = await req('PATCH', `/api/channels/${channelId}`, {
    token,
    body: { name: 'smoke-room-2', topic: 'still temporary' },
  });
  check('PATCH /api/channels/:id', renamed.status === 200 && renamed.data.channel.name === 'smoke-room-2');

  /* -------------------------------- invites ------------------------------ */
  const invite = await req('POST', `/api/guilds/${guildId}/invites`, { token });
  check('POST invite', invite.status === 201 && Boolean(invite.data.code));

  const preview = await req('GET', `/api/invites/${invite.data.code}`, { auth: false });
  check('GET invite preview (public)', preview.status === 200 && preview.data.guild.id === guildId);

  const joined = await req('POST', `/api/invites/${invite.data.code}/join`, { token: kai.accessToken });
  check('POST invite join', joined.status === 200);

  const reusableInvite = await req('POST', `/api/guilds/${guildId}/invites`, { token });
  check(
    'POST invite without options reuses the active code',
    reusableInvite.status === 201 && reusableInvite.data.code === invite.data.code,
  );

  const members = await req('GET', '/api/bootstrap', { token: kai.accessToken });
  check('joined server appears in bootstrap', members.data.guilds.some((g) => g.id === guildId));

  /* ------------------------------ permissions ---------------------------- */
  const memberCreate = await req('POST', `/api/guilds/${guildId}/channels`, {
    token: kai.accessToken,
    body: { name: 'nope' },
  });
  check('member cannot create a channel', memberCreate.status === 403);

  const memberRename = await req('PATCH', `/api/channels/${channelId}`, {
    token: kai.accessToken,
    body: { name: 'nope' },
  });
  check('member cannot edit a channel', memberRename.status === 403);

  const memberDeleteChannel = await req('DELETE', `/api/channels/${channelId}`, { token: kai.accessToken });
  check('member cannot delete a channel', memberDeleteChannel.status === 403);

  const memberRenameGuild = await req('PATCH', `/api/guilds/${guildId}`, {
    token: kai.accessToken,
    body: { name: 'Nope' },
  });
  check('member cannot rename the server', memberRenameGuild.status === 403);

  const memberDeleteGuild = await req('DELETE', `/api/guilds/${guildId}`, { token: kai.accessToken });
  check('member cannot delete the server', memberDeleteGuild.status === 403);

  const memberRole = await req('PATCH', `/api/guilds/${guildId}/members/${aria.user.id}`, {
    token: kai.accessToken,
    body: { role: 'admin' },
  });
  check('member cannot change roles', memberRole.status === 403);

  const promote = await req('PATCH', `/api/guilds/${guildId}/members/${kai.user.id}`, {
    token,
    body: { role: 'admin' },
  });
  check('owner can grant admin', promote.status === 200 && promote.data.member.role === 'admin');

  const adminCreate = await req('POST', `/api/guilds/${guildId}/channels`, {
    token: kai.accessToken,
    body: { name: 'admin-room' },
  });
  check('admin can create a channel', adminCreate.status === 201);
  const adminChannelId = adminCreate.data.channel.id;

  const adminRename = await req('PATCH', `/api/channels/${adminChannelId}`, {
    token: kai.accessToken,
    body: { name: 'admin-room-2' },
  });
  check('admin can edit a channel', adminRename.status === 200);

  const adminDeleteGuild = await req('DELETE', `/api/guilds/${guildId}`, { token: kai.accessToken });
  check('admin cannot delete the server', adminDeleteGuild.status === 403);

  const adminPromote = await req('PATCH', `/api/guilds/${guildId}/members/${aria.user.id}`, {
    token: kai.accessToken,
    body: { role: 'admin' },
  });
  check('admin cannot change roles', adminPromote.status === 403);

  const adminDeleteChannel = await req('DELETE', `/api/channels/${adminChannelId}`, { token: kai.accessToken });
  check('admin can delete a channel', adminDeleteChannel.status === 200);

  const demote = await req('PATCH', `/api/guilds/${guildId}/members/${kai.user.id}`, {
    token,
    body: { role: 'member' },
  });
  check('owner can revoke admin', demote.status === 200 && demote.data.member.role === 'member');

  const demotedCreate = await req('POST', `/api/guilds/${guildId}/channels`, {
    token: kai.accessToken,
    body: { name: 'nope-2' },
  });
  check('demoted member loses channel rights', demotedCreate.status === 403);

  const ownerRole = await req('PATCH', `/api/guilds/${guildId}/members/${aria.user.id}`, {
    token,
    body: { role: 'member' },
  });
  check('owner role cannot be changed', ownerRole.status === 400);

  /* --------------------------- invite management -------------------------- */
  const limitedInvite = await req('POST', `/api/guilds/${guildId}/invites`, {
    token,
    body: { maxUses: 1, expiresInMinutes: 60 },
  });
  check(
    'POST invite with limits',
    limitedInvite.status === 201 &&
      limitedInvite.data.maxUses === 1 &&
      typeof limitedInvite.data.expiresAt === 'number',
  );

  const disposableInvite = await req('POST', `/api/guilds/${guildId}/invites`, { token, body: { maxUses: 5 } });
  check('POST invite with a use cap', disposableInvite.status === 201 && disposableInvite.data.maxUses === 5);

  const memberInviteList = await req('GET', `/api/guilds/${guildId}/invites`, { token: kai.accessToken });
  check('member cannot list invites', memberInviteList.status === 403);

  const inviteList = await req('GET', `/api/guilds/${guildId}/invites`, { token });
  check(
    'GET invites lists active invites',
    inviteList.status === 200 &&
      inviteList.data.invites.some((row) => row.code === limitedInvite.data.code) &&
      inviteList.data.invites.some((row) => row.code === invite.data.code),
  );

  const novaAccount = await login({ email: 'nova@nimbus.chat', password: 'nimbus123' });
  const novaJoin = await req('POST', `/api/invites/${limitedInvite.data.code}/join`, {
    token: novaAccount.accessToken,
  });
  check('limited invite admits its first use', novaJoin.status === 200);

  const spentInvite = await req('GET', `/api/invites/${limitedInvite.data.code}`, { auth: false });
  check('maxed-out invite is rejected', spentInvite.status === 410);

  const revokedInvite = await req('DELETE', `/api/guilds/${guildId}/invites/${disposableInvite.data.code}`, { token });
  check('DELETE invite revokes it', revokedInvite.status === 200 && revokedInvite.data.invite.active === false);

  const revokedPreview = await req('GET', `/api/invites/${disposableInvite.data.code}`, { auth: false });
  check('revoked invite cannot be previewed', revokedPreview.status === 410);

  const revokedJoin = await req('POST', `/api/invites/${disposableInvite.data.code}/join`, {
    token: kai.accessToken,
  });
  check('revoked invite cannot be joined', revokedJoin.status === 410);

  /* ------------------------------- messages ------------------------------ */
  const sent = await req('POST', `/api/channels/${channelId}/messages`, {
    token,
    body: { content: 'smoke test message', nonce: `smoke-${stamp}` },
  });
  check('POST message', sent.status === 201 && sent.data.message.content === 'smoke test message');
  const messageId = sent.data.message.id;

  const edited = await req('PATCH', `/api/messages/${messageId}`, { token, body: { content: 'edited smoke message' } });
  check('PATCH message', edited.status === 200 && edited.data.message.content === 'edited smoke message');

  const reacted = await req('POST', `/api/messages/${messageId}/reactions`, { token: kai.accessToken, body: { emoji: '🔥' } });
  check('POST reaction (other user)', reacted.status === 200);

  const listed = await req('GET', `/api/channels/${channelId}/messages?limit=50`, { token });
  const seen = listed.data?.messages?.find((m) => m.id === messageId);
  check('GET messages includes reaction', Boolean(seen) && seen.reactions?.[0]?.count === 1);

  const thread = await req('POST', `/api/messages/${messageId}/thread`, { token, body: { name: 'smoke thread' } });
  check('POST thread', thread.status === 201 && Boolean(thread.data?.channel?.id));
  const threadId = thread.data.channel.id;

  const reply = await req('POST', `/api/channels/${threadId}/messages`, { token, body: { content: 'thread reply' } });
  check('POST thread reply', reply.status === 201);

  const threads = await req('GET', `/api/channels/${channelId}/threads`, { token });
  check('GET channel threads', threads.data?.threads?.some((t) => t.id === threadId) === true);

  const read = await req('POST', `/api/channels/${channelId}/read`, { token, body: {} });
  check('POST read state', read.status === 200 && typeof read.data.seq === 'number');

  const otherMessage = await req('POST', `/api/channels/${channelId}/messages`, {
    token: kai.accessToken,
    body: { content: 'unread marker check' },
  });
  check('member can send a message', otherMessage.status === 201);

  const unreadAgain = await req('POST', `/api/channels/${channelId}/unread`, { token });
  check(
    'POST channel unread restores the unread marker',
    unreadAgain.status === 200 &&
      unreadAgain.data.unread.count >= 1 &&
      unreadAgain.data.lastSeq === unreadAgain.data.seq - 1,
  );

  /* ---------------------------------- pins -------------------------------- */
  const pinned = await req('PUT', `/api/messages/${messageId}/pin`, { token });
  check(
    'PUT message pin',
    pinned.status === 200 &&
      typeof pinned.data.message.pinnedAt === 'number' &&
      pinned.data.message.pinnedBy?.id === aria.user.id,
  );

  const pinList = await req('GET', `/api/channels/${channelId}/pins`, { token });
  check('GET channel pins', pinList.status === 200 && pinList.data.messages.some((m) => m.id === messageId));

  const memberPin = await req('PUT', `/api/messages/${messageId}/pin`, { token: novaAccount.accessToken });
  check('member cannot pin a message', memberPin.status === 403);

  const memberUnpin = await req('DELETE', `/api/messages/${messageId}/pin`, { token: novaAccount.accessToken });
  check('member cannot unpin a message', memberUnpin.status === 403);

  // kai was demoted back to member earlier in this run, so promote again to
  // prove an admin (not just the owner) can curate pins.
  const promoteForPin = await req('PATCH', `/api/guilds/${guildId}/members/${kai.user.id}`, {
    token,
    body: { role: 'admin' },
  });
  check('owner can grant admin for pin curation', promoteForPin.status === 200);

  const adminPin = await req('PUT', `/api/messages/${messageId}/pin`, { token: kai.accessToken });
  check('admin can pin a message', adminPin.status === 200 && adminPin.data.message.pinnedBy?.id === kai.user.id);

  const messageLookup = await req('GET', `/api/messages/${messageId}`, { token });
  check(
    'GET /api/messages/:id resolves channel + seq',
    messageLookup.status === 200 &&
      messageLookup.data.channel.id === channelId &&
      messageLookup.data.message.seq === sent.data.message.seq,
  );

  /* ---------------------------- search operators -------------------------- */
  const fromSearch = await req(
    'GET',
    `/api/search?q=${encodeURIComponent('from:aria smoke')}&guildId=${guildId}`,
    { token },
  );
  check(
    'search from: operator',
    fromSearch.status === 200 &&
      fromSearch.data.messages.length >= 1 &&
      fromSearch.data.operators.from === 'aria',
  );

  const inSearch = await req(
    'GET',
    `/api/search?q=${encodeURIComponent('in:smoke-room-2 smoke')}&guildId=${guildId}`,
    { token },
  );
  check(
    'search in: operator',
    inSearch.status === 200 &&
      inSearch.data.messages.length >= 1 &&
      inSearch.data.messages.every((m) => m.channelId === channelId),
  );

  const afterSearch = await req('GET', `/api/search?q=${encodeURIComponent('after:2000-01-01')}&guildId=${guildId}`, {
    token,
  });
  check('search after: operator', afterSearch.status === 200 && afterSearch.data.messages.length >= 1);

  const beforeSearch = await req('GET', `/api/search?q=${encodeURIComponent('before:2000-01-01')}&guildId=${guildId}`, {
    token,
  });
  check(
    'search before: operator excludes newer messages',
    beforeSearch.status === 200 && beforeSearch.data.messages.length === 0,
  );

  const unpinned = await req('DELETE', `/api/messages/${messageId}/pin`, { token });
  check('DELETE message pin', unpinned.status === 200 && unpinned.data.message.pinnedAt === null);

  /* --------------------------- notification prefs ------------------------- */
  const prefsList = await req('GET', '/api/notification-prefs', { token });
  check('GET notification prefs', prefsList.status === 200 && Array.isArray(prefsList.data.notificationPrefs));

  const muteChannel = await req('PUT', '/api/notification-prefs', {
    token,
    body: { scope: 'channel', targetId: channelId, level: 'none' },
  });
  check(
    'PUT channel notification pref',
    muteChannel.status === 200 &&
      muteChannel.data.notificationPrefs.some(
        (pref) => pref.scope === 'channel' && pref.targetId === channelId && pref.level === 'none',
      ),
  );

  const muteGuild = await req('PUT', '/api/notification-prefs', {
    token,
    body: { scope: 'guild', targetId: guildId, level: 'mentions' },
  });
  check(
    'PUT server notification pref',
    muteGuild.status === 200 &&
      muteGuild.data.notificationPrefs.some(
        (pref) => pref.scope === 'guild' && pref.targetId === guildId && pref.level === 'mentions',
      ),
  );

  const clearPref = await req('PUT', '/api/notification-prefs', {
    token,
    body: { scope: 'channel', targetId: channelId, level: null },
  });
  check(
    'null level clears a notification pref',
    clearPref.status === 200 &&
      !clearPref.data.notificationPrefs.some((pref) => pref.scope === 'channel' && pref.targetId === channelId),
  );

  const search = await req('GET', `/api/search?q=smoke&guildId=${guildId}`, { token });
  check('GET /api/search', search.status === 200 && search.data.messages.length >= 1);

  const removedReaction = await req('DELETE', `/api/messages/${messageId}/reactions/${encodeURIComponent('🔥')}`, {
    token: kai.accessToken,
  });
  check('DELETE reaction', removedReaction.status === 200);

  /* -------------------------------- inbox -------------------------------- */
  const theoAccount = await login({ email: 'theo@nimbus.chat', password: 'nimbus123' });
  const theoJoin = await req('POST', `/api/invites/${invite.data.code}/join`, { token: theoAccount.accessToken });
  check('inbox: second member joins the server', theoJoin.status === 200);

  const inboxBefore = await req('GET', '/api/inbox', { token: theoAccount.accessToken });
  check(
    'GET /api/inbox returns mentions + unread lists',
    inboxBefore.status === 200 &&
      Array.isArray(inboxBefore.data?.mentions) &&
      Array.isArray(inboxBefore.data?.unread),
    `${inboxBefore.data?.mentions?.length ?? 0} mentions, ${inboxBefore.data?.unread?.length ?? 0} unread`,
  );
  check(
    'inbox unread digest includes the joined channel',
    inboxBefore.data.unread.some((entry) => entry.channelId === channelId),
  );

  const mentionMessage = await req('POST', `/api/channels/${channelId}/messages`, {
    token,
    body: { content: '@theo inbox smoke check' },
  });
  check(
    'POST message resolves @mention',
    mentionMessage.status === 201 && mentionMessage.data.message.mentions.includes(theoAccount.user.id),
  );
  const mentionId = mentionMessage.data.message.id;

  const inboxMention = await req('GET', '/api/inbox', { token: theoAccount.accessToken });
  const listedMention = inboxMention.data.mentions.find((entry) => entry.id === mentionId);
  check(
    'GET /api/inbox lists the new mention',
    Boolean(listedMention) && listedMention.channelId === channelId && listedMention.author.id === aria.user.id,
  );

  await req('POST', `/api/channels/${channelId}/read`, { token: theoAccount.accessToken, body: {} });
  const inboxAfterRead = await req('GET', '/api/inbox', { token: theoAccount.accessToken });
  check(
    'reading a channel clears its mentions',
    !inboxAfterRead.data.mentions.some((entry) => entry.id === mentionId),
  );

  await req('POST', `/api/channels/${channelId}/messages`, { token, body: { content: '@theo one more ping' } });
  const markedRead = await req('POST', '/api/inbox/read', { token: theoAccount.accessToken });
  check('POST /api/inbox/read', markedRead.status === 200);
  const inboxEmptied = await req('GET', '/api/inbox', { token: theoAccount.accessToken });
  check(
    'mark all read empties the inbox',
    inboxEmptied.data.mentions.length === 0 && inboxEmptied.data.unread.length === 0,
    `${inboxEmptied.data.mentions.length} mentions, ${inboxEmptied.data.unread.length} unread`,
  );

  /* --------------------------- server cleanup ---------------------------- */
  const kicked = await req('DELETE', `/api/guilds/${guildId}/members/${kai.user.id}`, { token });
  check('DELETE guild member (kick)', kicked.status === 200);

  /* ---------------------------------- DMs -------------------------------- */
  const theo = await req('GET', '/api/users/search?q=theo', { token });
  const theoId = theo.data.users[0]?.id;
  const dm = await req('POST', '/api/dms', { token, body: { recipientIds: [theoId] } });
  check('POST /api/dms', dm.status === 201 && Boolean(dm.data.channel.id));
  const dmId = dm.data.channel.id;

  const dmMessage = await req('POST', `/api/channels/${dmId}/messages`, { token, body: { content: 'smoke dm' } });
  check('send DM message', dmMessage.status === 201);

  /* --------------------------------- blocks ------------------------------- */
  const miraAccount = await login({ email: 'mira@nimbus.chat', password: 'nimbus123' });
  const pendingRequest = await req('POST', '/api/friends/requests', {
    token: miraAccount.accessToken,
    body: { username: 'theo' },
  });
  check('friend request created for block test', pendingRequest.status === 201);

  const blockPending = await req('PUT', `/api/users/${theoId}/block`, { token: miraAccount.accessToken });
  check('PUT user block', blockPending.status === 200 && blockPending.data.blocked.includes(theoId));

  const miraFriends = await req('GET', '/api/friends', { token: miraAccount.accessToken });
  check(
    'blocking clears pending friend requests',
    !miraFriends.data.friends.some((friend) => friend.user.id === theoId),
  );

  const unblockPending = await req('DELETE', `/api/users/${theoId}/block`, { token: miraAccount.accessToken });
  check('DELETE user block clears it', unblockPending.status === 200 && !unblockPending.data.blocked.includes(theoId));

  // Blocking also clears pending requests. Remember whether the seeded
  // theo → aria request existed so it can be put back after the test.
  const friendsBeforeBlock = await req('GET', '/api/friends', { token });
  const hadPendingRequest = friendsBeforeBlock.data.friends.some(
    (friend) => friend.user.id === theoId && friend.state === 'incoming',
  );

  const blocked = await req('PUT', `/api/users/${theoId}/block`, { token });
  check('PUT user block (messaging)', blocked.status === 200 && blocked.data.blocked.includes(theoId));

  const blockedDm = await req('POST', `/api/channels/${dmId}/messages`, {
    token,
    body: { content: 'should not send' },
  });
  check('blocked user cannot be messaged', blockedDm.status === 403);

  const blockedDmCreate = await req('POST', '/api/dms', { token, body: { recipientIds: [theoId] } });
  check('cannot open a DM with a blocked user', blockedDmCreate.status === 403);

  const blockedFriendRequest = await req('POST', '/api/friends/requests', { token, body: { username: 'theo' } });
  check('cannot friend-request a blocked user', blockedFriendRequest.status === 403);

  const bootstrapBlocked = await req('GET', '/api/bootstrap', { token });
  check('bootstrap exposes blocked ids', bootstrapBlocked.data.blocked.includes(theoId));

  const unblocked = await req('DELETE', `/api/users/${theoId}/block`, { token });
  check('DELETE user block', unblocked.status === 200 && !unblocked.data.blocked.includes(theoId));

  const dmAfterUnblock = await req('POST', `/api/channels/${dmId}/messages`, {
    token,
    body: { content: 'smoke dm after unblock' },
  });
  check('unblocked user can be messaged again', dmAfterUnblock.status === 201);

  if (hadPendingRequest) {
    await req('POST', '/api/friends/requests', {
      token: theoAccount.accessToken,
      body: { username: 'aria' },
    });
  }

  const closed = await req('DELETE', `/api/dms/${dmId}`, { token });
  check('DELETE /api/dms/:id', closed.status === 200);

  /* -------------------------------- profile ------------------------------ */
  const before = me.data.user.customStatus ?? '';
  const profile = await req('PATCH', '/api/users/@me', {
    token,
    body: { customStatus: 'running smoke tests', status: 'idle' },
  });
  check('PATCH /api/users/@me', profile.status === 200 && profile.data.user.customStatus === 'running smoke tests');
  const restore = await req('PATCH', '/api/users/@me', { token, body: { customStatus: before, status: 'online' } });
  check('profile restored', restore.status === 200 && restore.data.user.customStatus === before);

  /* -------------------------------- avatars ------------------------------ */
  // 1×1 transparent PNG — the smallest thing that is a real image.
  const PIXEL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const uploaded = await req('POST', '/api/users/@me/avatar', { token, body: { dataUrl: PIXEL } });
  const avatarPath = uploaded.data?.user?.avatarUrl ?? '';
  check(
    'POST avatar stores a picture',
    uploaded.status === 200 && avatarPath.startsWith(`/api/users/${aria.user.id}/avatar?v=`),
  );

  const picture = await fetch(`${API}${avatarPath}`);
  check(
    'GET avatar serves the image without auth',
    picture.status === 200 && picture.headers.get('content-type') === 'image/png',
  );

  const withAvatar = await req('GET', '/api/bootstrap', { token });
  check('bootstrap exposes avatarUrl', withAvatar.data.user.avatarUrl === avatarPath);

  const authorAvatar = await req('GET', `/api/channels/${channelId}/messages?limit=5`, { token });
  check(
    'message authors carry avatarUrl',
    authorAvatar.data.messages.length > 0 && authorAvatar.data.messages.every((m) => 'avatarUrl' in m.author),
  );

  const notAnImage = await req('POST', '/api/users/@me/avatar', {
    token,
    body: { dataUrl: 'data:image/png;base64,bm90IGEgcGljdHVyZQ==' },
  });
  check('avatar rejects non-image bytes', notAnImage.status === 400);

  const cleared = await req('DELETE', '/api/users/@me/avatar', { token });
  check('DELETE avatar clears it', cleared.status === 200 && cleared.data.user.avatarUrl === null);

  const gone = await fetch(`${API}${avatarPath}`);
  check('avatar URL is gone after removal', gone.status === 404);

  /* ------------------------------- pictures ------------------------------ */
  const freshChannel = await req('GET', `/api/channels/${channelId}`, { token });
  check('channel DTO exposes the picture policy', freshChannel.data.channel.allowAttachments === true);

  const upload = await req('POST', '/api/attachments', {
    token,
    body: { dataUrl: PIXEL, width: 1, height: 1 },
  });
  const attachment = upload.data?.attachment;
  check(
    'POST /api/attachments stores a picture',
    upload.status === 201 &&
      Boolean(attachment?.id) &&
      attachment.url.startsWith(`/api/attachments/${attachment.id}?sig=`),
  );

  const signedImage = await fetch(`${API}${attachment.url}`);
  check(
    'signed picture URL serves the image without auth',
    signedImage.status === 200 && signedImage.headers.get('content-type') === 'image/png',
  );

  const unsignedImage = await fetch(`${API}/api/attachments/${attachment.id}`);
  check('picture URL needs a signature', unsignedImage.status === 403);

  const forgedImage = await fetch(`${API}/api/attachments/${attachment.id}?sig=not-a-real-signature`);
  check('forged picture signature is rejected', forgedImage.status === 403);

  const anonymousUpload = await req('POST', '/api/attachments', {
    body: { dataUrl: PIXEL, width: 1, height: 1 },
    auth: false,
  });
  check('upload requires a session', anonymousUpload.status === 401);

  const notAPicture = await req('POST', '/api/attachments', {
    token,
    body: { dataUrl: 'data:image/png;base64,bm90IGEgcGljdHVyZQ==', width: 1, height: 1 },
  });
  check('upload rejects non-image bytes', notAPicture.status === 400);

  const photoMessage = await req('POST', `/api/channels/${channelId}/messages`, {
    token,
    body: { content: '', attachmentIds: [attachment.id] },
  });
  check(
    'picture-only message sends with empty text',
    photoMessage.status === 201 &&
      photoMessage.data.message.content === '' &&
      photoMessage.data.message.attachments?.length === 1,
  );
  const photoMessageId = photoMessage.data.message.id;

  const listedPhoto = await req('GET', `/api/channels/${channelId}/messages?limit=10`, { token });
  const listedPhotoMessage = listedPhoto.data.messages.find((m) => m.id === photoMessageId);
  check(
    'GET messages returns the picture',
    listedPhotoMessage?.attachments?.[0]?.url === attachment.url,
  );

  const reuse = await req('POST', `/api/channels/${channelId}/messages`, {
    token,
    body: { attachmentIds: [attachment.id] },
  });
  check('an upload can only be sent once', reuse.status === 400);

  const emptyMessage = await req('POST', `/api/channels/${channelId}/messages`, { token, body: { content: '' } });
  check('empty message with no picture is rejected', emptyMessage.status === 400);

  const tooManyIds = Array.from({ length: 5 }, () => attachment.id);
  const tooMany = await req('POST', `/api/channels/${channelId}/messages`, {
    token,
    body: { attachmentIds: tooManyIds },
  });
  check('a message is capped at 4 pictures', tooMany.status === 400);

  const novaUpload = await req('POST', '/api/attachments', {
    token: novaAccount.accessToken,
    body: { dataUrl: PIXEL, width: 1, height: 1 },
  });
  check('member can upload a picture', novaUpload.status === 201);

  const foreignSend = await req('POST', `/api/channels/${channelId}/messages`, {
    token,
    body: { attachmentIds: [novaUpload.data.attachment.id] },
  });
  check('cannot send somebody else’s upload', foreignSend.status === 403);

  const policyOff = await req('PATCH', `/api/channels/${channelId}`, { token, body: { allowAttachments: false } });
  check(
    'PATCH channel turns pictures off',
    policyOff.status === 200 && policyOff.data.channel.allowAttachments === false,
  );

  const policyThread = await req('POST', `/api/messages/${photoMessageId}/thread`, {
    token,
    body: { name: 'picture policy thread' },
  });
  check(
    'threads inherit a text-only channel policy',
    policyThread.status === 201 && policyThread.data.channel.allowAttachments === false,
  );

  const memberUploadOff = await req('POST', '/api/attachments', {
    token: novaAccount.accessToken,
    body: { dataUrl: PIXEL, width: 1, height: 1 },
  });
  const memberSendOff = await req('POST', `/api/channels/${channelId}/messages`, {
    token: novaAccount.accessToken,
    body: { attachmentIds: [memberUploadOff.data.attachment.id] },
  });
  check('member cannot send a picture when the channel is text only', memberSendOff.status === 403);

  const memberTextOff = await req('POST', `/api/channels/${channelId}/messages`, {
    token: novaAccount.accessToken,
    body: { content: 'text is still fine' },
  });
  check('members can still send text when pictures are off', memberTextOff.status === 201);

  const ownerUploadOff = await req('POST', '/api/attachments', {
    token,
    body: { dataUrl: PIXEL, width: 1, height: 1 },
  });
  const ownerSendOff = await req('POST', `/api/channels/${channelId}/messages`, {
    token,
    body: { attachmentIds: [ownerUploadOff.data.attachment.id] },
  });
  check('owner bypasses the picture policy', ownerSendOff.status === 201);

  const promoteNova = await req('PATCH', `/api/guilds/${guildId}/members/${novaAccount.user.id}`, {
    token,
    body: { role: 'admin' },
  });
  const adminUploadOff = await req('POST', '/api/attachments', {
    token: novaAccount.accessToken,
    body: { dataUrl: PIXEL, width: 1, height: 1 },
  });
  const adminSendOff = await req('POST', `/api/channels/${channelId}/messages`, {
    token: novaAccount.accessToken,
    body: { attachmentIds: [adminUploadOff.data.attachment.id] },
  });
  check(
    'admin bypasses the picture policy',
    promoteNova.status === 200 && adminSendOff.status === 201,
  );

  await req('PATCH', `/api/guilds/${guildId}/members/${novaAccount.user.id}`, { token, body: { role: 'member' } });
  const policyOn = await req('PATCH', `/api/channels/${channelId}`, { token, body: { allowAttachments: true } });
  check(
    'PATCH channel turns pictures back on',
    policyOn.status === 200 && policyOn.data.channel.allowAttachments === true,
  );

  const policyThreadAfter = await req('GET', `/api/channels/${policyThread.data.channel.id}`, { token });
  check(
    'policy changes reach existing threads',
    policyThreadAfter.status === 200 && policyThreadAfter.data.channel.allowAttachments === true,
  );

  const memberUploadOn = await req('POST', '/api/attachments', {
    token: novaAccount.accessToken,
    body: { dataUrl: PIXEL, width: 1, height: 1 },
  });
  const memberSendOn = await req('POST', `/api/channels/${channelId}/messages`, {
    token: novaAccount.accessToken,
    body: { content: 'picture after re-enable', attachmentIds: [memberUploadOn.data.attachment.id] },
  });
  check('member can send pictures again once re-enabled', memberSendOn.status === 201);

  // Leave a picture-only message as the newest one so the inbox digest has to
  // describe it without any text to show.
  const ariaUpload = await req('POST', '/api/attachments', {
    token,
    body: { dataUrl: PIXEL, width: 1, height: 1 },
  });
  const ariaPhotoOnly = await req('POST', `/api/channels/${channelId}/messages`, {
    token,
    body: { attachmentIds: [ariaUpload.data.attachment.id] },
  });
  check('owner can send a picture-only message', ariaPhotoOnly.status === 201);

  const inboxWithPhoto = await req('GET', '/api/inbox', { token: theoAccount.accessToken });
  const photoUnread = inboxWithPhoto.data.unread.find((entry) => entry.channelId === channelId);
  check(
    'inbox digest flags a picture-only last message',
    Boolean(photoUnread?.last) &&
      photoUnread.last.hasAttachments === true &&
      photoUnread.last.content === '',
  );

  const deletedPhoto = await req('DELETE', `/api/messages/${photoMessageId}`, { token });
  const goneImage = await fetch(`${API}${attachment.url}`);
  check(
    'deleting a message deletes its picture',
    deletedPhoto.status === 200 && goneImage.status === 404,
  );

  /* -------------------------------- gateway ------------------------------ */
  await new Promise((resolve) => {
    const socket = new WebSocket(`${WS}/gateway?token=${token}`);
    const timer = setTimeout(() => {
      check('gateway connects + READY', false, 'timeout');
      socket.close();
      resolve();
    }, 4000);

    socket.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data);
      if (payload.t === 'READY') {
        check('gateway connects + READY', payload.d.userId === aria.user.id);
        socket.send(JSON.stringify({ t: 'PING' }));
      }
      if (payload.t === 'PONG') {
        check('gateway PING → PONG', true);
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      check('gateway connects + READY', false, 'socket error');
      resolve();
    });
  });

  /* --------------------------------- voice ------------------------------- */
  const voiceChannel = await req('POST', `/api/guilds/${guildId}/channels`, {
    token,
    body: { name: 'smoke-voice', type: 'voice' },
  });
  check(
    'POST voice channel',
    voiceChannel.status === 201 && voiceChannel.data.channel.type === 'voice',
  );
  const voiceChannelId = voiceChannel.data.channel.id;

  const duplicateVoice = await req('POST', `/api/guilds/${guildId}/channels`, {
    token,
    body: { name: 'smoke-voice', type: 'voice' },
  });
  check('voice channel names are unique', duplicateVoice.status === 409);

  const sameNameText = await req('POST', `/api/guilds/${guildId}/channels`, {
    token,
    body: { name: 'smoke-voice', type: 'text' },
  });
  check('a text and a voice channel may share a name', sameNameText.status === 201);

  const memberVoiceCreate = await req('POST', `/api/guilds/${guildId}/channels`, {
    token: kai.accessToken,
    body: { name: 'nope-voice', type: 'voice' },
  });
  check('member cannot create a voice channel', memberVoiceCreate.status === 403);

  const voiceMessage = await req('POST', `/api/channels/${voiceChannelId}/messages`, {
    token,
    body: { content: 'hello from a voice channel' },
  });
  check('voice channels reject text messages', voiceMessage.status === 400);

  /* kai was kicked earlier in the suite; the call tests need him back in. */
  const kaiRejoin = await req('POST', `/api/invites/${invite.data.code}/join`, { token: kai.accessToken });
  check('voice: kicked member can rejoin the server', kaiRejoin.status === 200);

  const ariaVoice = gatewayClient(token);
  await ariaVoice.opened;
  await ariaVoice.waitFor('READY');
  ariaVoice.send('VOICE_JOIN', { channelId: voiceChannelId, muted: false });
  const ariaJoined = await ariaVoice.waitFor('VOICE_JOINED');
  check(
    'voice: first person joins',
    ariaJoined?.d?.channelId === voiceChannelId && ariaJoined.d.participants.length === 1,
  );

  const kaiVoice = gatewayClient(kai.accessToken);
  await kaiVoice.opened;
  await kaiVoice.waitFor('READY');
  kaiVoice.send('VOICE_JOIN', { channelId: voiceChannelId });
  const kaiJoined = await kaiVoice.waitFor('VOICE_JOINED');
  check('voice: a second person sees the room', kaiJoined?.d?.participants?.length === 2);

  const ariaSawKai = await ariaVoice.waitFor(
    (frame) => frame.t === 'VOICE_STATE_UPDATE' && frame.d.participants.length === 2,
  );
  check('voice: the room is notified when someone joins', Boolean(ariaSawKai));

  kaiVoice.send('VOICE_STATE', { channelId: voiceChannelId, muted: true, deafened: false });
  const mutedUpdate = await ariaVoice.waitFor(
    (frame) =>
      frame.t === 'VOICE_STATE_UPDATE' &&
      frame.d.participants.some((person) => person.userId === kai.user.id && person.muted === true),
  );
  check('voice: mute state is broadcast', Boolean(mutedUpdate));

  ariaVoice.send('VOICE_SIGNAL', {
    channelId: voiceChannelId,
    toUserId: kai.user.id,
    kind: 'offer',
    payload: { type: 'offer', sdp: 'v=0' },
  });
  const relayed = await kaiVoice.waitFor('VOICE_SIGNAL');
  check(
    'voice: signalling is relayed to the peer',
    relayed?.d?.fromUserId === aria.user.id && relayed.d.kind === 'offer',
  );

  const voiceBoot = await req('GET', '/api/bootstrap', { token: kai.accessToken });
  check(
    'bootstrap exposes live voice sessions',
    (voiceBoot.data.voice?.[voiceChannelId] ?? []).length === 2,
  );

  /* Access control: a voice channel in a server you are not in is off limits. */
  const privateGuild = await req('POST', '/api/guilds', { token, body: { name: `Voice ${stamp}` } });
  const privateVoice = await req('POST', `/api/guilds/${privateGuild.data.guild.id}/channels`, {
    token,
    body: { name: 'secret', type: 'voice' },
  });
  kaiVoice.send('VOICE_JOIN', { channelId: privateVoice.data.channel.id });
  const nonMember = await kaiVoice.waitFor('VOICE_ERROR');
  check(
    'voice: non-members cannot join a server voice channel',
    nonMember?.d?.stage === 'VOICE_JOIN',
  );
  await req('DELETE', `/api/guilds/${privateGuild.data.guild.id}`, { token });

  /* The mesh is capped at five people; the sixth gets a clear error. */
  await req('POST', `/api/invites/${invite.data.code}/join`, { token: miraAccount.accessToken });
  const julesAccount = await login({ email: 'jules@nimbus.chat', password: 'nimbus123' });
  await req('POST', `/api/invites/${invite.data.code}/join`, { token: julesAccount.accessToken });

  async function joinCall(accessToken) {
    const client = gatewayClient(accessToken);
    await client.opened;
    await client.waitFor('READY');
    client.send('VOICE_JOIN', { channelId: voiceChannelId });
    const frame = await client.waitFor((f) => f.t === 'VOICE_JOINED' || f.t === 'VOICE_ERROR');
    return { client, frame };
  }

  const novaCall = await joinCall(novaAccount.accessToken);
  check('voice: third participant joins', novaCall.frame?.t === 'VOICE_JOINED');
  const theoCall = await joinCall(theoAccount.accessToken);
  check('voice: fourth participant joins', theoCall.frame?.t === 'VOICE_JOINED');
  const miraCall = await joinCall(miraAccount.accessToken);
  check('voice: fifth participant joins', miraCall.frame?.t === 'VOICE_JOINED');
  const julesCall = await joinCall(julesAccount.accessToken);
  check(
    'voice: a sixth participant is refused',
    julesCall.frame?.t === 'VOICE_ERROR' && julesCall.frame.d.stage === 'VOICE_JOIN',
  );

  for (const call of [novaCall, theoCall, miraCall, julesCall]) call.client.close();
  kaiVoice.send('VOICE_LEAVE', { channelId: voiceChannelId });
  ariaVoice.send('VOICE_LEAVE', { channelId: voiceChannelId });
  await sleep(150);

  /* Direct-message calls ring the other person, who can accept or decline. */
  const dmWithKai = await req('POST', '/api/dms', { token, body: { recipientIds: [kai.user.id] } });
  const dmChannelId = dmWithKai.data.channel.id;
  ariaVoice.send('VOICE_JOIN', { channelId: dmChannelId });
  const dmJoined = await ariaVoice.waitFor('VOICE_JOINED');
  check('voice: DM calls join like a channel', dmJoined?.d?.channelId === dmChannelId);

  ariaVoice.send('VOICE_RING', { channelId: dmChannelId });
  const ring = await kaiVoice.waitFor('VOICE_RING');
  check(
    'voice: ringing reaches the other person',
    ring?.d?.channelId === dmChannelId && ring.d.from.id === aria.user.id,
  );
  const ringSent = await ariaVoice.waitFor('VOICE_RING_SENT');
  check('voice: the caller knows the ring went out', ringSent?.d?.count === 1);

  kaiVoice.send('VOICE_DECLINE', { channelId: dmChannelId });
  const declined = await ariaVoice.waitFor('VOICE_DECLINE');
  check('voice: a declined call tells the caller', declined?.d?.fromUserId === kai.user.id);
  ariaVoice.send('VOICE_LEAVE', { channelId: dmChannelId });
  await sleep(100);

  /* Blocking works for calls too, not just messages. */
  await req('PUT', `/api/users/${kai.user.id}/block`, { token });
  ariaVoice.send('VOICE_JOIN', { channelId: dmChannelId });
  await ariaVoice.waitFor('VOICE_JOINED');
  ariaVoice.send('VOICE_RING', { channelId: dmChannelId });
  const blockedRing = await ariaVoice.waitFor('VOICE_ERROR');
  check('voice: blocked users cannot be called', blockedRing?.d?.stage === 'VOICE_RING');
  ariaVoice.send('VOICE_LEAVE', { channelId: dmChannelId });
  await req('DELETE', `/api/users/${kai.user.id}/block`, { token });
  await sleep(100);

  /*
   * Direct calls are conversations: when one person leaves, the server closes
   * the call for whoever is left instead of stranding a one-person call.
   */
  ariaVoice.send('VOICE_JOIN', { channelId: dmChannelId });
  await ariaVoice.waitFor('VOICE_JOINED');
  kaiVoice.send('VOICE_JOIN', { channelId: dmChannelId });
  const dmBoth = await ariaVoice.waitFor(
    (f) => f.t === 'VOICE_STATE_UPDATE' && f.d.channelId === dmChannelId && f.d.participants.length === 2,
  );
  check('voice: both sides of a DM call are present', Boolean(dmBoth));

  ariaVoice.send('VOICE_LEAVE', { channelId: dmChannelId });
  const calleeClosed = await kaiVoice.waitFor(
    (f) => f.t === 'VOICE_CLOSED' && f.d.channelId === dmChannelId,
  );
  check('voice: the callee is told when the caller hangs up', calleeClosed?.d?.reason === 'peer-left');

  /* The other direction: the callee hangs up and the caller is closed out. */
  kaiVoice.send('VOICE_JOIN', { channelId: dmChannelId });
  await kaiVoice.waitFor('VOICE_JOINED');
  ariaVoice.send('VOICE_JOIN', { channelId: dmChannelId });
  await ariaVoice.waitFor('VOICE_JOINED');
  kaiVoice.send('VOICE_LEAVE', { channelId: dmChannelId });
  const callerClosed = await ariaVoice.waitFor(
    (f) => f.t === 'VOICE_CLOSED' && f.d.channelId === dmChannelId,
  );
  check('voice: the caller is told when the callee hangs up', callerClosed?.d?.reason === 'peer-left');

  /* Hanging up at the same moment must not produce errors or stale members. */
  ariaVoice.send('VOICE_JOIN', { channelId: dmChannelId });
  await ariaVoice.waitFor('VOICE_JOINED');
  kaiVoice.send('VOICE_JOIN', { channelId: dmChannelId });
  await kaiVoice.waitFor('VOICE_JOINED');
  ariaVoice.send('VOICE_LEAVE', { channelId: dmChannelId });
  kaiVoice.send('VOICE_LEAVE', { channelId: dmChannelId });
  /*
   * Either order is valid: the first leave closes the call for the other one,
   * so that person sees VOICE_CLOSED instead of their own VOICE_LEFT.
   */
  const ariaAfterRace = await ariaVoice.waitFor(
    (f) => f.t === 'VOICE_LEFT' || f.t === 'VOICE_CLOSED',
  );
  const kaiAfterRace = await kaiVoice.waitFor(
    (f) => f.t === 'VOICE_LEFT' || f.t === 'VOICE_CLOSED',
  );
  const emptyAfterRace = await req('GET', '/api/bootstrap', { token: aria.accessToken });
  check(
    'voice: a simultaneous hangup leaves no one behind',
    Boolean(ariaAfterRace) &&
      Boolean(kaiAfterRace) &&
      (emptyAfterRace.data.voice?.[dmChannelId] ?? []).length === 0,
  );

  /* A dropped socket is a hangup too, even if the client never says goodbye. */
  const dropDm = await req('POST', '/api/dms', {
    token,
    body: { recipientIds: [novaAccount.user.id] },
  });
  const dropChannelId = dropDm.data.channel.id;
  const novaDrop = gatewayClient(novaAccount.accessToken);
  await novaDrop.opened;
  await novaDrop.waitFor('READY');
  ariaVoice.send('VOICE_JOIN', { channelId: dropChannelId });
  await ariaVoice.waitFor('VOICE_JOINED');
  novaDrop.send('VOICE_JOIN', { channelId: dropChannelId });
  await novaDrop.waitFor('VOICE_JOINED');
  novaDrop.close();
  const closedOnDrop = await ariaVoice.waitFor(
    (f) => f.t === 'VOICE_CLOSED' && f.d.channelId === dropChannelId,
    6000,
  );
  check(
    'voice: an unexpected disconnect ends the call for the other person',
    closedOnDrop?.d?.reason === 'peer-left',
  );

  /* Server voice channels are rooms: they stay open when someone leaves. */
  ariaVoice.send('VOICE_JOIN', { channelId: voiceChannelId });
  await ariaVoice.waitFor('VOICE_JOINED');
  kaiVoice.send('VOICE_JOIN', { channelId: voiceChannelId });
  await kaiVoice.waitFor('VOICE_JOINED');
  ariaVoice.send('VOICE_LEAVE', { channelId: voiceChannelId });
  const roomStillOpen = await kaiVoice.waitFor(
    (f) => f.t === 'VOICE_STATE_UPDATE' && f.d.channelId === voiceChannelId && f.d.participants.length === 1,
  );
  check('voice: a server voice channel stays open when someone leaves', Boolean(roomStillOpen));
  const roomNotClosed = await kaiVoice.waitFor((f) => f.t === 'VOICE_CLOSED', 400);
  check('voice: a server voice channel is never auto-closed', roomNotClosed === null);
  kaiVoice.send('VOICE_LEAVE', { channelId: voiceChannelId });
  await sleep(100);

  /* A group call only ends when the last person is left alone. */
  const groupDm = await req('POST', '/api/dms', {
    token,
    body: { recipientIds: [kai.user.id, novaAccount.user.id] },
  });
  const groupChannelId = groupDm.data.channel.id;
  const novaVoice = gatewayClient(novaAccount.accessToken);
  await novaVoice.opened;
  await novaVoice.waitFor('READY');

  ariaVoice.send('VOICE_JOIN', { channelId: groupChannelId });
  await ariaVoice.waitFor('VOICE_JOINED');
  kaiVoice.send('VOICE_JOIN', { channelId: groupChannelId });
  await kaiVoice.waitFor('VOICE_JOINED');
  novaVoice.send('VOICE_JOIN', { channelId: groupChannelId });
  const groupThree = await novaVoice.waitFor(
    (f) => f.t === 'VOICE_JOINED' && f.d.participants.length === 3,
  );
  check('voice: a group call holds more than two people', Boolean(groupThree));

  ariaVoice.send('VOICE_LEAVE', { channelId: groupChannelId });
  const groupStillOpen = await kaiVoice.waitFor(
    (f) => f.t === 'VOICE_STATE_UPDATE' && f.d.channelId === groupChannelId && f.d.participants.length === 2,
  );
  check('voice: a group call continues while two people remain', Boolean(groupStillOpen));
  const groupNotClosed = await novaVoice.waitFor((f) => f.t === 'VOICE_CLOSED', 400);
  check('voice: a group call is not closed with two people left', groupNotClosed === null);

  kaiVoice.send('VOICE_LEAVE', { channelId: groupChannelId });
  const lastClosed = await novaVoice.waitFor(
    (f) => f.t === 'VOICE_CLOSED' && f.d.channelId === groupChannelId,
  );
  check('voice: the last person in a group call is closed out', lastClosed?.d?.reason === 'peer-left');
  novaVoice.close();

  /* Leaving a server or losing the channel ends the call. */
  kaiVoice.send('VOICE_JOIN', { channelId: voiceChannelId });
  const kickJoin = await kaiVoice.waitFor('VOICE_JOINED');
  check('voice: rejoin before the removal test', kickJoin?.d?.channelId === voiceChannelId);
  const kickedMember = await req('DELETE', `/api/guilds/${guildId}/members/${kai.user.id}`, { token });
  const kickLeft = await kaiVoice.waitFor((f) => f.t === 'VOICE_LEFT' || f.t === 'VOICE_CLOSED');
  check('voice: removing a member ends their call', kickedMember.status === 200 && Boolean(kickLeft));

  ariaVoice.send('VOICE_JOIN', { channelId: voiceChannelId });
  await ariaVoice.waitFor('VOICE_JOINED');
  const deletedVoice = await req('DELETE', `/api/channels/${voiceChannelId}`, { token });
  const voiceClosed = await ariaVoice.waitFor('VOICE_CLOSED');
  check(
    'deleting a voice channel disconnects everyone',
    deletedVoice.status === 200 && voiceClosed?.d?.channelId === voiceChannelId,
  );

  ariaVoice.close();
  kaiVoice.close();
  await sleep(100);

  /* -------------------------------- cleanup ------------------------------ */
  const deletedChannel = await req('DELETE', `/api/channels/${channelId}`, { token });
  check('DELETE channel', deletedChannel.status === 200);

  const deletedGuild = await req('DELETE', `/api/guilds/${guildId}`, { token });
  check('DELETE guild', deletedGuild.status === 200);

  await req('POST', '/api/auth/logout', { token, body: { refreshToken: refreshed.data.refreshToken } });

  await sleep(50);
  console.log(`\n${failures.length === 0 ? '\u001b[32mAll checks passed\u001b[0m' : `\u001b[31m${failures.length} failed\u001b[0m`} — ${passed} assertions.\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n\u001b[31mSmoke test crashed:\u001b[0m', error);
  process.exitCode = 1;
});
