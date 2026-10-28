import logoUrl from '../assets/nimbus-logo.png';

/**
 * The Nimbus mark. The supplied artwork already has rounded corners and a
 * transparent background, so it sits cleanly on every surface without clipping.
 */
export function Logo({ size = 32 }: { size?: number; radius?: number }) {
  return (
    <img
      className="nimbus-logo"
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      <Logo size={size + 6} />
      <span>Nimbus</span>
    </span>
  );
}