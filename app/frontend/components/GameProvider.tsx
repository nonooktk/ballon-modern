"use client";

// ホーム・先のページ・推移の状態と操作。
// 画面は結果を描くだけ: 点・レベル・済・回数は API の応答のまま使う（押した瞬間の演出と「済」だけ先に出す）。
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { api, errorMessage, newOpId, ApiError } from "@/lib/api";
import { deflateFx, playConfirm, playPop, prefersReducedMotion, tapFx, type PopOptions } from "@/lib/fx";
import { findAction, mergeProgress, patchAction } from "@/lib/home";
import type { ConfirmDetail, Home, LevelUp, PressResult, Trend } from "@/lib/types";

export type Screen = { name: "home" } | { name: "detail"; actionId: string } | { name: "trend" };
export interface ToastState { id: number; text: string; kind: "info" | "error"; undo?: () => void }
/** 弾けるまで満タンのまま旧レベルを見せるための印（参照の同一性で見分ける） */
export interface Held { lv: number }

interface GameValue {
  home: Home | null;
  loadError: string | null;
  screen: Screen;
  held: Held | null;
  toast: ToastState | null;
  trend: Trend | null;
  trendError: string | null;
  reload(): void;
  press(actionId: string, el: HTMLElement): void;
  openDetail(actionId: string): void;
  confirm(actionId: string, detail: ConfirmDetail): Promise<boolean>;
  goHome(): void;
  openTrend(): void;
  dismissToast(): void;
  resetAll(): Promise<boolean>;
}

const Ctx = createContext<GameValue | null>(null);
export function useGame(): GameValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("GameProvider の外です");
  return v;
}

const TOAST_MS = 8000;
const DETAIL_DELAY_MS = 650; // 小演出を見せてから先のページへ
const STALE_MS = 10 * 60 * 1000; // 長く離れて戻ったら取り直す（日が変わっていることがある）

export default function GameProvider({ children }: { children: ReactNode }) {
  const [home, setHome] = useState<Home | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [held, setHeld] = useState<Held | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);

  const homeRef = useRef<Home | null>(null);
  useEffect(() => { homeRef.current = home; }, [home]);
  const screenRef = useRef<Screen>(screen);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);
  const lastLoad = useRef(0);
  const confirmOp = useRef<{ key: string; opId: string } | null>(null);
  const pressing = useRef(new Set<string>()); // 1 日 1 回の行為の二重押しを止める

  const showToast = useCallback((text: string, kind: "info" | "error" = "info", undo?: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const id = ++toastSeq.current;
    setToast({ id, text, kind, undo });
    toastTimer.current = setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), kind === "error" ? TOAST_MS + 2000 : TOAST_MS);
  }, []);
  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  const loadHome = useCallback(() => {
    api.getHome().then(
      (h) => { lastLoad.current = Date.now(); setHome(h); setLoadError(null); },
      (e: unknown) => setLoadError(errorMessage(e)),
    );
  }, []);

  useEffect(() => {
    let alive = true;
    api.getHome().then(
      (h) => { if (alive) { lastLoad.current = Date.now(); setHome(h); } },
      (e: unknown) => { if (alive) setLoadError(errorMessage(e)); },
    );
    return () => { alive = false; };
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && homeRef.current && Date.now() - lastLoad.current > STALE_MS) loadHome();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadHome]);

  const reload = useCallback(() => { setLoadError(null); loadHome(); }, [loadHome]);

  /** 満タンのまま固定して、弾けの演出に渡す */
  const startPop = useCallback((lu: LevelUp): PopOptions => {
    const mark: Held = { lv: lu.before };
    setHeld(mark);
    return { fromLevel: lu.before, release: () => setHeld((h) => (h === mark ? null : h)) };
  }, []);

  const goHome = useCallback(() => setScreen({ name: "home" }), []);
  const openDetail = useCallback((actionId: string) => setScreen({ name: "detail", actionId }), []);
  const openTrend = useCallback(() => {
    setScreen({ name: "trend" });
    setTrendError(null);
    api.getTrend().then(setTrend, (e) => setTrendError(errorMessage(e)));
  }, []);

  const cancel = useCallback(async (actionId: string, recordId: string) => {
    const a = findAction(homeRef.current, actionId);
    if (!a) return;
    const key = a.frequency === "daily_once" ? `once:${actionId}` : `rec:${recordId}`;
    dismissToast();
    try {
      const res = await api.cancelRecord(recordId, newOpId(), key);
      setHome((h) => h && patchAction({ ...h, progress: mergeProgress(h.progress, res.progress) }, actionId, (x) => {
        const count = Math.max(0, x.count - 1);
        // 今日の有効な記録が無くなったら、API の仕様どおり confirm_state は none に戻す
        return { ...x, count, done: count > 0, record_id: count > 0 ? x.record_id : null, confirm_state: count > 0 ? x.confirm_state : "none" };
      }));
      const s = screenRef.current;
      if (s.name === "detail" && s.actionId === actionId) setScreen({ name: "home" });
      showToast("取り消した…。点は、そのまま…！");
    } catch (e) {
      showToast(errorMessage(e), "error");
    }
  }, [dismissToast, showToast]);

  const applyPress = useCallback((actionId: string, res: PressResult, startedAt: number) => {
    const a = findAction(homeRef.current, actionId);
    setHome((h) => h && patchAction({ ...h, progress: mergeProgress(h.progress, res.progress) }, actionId, (x) => ({
      ...x, done: true, record_id: res.record_id, confirm_state: res.confirm_state,
    })));
    if (res.level_up) {
      const pop = startPop(res.level_up);
      setTimeout(() => playPop(pop), prefersReducedMotion() ? 0 : 250); // 小演出の途中から弾けが始まる
    }
    const label = a?.label ?? "";
    if (res.reason === "granted") {
      showToast(`${label.replace(/…?！$/, "")}、記録…！`, "info", () => void cancel(actionId, res.record_id));
    } else if (res.reason === "revived") {
      showToast("取り消した行が、戻った…！ 点は、そのまま…！", "info", () => void cancel(actionId, res.record_id));
    } else {
      showToast("今日は、もう記録ずみ…！ 点は、そのまま…！");
    }
    // 体重・食事は先のページへ（小演出を見せてから）
    if (a && a.detail !== "none" && (res.confirm_state === "open" || res.confirm_state === "regrant_blocked")) {
      const wait = Math.max(0, DETAIL_DELAY_MS - (Date.now() - startedAt));
      setTimeout(() => {
        const cur = findAction(homeRef.current, actionId);
        if (cur?.done && screenRef.current.name === "home") setScreen({ name: "detail", actionId });
      }, wait);
    }
  }, [cancel, showToast, startPop]);

  const press = useCallback((actionId: string, el: HTMLElement) => {
    const a = findAction(homeRef.current, actionId);
    if (!a) return;
    const once = a.frequency === "daily_once";
    if (once && a.done) { // 済: 先のページが未確定なら開き直す。それ以外は何もしない
      if (a.detail !== "none" && (a.confirm_state === "open" || a.confirm_state === "regrant_blocked") && a.record_id) {
        setScreen({ name: "detail", actionId });
      }
      return;
    }
    if (once && pressing.current.has(actionId)) return;
    if (once) pressing.current.add(actionId);

    tapFx(el, 10); // 押した瞬間の演出は API の応答を待たない
    setHome((h) => h && patchAction(h, actionId, (x) => (once ? { ...x, done: true } : { ...x, count: x.count + 1, done: true })));

    const startedAt = Date.now();
    api.pressAction(actionId, newOpId(), once ? `once:${actionId}` : undefined)
      .then((res) => applyPress(actionId, res, startedAt))
      .catch((e: unknown) => {
        // 先に出した「済」「回数」を戻す
        setHome((h) => h && patchAction(h, actionId, (x) => {
          if (once) return { ...x, done: false };
          const count = Math.max(0, x.count - 1);
          return { ...x, count, done: count > 0 };
        }));
        showToast(errorMessage(e), "error");
      })
      .finally(() => { if (once) pressing.current.delete(actionId); });
  }, [applyPress, showToast]);

  const confirm = useCallback(async (actionId: string, detail: ConfirmDetail): Promise<boolean> => {
    const a = findAction(homeRef.current, actionId);
    if (!a || !a.record_id) { setScreen({ name: "home" }); return false; }
    // 同じ内容の再試行は同じ op_id、内容を変えたら新しい op_id
    const sig = `${a.record_id}:${JSON.stringify(detail)}`;
    if (confirmOp.current?.key !== sig) confirmOp.current = { key: sig, opId: newOpId() };
    try {
      const res = await api.confirmRecord(a.record_id, confirmOp.current.opId, detail, `once:${actionId}`);
      confirmOp.current = null;
      setHome((h) => h && patchAction({ ...h, progress: mergeProgress(h.progress, res.progress) }, actionId, (x) => ({
        ...x, confirm_state: res.confirm_state,
      })));
      setScreen({ name: "home" });
      if (res.granted_points > 0) {
        playConfirm({
          points: res.granted_points, totalText: `合計 ${res.progress.total_points} 点`,
          popAfter: res.level_up ? startPop(res.level_up) : undefined,
        });
      } else {
        showToast("記録した…！");
        if (res.level_up) playPop(startPop(res.level_up));
      }
      return true;
    } catch (e) {
      if (e instanceof ApiError && (e.code === "record_cancelled" || e.code === "confirm_expired" || e.code === "not_found")) {
        showToast(errorMessage(e), "error");
        setScreen({ name: "home" });
        loadHome();
        return false;
      }
      showToast(errorMessage(e), "error");
      return false;
    }
  }, [loadHome, showToast, startPop]);

  /** デモ用の全リセット。応答の点・レベルで更新し、記録の済・回数を空に戻して、今日の一手は取り直す */
  const resetAll = useCallback(async (): Promise<boolean> => {
    try {
      const r = await api.resetMe(newOpId());
      const { deleted, ...progress } = r;
      void deleted;
      setHome((h) => h && {
        ...h, progress,
        major: h.major.map((a) => ({ ...a, done: false, count: 0, record_id: null, confirm_state: "none" })),
        minor: h.minor.map((a) => ({ ...a, done: false, count: 0, record_id: null, confirm_state: "none" })),
        next_action_id: null,
      });
      setHeld(null);
      setTrend(null);
      setScreen({ name: "home" });
      deflateFx();
      showToast("すべて、無に帰した…。ここから、また…！");
      loadHome(); // 今日の一手などを API の最新に
      return true;
    } catch (e) {
      showToast(errorMessage(e), "error");
      return false;
    }
  }, [loadHome, showToast]);

  const value = useMemo<GameValue>(() => ({
    home, loadError, screen, held, toast, trend, trendError, reload, press, openDetail, confirm, goHome, openTrend, dismissToast, resetAll,
  }), [home, loadError, screen, held, toast, trend, trendError, reload, press, openDetail, confirm, goHome, openTrend, dismissToast, resetAll]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
