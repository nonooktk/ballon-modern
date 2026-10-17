// ログイン画面の大きなふうせん（モックの SVG）
export default function BalloonArt() {
  return (
    <svg width="96" height="128" viewBox="0 0 96 128" aria-hidden="true">
      <ellipse cx="48" cy="46" rx="38" ry="44" fill="#c8102e" stroke="#000" strokeWidth="4" />
      <ellipse cx="34" cy="30" rx="9" ry="13" fill="#fff" opacity=".35" />
      <path d="M44 90 L52 90 L48 97 Z" fill="#c8102e" stroke="#000" strokeWidth="2" />
      <path d="M48 97 C40 108 56 114 46 126" stroke="#e8c766" strokeWidth="2" fill="none" />
    </svg>
  );
}
