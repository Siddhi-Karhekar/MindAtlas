// Circular progress ring. `value` is 0..100. Used for "linked notes" on the home
// cards, the mastery meter on the results page, and the connectivity meter in
// the graph inspector.
const PATH = "M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831";

export default function Ring({ value, className = "w-8 h-8", stroke = 3, track = "text-surface-container-high", tone = "text-secondary", children }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
        <path className={track} d={PATH} fill="none" stroke="currentColor" strokeWidth={stroke} />
        {v > 0 && (
        <path
          className={tone}
          d={PATH}
          fill="none"
          stroke="currentColor"
          strokeDasharray={`${v}, 100`}
          strokeLinecap="round"
          strokeWidth={stroke}
        />
        )}
      </svg>
      {children && <div className="absolute inset-0 flex items-center justify-center">{children}</div>}
    </div>
  );
}
