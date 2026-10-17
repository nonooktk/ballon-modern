// 背景の「ざわ…」（飾り。読み上げない）
const ITEMS = [
  ["4%", "10%", "64px", "-8deg", "7s", ".06", "ざわ…"],
  ["58%", "18%", "48px", "6deg", "9s", ".05", "ざわ…ざわ…"],
  ["12%", "38%", "56px", "4deg", "8s", ".06", "ざわ…ざわ…"],
  ["66%", "46%", "72px", "-6deg", "10s", ".07", "ざわ…"],
  ["2%", "66%", "60px", "-4deg", "7.5s", ".05", "ざわ…"],
  ["50%", "76%", "52px", "8deg", "9.5s", ".06", "ざわ…ざわ…"],
  ["24%", "90%", "68px", "-10deg", "8.5s", ".05", "ざわ…"],
] as const;

export default function Zawa() {
  return (
    <div className="zawa" aria-hidden="true">
      {ITEMS.map(([x, y, s, r, d, o, t], i) => (
        <span key={i} style={{ "--x": x, "--y": y, "--s": s, "--r": r, "--d": d, "--o": o } as React.CSSProperties}>{t}</span>
      ))}
    </div>
  );
}
