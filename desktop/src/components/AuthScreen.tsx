import { useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, Eye, EyeOff, Sparkles } from 'lucide-react';
import { useStore } from '../store/store';
import { Button, Input } from './ui';
import { Logo, Wordmark } from './Logo';

const DEMO_EMAIL = 'aria@nimbus.chat';
const DEMO_PASSWORD = 'nimbus123';

export function AuthScreen() {
  const login = useStore((s) => s.login);
  const register = useStore((s) => s.register);
  const bootError = useStore((s) => s.bootError);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(bootError);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email.trim(), password);
      } else {
        await register({
          email: email.trim(),
          password,
          username: username.trim(),
          displayName: displayName.trim() || undefined,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function demoLogin() {
    setMode('login');
    setEmail(DEMO_EMAIL);
    setPassword(DEMO_PASSWORD);
    setError(null);
    setBusy(true);
    try {
      await login(DEMO_EMAIL, DEMO_PASSWORD);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in to the demo account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth-hero">
        <div className="auth-hero-glow" />
        <div className="auth-hero-inner">
          <div className="auth-brand">
            <Logo size={46} />
            <span>Nimbus</span>
          </div>

          <h1>
            Chat that feels
            <br />
            like <span className="auth-accent">home.</span>
          </h1>
          <p className="auth-lede">
            Servers, direct messages, threads and presence — in one calm, fast desktop app.
          </p>

          <ul className="auth-features">
            <li>
              <span className="auth-feature-icon">
                <Sparkles size={14} />
              </span>
              Organise your people into servers and channels
            </li>
            <li>
              <span className="auth-feature-icon">
                <Sparkles size={14} />
              </span>
              Real-time messages, typing indicators and reactions
            </li>
            <li>
              <span className="auth-feature-icon">
                <Sparkles size={14} />
              </span>
              Runs entirely on your machine
            </li>
          </ul>
        </div>
        <div className="auth-hero-footer">Nimbus Desktop · v0.1.0</div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card-head">
            <Wordmark size={18} />
            <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
            <p>{mode === 'login' ? 'Sign in to pick up where you left off.' : 'A username is all you need to get started.'}</p>
          </div>

          <form onSubmit={submit} className="auth-form">
            {mode === 'register' && (
              <>
                <label className="auth-field">
                  <span>Display name</span>
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Aria Chen"
                    autoComplete="name"
                    maxLength={32}
                  />
                </label>
                <label className="auth-field">
                  <span>Username</span>
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
                    placeholder="aria"
                    autoComplete="username"
                    maxLength={32}
                    required
                  />
                </label>
              </>
            )}

            <label className="auth-field">
              <span>Email</span>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </label>

            <label className="auth-field">
              <span>Password</span>
              <div className="auth-password">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  minLength={mode === 'register' ? 8 : 1}
                  required
                />
                <button
                  type="button"
                  className="auth-eye"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            {error && (
              <div className="auth-error" role="alert">
                <AlertCircle size={15} />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" full size="lg" loading={busy}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
              {!busy && <ArrowRight size={16} />}
            </Button>
          </form>

          <div className="auth-switch">
            {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError(null);
              }}
            >
              {mode === 'login' ? 'Register' : 'Sign in'}
            </button>
          </div>

          <div className="auth-divider">
            <span>or</span>
          </div>

          <button type="button" className="auth-demo" onClick={demoLogin} disabled={busy}>
            <span className="auth-demo-avatars">
              <span style={{ background: '#6d5efc' }}>AC</span>
              <span style={{ background: '#23a55a' }}>KR</span>
              <span style={{ background: '#eb459e' }}>NP</span>
            </span>
            Explore the demo workspace
            <span className="auth-demo-hint">aria@nimbus.chat · nimbus123</span>
          </button>
        </div>

        <p className="auth-legal">Your data stays on this computer. No cloud, no tracking.</p>
      </section>
    </div>
  );
}
