// ホームの状態を更新する小さな関数。点やレベルの計算は持たない（値は API の応答のまま使う）。
import type { ActionState, Home, Progress } from "./types";

export function allActions(h: Home): ActionState[] {
  return [...h.major, ...h.minor];
}

export function findAction(h: Home | null, id: string): ActionState | undefined {
  return h ? allActions(h).find((a) => a.id === id) : undefined;
}

export function patchAction(h: Home, id: string, f: (a: ActionState) => ActionState): Home {
  const map = (list: ActionState[]) => list.map((a) => (a.id === id ? f(a) : a));
  return { ...h, major: map(h.major), minor: map(h.minor) };
}

/**
 * 点は減らない。応答が前後して届いても古い値で巻き戻さないよう、累計の大きいほうを採る。
 * （取り消しなどで累計が同じなら新しい応答を採る）
 */
export function mergeProgress(prev: Progress, next: Progress): Progress {
  return next.total_points >= prev.total_points ? next : prev;
}

/** 札の文言: 大は「…！」つき、小は無し（モックどおり） */
export function bigLabel(label: string): string {
  return /[！!]$/.test(label) ? label : `${label}…！`;
}
export function smallLabel(label: string): string {
  return label.replace(/…?！$/, "");
}

const BAND_LABEL = { morning: "朝", noon: "昼", night: "夜" } as const;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** 「10月17日（金）夜」。local_date は API が決めた日付で、ここでは表示用に整えるだけ。 */
export function dateLabel(localDate: string, band: Home["band"]): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!m) return BAND_LABEL[band];
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${Number(m[2])}月${Number(m[3])}日（${WEEK[d.getUTCDay()]}）${BAND_LABEL[band]}`;
}
