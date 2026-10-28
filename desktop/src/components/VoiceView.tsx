import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Volume2,
} from 'lucide-react';
import { selectActiveChannel, useStore } from '../store/store';
import { useVoiceStore } from '../store/voice';
import { Avatar, Button } from './ui';

/**
 * The "room" view for a voice channel: who is here, and the controls to join,
 * mute or leave. There is no message history — voice channels are for talking.
 */
export function VoiceView() {
  const channel = useStore(selectActiveChannel);
  const me = useStore((s) => s.me);
  const channelId = channel?.id ?? null;
  const participants = useStore((s) => (channelId ? s.voice[channelId] : undefined)) ?? [];

  const myChannelId = useVoiceStore((s) => s.channelId);
  const phase = useVoiceStore((s) => s.phase);
  const muted = useVoiceStore((s) => s.muted);
  const deafened = useVoiceStore((s) => s.deafened);
  const speaking = useVoiceStore((s) => s.speaking);
  const screenSharing = useVoiceStore((s) => s.screenSharing);
  const remoteScreens = useVoiceStore((s) => s.remoteScreens);
  const join = useVoiceStore((s) => s.join);
  const leave = useVoiceStore((s) => s.leave);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const beginScreenShare = useVoiceStore((s) => s.beginScreenShare);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);

  if (!channel) {
    return (
      <div className="chat">
        <div className="chat-placeholder">
          <div className="chat-placeholder-icon">
            <Volume2 size={44} />
          </div>
          <h2>No channel selected</h2>
          <p>Pick a voice channel from the sidebar to drop in.</p>
        </div>
      </div>
    );
  }

  const joined = myChannelId === channel.id && phase !== 'idle';
  const elsewhere = Boolean(myChannelId && myChannelId !== channel.id);
  const connecting = joined && phase === 'connecting';

  return (
    <div className="chat voice-view">
      <header className="chat-head">
        <div className="chat-head-main">
          <Volume2 size={22} />
          <h1>{channel.name}</h1>
          {channel.topic && (
            <>
              <span className="chat-head-divider" />
              <p className="chat-topic" title={channel.topic}>
                {channel.topic}
              </p>
            </>
          )}
          <span className="chat-head-divider" />
          <p className="chat-topic">
            {participants.length === 0
              ? 'Nobody here yet'
              : `${participants.length} ${participants.length === 1 ? 'person' : 'people'} in voice`}
          </p>
        </div>
      </header>

      <div className="voice-stage">
        <div className="voice-stage-head">
          <div>
            <h2>{joined ? 'You are in this channel' : `Join ${channel.name}`}</h2>
            <p>
              {joined
                ? 'Your microphone is live. Mute yourself any time.'
                : 'Calls connect directly between people, up to five at a time.'}
            </p>
          </div>
          <span className={`voice-cap ${participants.length >= 5 ? 'is-full' : ''}`}>
            {participants.length}/5
          </span>
        </div>

        {participants.length === 0 ? (
          <div className="voice-empty">
            <div className="voice-empty-icon">
              <Headphones size={30} />
            </div>
            <h3>Quiet in here</h3>
            <p>Be the first to hop in. Others will see you and can join.</p>
          </div>
        ) : (
          <div className="voice-grid">
            {participants.map((person) => {
              const isMe = person.userId === me?.id;
              const sharing = isMe ? screenSharing : Boolean(remoteScreens[person.userId]);
              return (
                <div
                  key={person.userId}
                  className={`voice-tile ${speaking[person.userId] ? 'is-speaking' : ''} ${
                    isMe ? 'is-me' : ''
                  }`}
                >
                  <div className="voice-tile-avatar">
                    <Avatar
                      name={person.displayName}
                      color={person.avatarColor}
                      src={person.avatarUrl}
                      size={84}
                    />
                    {person.muted && (
                      <span className="voice-tile-mute" title="Muted">
                        <MicOff size={13} />
                      </span>
                    )}
                    {sharing && (
                      <span className="voice-tile-screen" title="Sharing screen">
                        <ScreenShare size={12} />
                      </span>
                    )}
                  </div>
                  <span className="voice-tile-name">
                    {person.displayName}
                    {isMe ? ' (you)' : ''}
                  </span>
                  {person.deafened && <span className="voice-tile-sub">Deafened</span>}
                </div>
              );
            })}
          </div>
        )}

        <div className="voice-controls">
          {joined ? (
            <>
              <Button
                variant={muted ? 'danger' : 'secondary'}
                onClick={toggleMute}
                disabled={deafened}
                title={deafened ? 'Undeafen to unmute' : muted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {muted ? <MicOff size={17} /> : <Mic size={17} />}
                {muted ? 'Unmute' : 'Mute'}
              </Button>
              <Button
                variant={deafened ? 'danger' : 'secondary'}
                onClick={toggleDeafen}
                title={deafened ? 'Undeafen' : 'Deafen'}
              >
                {deafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
                {deafened ? 'Undeafen' : 'Deafen'}
              </Button>
              <Button
                variant={screenSharing ? 'danger' : 'secondary'}
                onClick={screenSharing ? stopScreenShare : beginScreenShare}
                title={screenSharing ? 'Stop sharing your screen' : 'Share your screen'}
              >
                {screenSharing ? <ScreenShareOff size={17} /> : <ScreenShare size={17} />}
                {screenSharing ? 'Stop sharing' : 'Share screen'}
              </Button>
              <Button variant="danger" onClick={leave}>
                <PhoneOff size={17} />
                Disconnect
              </Button>
            </>
          ) : (
            <Button onClick={() => void join(channel.id)} disabled={connecting}>
              <Volume2 size={17} />
              {connecting ? 'Connecting…' : elsewhere ? 'Switch to this channel' : 'Join voice'}
            </Button>
          )}
        </div>

        <p className="voice-note">
          Voice stays on this machine or your local network. Up to five people can be in a call at once.
        </p>
      </div>
    </div>
  );
}
