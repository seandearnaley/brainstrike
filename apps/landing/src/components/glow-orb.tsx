interface GlowOrbProps {
  color?: string;
  size?: number;
  top?: string;
  left?: string;
  delay?: number;
}

export function GlowOrb({
  color = 'var(--accent-mid)',
  size = 400,
  top = '20%',
  left = '50%',
  delay = 0,
}: GlowOrbProps): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute rounded-full"
      style={{
        width: size,
        height: size,
        top,
        left,
        transform: 'translate(-50%, -50%)',
        background: `radial-gradient(circle, ${color} 0%, transparent 70%)`,
        opacity: 0.15,
        filter: 'blur(80px)',
        animation: `glow-pulse 8s ease-in-out ${delay}s infinite, float 12s ease-in-out ${delay}s infinite`,
      }}
    />
  );
}
