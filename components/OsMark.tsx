/**
 * The OS mark — the Founder OS brand emblem: the chrome yin-yang circle,
 * extracted from the brand asset onto transparent (public/os-emblem.png) so it
 * drops cleanly onto the dark UI. `color` is kept for API compatibility but no
 * longer inks the mark (the emblem is chrome). The OS logo only — never the
 * "Founder" wordmark.
 */
export function OsMark({ size = 34, className }: { size?: number; color?: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/os-emblem.png"
      alt="IGRIS Agent"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: 'contain' }}
      className={className}
    />
  );
}
