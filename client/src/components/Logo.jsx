export default function Logo({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Mind Atlas">
      <circle cx="17" cy="17" r="14.5" stroke="var(--c-secondary)" strokeWidth="2" />
      <circle cx="17" cy="17" r="9" stroke="var(--c-primary)" strokeWidth="2" />
      <circle cx="17" cy="17" r="3" fill="var(--c-tertiary)" />
    </svg>
  );
}
