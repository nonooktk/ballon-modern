"use client";

// 推移: 体重の 7 日平均（過去 28 日）をインライン SVG の折れ線で。1 日ごとの値は見せない。
import { useGame } from "./GameProvider";
import type { Trend } from "@/lib/types";

const X0 = 30, X1 = 300, Y_TOP = 56, Y_BOTTOM = 146;

const fmtKg = (v: number) => v.toFixed(1);
const fmtDiff = (v: number) => (v < 0 ? `−${Math.abs(v).toFixed(1)}` : v > 0 ? `+${v.toFixed(1)}` : "±0.0");

function Chart({ trend }: { trend: Trend }) {
  const n = trend.days.length;
  const vals = trend.days.map((d) => d.avg_kg).filter((v): v is number => v !== null);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const x = (i: number) => X0 + ((X1 - X0) * i) / Math.max(n - 1, 1);
  const y = (v: number) => (max === min ? (Y_TOP + Y_BOTTOM) / 2 : Y_TOP + ((max - v) / (max - min)) * (Y_BOTTOM - Y_TOP));
  // 値のない日で線を切る（欠測日があっても残りの区間は描く）
  const runs: string[] = [];
  let cur: string[] = [];
  trend.days.forEach((d, i) => {
    if (d.avg_kg === null) { if (cur.length) runs.push(cur.join(" ")); cur = []; }
    else cur.push(`${x(i).toFixed(1)},${y(d.avg_kg).toFixed(1)}`);
  });
  if (cur.length) runs.push(cur.join(" "));
  const firstIdx = trend.days.findIndex((d) => d.avg_kg !== null);
  const lastIdx = n - 1 - [...trend.days].reverse().findIndex((d) => d.avg_kg !== null);
  const first = trend.days[firstIdx].avg_kg as number;
  const last = trend.days[lastIdx].avg_kg as number;
  const lx = x(lastIdx), ly = y(last);
  return (
    <svg viewBox="0 0 320 200" width="100%" role="img" aria-labelledby="chart-t">
      <title id="chart-t">体重の 7 日平均。4 週前 {fmtKg(first)} kg から今週 {fmtKg(last)} kg へ</title>
      <line x1="20" y1="170" x2="310" y2="170" stroke="#b9bfd3" />
      {runs.map((p, i) => (
        <polyline key={i} points={p} fill="none" stroke="#e8c766" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      ))}
      <ellipse cx={lx} cy={ly - 12} rx="10" ry="12" fill="#c8102e" stroke="#000" strokeWidth="2" />
      <path d={`M${lx} ${ly} C${lx - 4} ${ly + 10} ${lx + 4} ${ly + 16} ${lx} ${ly + 26}`} stroke="#b9bfd3" fill="none" strokeWidth="1.5" />
      <text x="30" y="190" fontSize="12" fill="#b9bfd3">4 週前</text>
      <text x="280" y="190" fontSize="12" fill="#b9bfd3">今週</text>
      <text x={Math.max(x(firstIdx) - 4, 20)} y={y(first) - 16} fontSize="12" fill="#f2efe6">{fmtKg(first)}</text>
      {lastIdx !== firstIdx && <text x={Math.min(lx - 18, 276)} y={ly + 22 > 164 ? ly - 28 : ly + 38} fontSize="12" fill="#f2efe6">{fmtKg(last)}</text>}
    </svg>
  );
}

export default function TrendScreen() {
  const { trend, trendError, goHome } = useGame();
  const hasData = trend ? trend.days.some((d) => d.avg_kg !== null) : false;
  return (
    <div className="panel">
      <div className="appbar"><strong>この 4 週間</strong><button type="button" className="link" onClick={goHome}>ホームへ</button></div>
      {trendError ? (
        <p className="hint" role="alert">{trendError}</p>
      ) : !trend ? (
        <p className="note center" role="status">ざわ…ざわ…（読み込み中）</p>
      ) : !hasData ? (
        <>
          <p className="chart-sum">4 週ぶんたまると出る…！</p>
          <p className="chart-cap">体重を記録しておくと、ここに流れが出る。一日の上下は見せない。見るのは流れ…！</p>
        </>
      ) : (
        <>
          <p className="chart-sum">
            {trend.current_avg_kg !== null ? `7 日平均 ${fmtKg(trend.current_avg_kg)} kg。` : "今週の 7 日平均は、まだ出ない。"}
            <br />
            {trend.diff_kg !== null
              ? `4 週前から ${fmtDiff(trend.diff_kg)} kg${trend.diff_kg < 0 ? "…！" : "。"}`
              : "4 週前との差は、4 週ぶんたまると出る…！"}
          </p>
          <Chart trend={trend} />
          <p className="chart-cap">一日の上下は見せない。水分でぶれるだけだ。見るのは流れ…！</p>
        </>
      )}
    </div>
  );
}
