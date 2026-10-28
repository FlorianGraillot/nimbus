import { useEffect, useRef, useState } from 'react';
import { useStore, selectActiveChannel } from './store/store';
import { api } from './lib/api';
import { AuthScreen } from './components/AuthScreen';
import { TitleBar } from './components/TitleBar';
import { GuildRail } from './components/GuildRail';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { VoiceView } from './components/VoiceView';
import { FriendsView } from './components/FriendsView';
import { InboxView } from './components/InboxView';
import { MemberList } from './components/MemberList';
import { ThreadPanel } from './components/ThreadPanel';
import { Modals } from './components/Modals';
import { CallOverlay } from './components/CallOverlay';
import { Logo } from './components/Logo';
import { Toasts } from './components/ui';
import { useVoiceStore } from './store/voice';

export function App() {
  const phase = useStore((s) => s.phase);
  const boot = useStore((s) => s.boot);
  const view = useStore((s) => s.view);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const channel = useStore(selectActiveChannel);
  const threadChannelId = useStore((s) => s.threadChannelId);
  const memberListOpen = useStore((s) => s.memberListOpen);
  const gatewayStatus = useStore((s) => s.gatewayStatus);

  const booted = useRef(false);
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void boot();
  }, [boot]);

  /* A deep link can arrive before sign-in; open the join dialog once we're ready. */
  useEffect(() => {
    if (phase !== 'ready' || !pendingInvite) return;
    useStore.getState().openModal('join-server', pendingInvite);
    setPendingInvite(null);
  }, [phase, pendingInvite]);

  /* Signing out (or losing the session) must not leave a hot microphone. */
  useEffect(() => {
    if (phase === 'auth') useVoiceStore.getState().reset();
  }, [phase]);

  /* After a reconnect the old peer connections are dead; rebuild them. */
  const previousGateway = useRef(gatewayStatus);
  useEffect(() => {
    if (previousGateway.current !== 'online' && gatewayStatus === 'online') {
      useVoiceStore.getState().resume();
    }
    previousGateway.current = gatewayStatus;
  }, [gatewayStatus]);

  /*
   * Signalling cannot survive a long gateway outage, and the server has already
   * dropped us from the session. Give a quick reconnect a chance, then end the
   * call instead of leaving a frozen call bar behind.
   */
  useEffect(() => {
    if (gatewayStatus !== 'offline') return;
    const timer = window.setTimeout(() => useVoiceStore.getState().connectionLost(), 8000);
    return () => window.clearTimeout(timer);
  }, [gatewayStatus]);

  const requestJoin = (code: string) => {
    if (useStore.getState().phase === 'ready') {
      useStore.getState().openModal('join-server', code);
    } else {
      setPendingInvite(code);
    }
  };

  /* Electron: notifications click-through and nimbus:// deep links */
  useEffect(() => {
    const bridge = window.nimbus;
    if (!bridge) return;

    const openChannel = (channelId: string) => useStore.getState().selectChannel(channelId);

    const openMessage = async (messageId: string) => {
      const state = useStore.getState();
      if (state.phase !== 'ready') return;
      const loaded = Object.values(state.messages)
        .flat()
        .find((message) => message.id === messageId);
      if (loaded) {
        await state.jumpToMessage(loaded.channelId, messageId, loaded.seq);
        return;
      }
      try {
        const res = await api.fetchMessage(messageId);
        await state.jumpToMessage(res.channel.id, messageId, res.message.seq);
      } catch (error) {
        state.pushToast(error instanceof Error ? error.message : 'Could not find that message', 'error');
      }
    };

    const offChannel = bridge.app.onOpenChannel(openChannel);
    const offLink = bridge.app.onDeepLink((url) => {
      const invite = /nimbus:\/\/invite\/([A-Za-z0-9_-]+)/.exec(url);
      if (invite) {
        requestJoin(invite[1]);
        return;
      }
      const message = /nimbus:\/\/message\/([A-Za-z0-9_-]+)/.exec(url);
      if (message) {
        void openMessage(message[1]);
        return;
      }
      const target = /nimbus:\/\/channel\/([A-Za-z0-9_-]+)/.exec(url);
      if (target) openChannel(target[1]);
    });

    const onJoinInvite = (event: Event) => requestJoin((event as CustomEvent<string>).detail);
    window.addEventListener('nimbus:join-invite', onJoinInvite);

    return () => {
      offChannel();
      offLink();
      window.removeEventListener('nimbus:join-invite', onJoinInvite);
    };
  }, []);

  /* Global shortcuts */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const state = useStore.getState();

      if (mod && (event.key === 'f' || event.key === 'k')) {
        event.preventDefault();
        state.openModal('search', state.activeChannelId ?? undefined);
        return;
      }

      if (mod && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        state.toggleMemberList();
        return;
      }

      if (event.key === 'Escape') {
        if (state.modal || state.profileUserId) return;
        if (state.threadChannelId) state.closeThread();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (phase === 'booting') {
    return (
      <div className="app">
        <TitleBar />
        <div className="boot">
          <div className="boot-logo">
            <Logo size={72} radius={22} />
          </div>
          <div className="boot-name">Nimbus</div>
          <div className="boot-hint">Warming up the clouds…</div>
          <div className="boot-bar">
            <span />
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'auth') {
    return (
      <div className="app">
        <TitleBar />
        <AuthScreen />
        <Toasts />
      </div>
    );
  }

  const showFriends = view === 'friends' && !activeChannelId;
  const showInbox = view === 'inbox';
  const showVoice = channel?.type === 'voice';
  const showMembers = Boolean(channel?.guildId) && !showVoice && memberListOpen && !threadChannelId;

  return (
    <div className="app">
      <TitleBar />

      {gatewayStatus === 'offline' && (
        <div className="offline-banner">
          <span className="offline-dot" />
          Reconnecting to Nimbus… messages you send will be delivered once the connection is back.
        </div>
      )}

      <div className="shell">
        <GuildRail />
        <Sidebar />

        <main className="main">
          {showInbox ? (
            <InboxView />
          ) : showFriends ? (
            <FriendsView />
          ) : showVoice ? (
            <VoiceView />
          ) : (
            <ChatView />
          )}
        </main>

        {threadChannelId && <ThreadPanel />}
        {showMembers && <MemberList />}
      </div>

      <Modals />
      <CallOverlay />
      <Toasts />
    </div>
  );
}
