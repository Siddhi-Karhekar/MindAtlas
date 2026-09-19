// Material Symbols Outlined glyph. `name` is the ligature text, e.g. "home".
export default function Icon({ name, className = "", filled = false, style }) {
  return (
    <span
      aria-hidden="true"
      className={`material-symbols-outlined${filled ? " filled" : ""} ${className}`}
      style={style}
    >
      {name}
    </span>
  );
}
