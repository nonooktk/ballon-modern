"use client";

import { bigLabel, dateLabel, smallLabel } from "@/lib/home";
import type { ActionState } from "@/lib/types";
import { useAuth } from "./AuthProvider";
import { useGame } from "./GameProvider";

function ActButton({ a, big, next }: { a: ActionState; big: boolean; next: boolean }) {
  const { press } = useGame();
  const once = a.frequency === "daily_once";
  const reopen = once && a.done && a.detail !== "none" && (a.confirm_state === "open" || a.confirm_state === "regrant_blocked");
  const label = big ? bigLabel(a.label) : smallLabel(a.label);
  const cls = ["act", a.done && once ? "done" : "", reopen ? "reopen" : "", next ? "next" : ""].filter(Boolean).join(" ");
  const tag = once ? (a.done ? "済 ✓" : "1日1回") : `×${a.count}`;
  const aria = once
    ? a.done ? (reopen ? `${label} 済。押すと続きを入力できます` : `${label} 済`) : `${label} 1日1回`
    : `${label} 今日 ${a.count} 回`;
  return (
    <button
      type="button" className={cls} aria-label={aria}
      aria-disabled={once && a.done && !reopen ? true : undefined}
      onClick={(e) => press(a.id, e.currentTarget)}
    >
      <span className="ico" aria-hidden="true">{a.icon}</span>
      {label}
      <span className={once ? "tag once" : "tag multi"} aria-hidden="true">{tag}</span>
    </button>
  );
}

export default function HomeScreen() {
  const { home, loadError, reload, openTrend } = useGame();
  const { logout } = useAuth();

  if (!home) {
    return (
      <div className="panel">
        {loadError ? (
          <>
            <p className="hint" role="alert">{loadError}</p>
            <button type="button" className="btn main" onClick={reload}>もう一度</button>
          </>
        ) : (
          <p className="note center" role="status">ざわ…ざわ…（読み込み中）</p>
        )}
      </div>
    );
  }
  const next = [...home.major, ...home.minor].find((a) => a.id === home.next_action_id);
  return (
    <div className="panel">
      <div className="appbar"><strong>ざわ…</strong><span>{dateLabel(home.local_date, home.band)}</span></div>
      <p className="hint">
        <span className="kicker-s">今日の一手</span>
        {next ? `${smallLabel(next.label)}、一押し…！` : "今日の一手は、ぜんぶ済…！ あとは、いつでも…！"}
      </p>
      <p className="board-h">いまの時間に</p>
      <div className="board-big">
        {home.major.map((a) => <ActButton key={a.id} a={a} big next={a.id === home.next_action_id} />)}
      </div>
      <p className="board-h">いつでも</p>
      <div className="board-small">
        {home.minor.map((a) => <ActButton key={a.id} a={a} big={false} next={false} />)}
      </div>
      <nav aria-label="ほかの画面" className="center">
        <button type="button" className="link" onClick={openTrend}>推移を見る</button>
        <button type="button" className="link" onClick={logout}>ログアウト</button>
      </nav>
    </div>
  );
}
