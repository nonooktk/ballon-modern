"use client";

// ログインの状態と ID トークンの保持。トークンは API に Authorization: Bearer で送る。
// - GIS のボタンでログイン。期限の 5 分前に google.accounts.id.prompt() で取り直す
// - 取り直せず期限が切れたら「期限切れ」にしてログインボタンを出し直す。
//   待たせていた API 呼び出しは、再ログイン後に同じ op_id で送り直される（lib/api.ts）
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { setAuthBridge } from "@/lib/api";
import { DEV_AUTH, GOOGLE_CLIENT_ID } from "@/lib/config";
import { loadGis, type CredentialResponse } from "@/lib/gis";
import { DEV_PREFIX, refreshDelayMs, tokenExpiryMs, tokenSub } from "@/lib/jwt";

export type AuthStatus = "init" | "signedOut" | "signedIn" | "expired";

interface AuthValue {
  status: AuthStatus;
  /** 利用者の識別（画面の状態を作り直す鍵。表示には使わない） */
  sub: string | null;
  /** GIS の読み込みに失敗した */
  gisFailed: boolean;
  devLogin(sub: string): void;
  logout(): void;
  /** ログインボタンを置く */
  renderGoogleButton(el: HTMLElement): void;
}

const Ctx = createContext<AuthValue | null>(null);
export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("AuthProvider の外です");
  return v;
}

const STORE_KEY = "ballon.idt";

function readStored(): string | null {
  try {
    const t = sessionStorage.getItem(STORE_KEY);
    if (!t) return null;
    const exp = tokenExpiryMs(t);
    if (exp !== null && exp < Date.now() + 60_000) return null;
    if (t.startsWith(DEV_PREFIX) && !DEV_AUTH) return null; // 本番ビルドでは開発トークンを使わない
    return t;
  } catch {
    return null;
  }
}
function writeStored(t: string | null): void {
  try {
    if (t) sessionStorage.setItem(STORE_KEY, t);
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* 保存できなくても動く */
  }
}

export default function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("init");
  const [sub, setSub] = useState<string | null>(null);
  const [gisFailed, setGisFailed] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const waiters = useRef<Array<(t: string) => void>>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gisReady = useRef(false);
  const pendingButtons = useRef<HTMLElement[]>([]);

  const clearRefresh = () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
  };

  const expire = useCallback(() => {
    clearRefresh();
    tokenRef.current = null;
    writeStored(null);
    setStatus((s) => (s === "signedIn" ? "expired" : s));
  }, []);

  /** 期限の 5 分前に取り直す。取り直せなければ期限まで 1 分おきに再要求し、切れたらログインボタンを出し直す。 */
  const scheduleRefresh = useCallback((token: string) => {
    clearRefresh();
    const exp = tokenExpiryMs(token);
    if (exp === null || !GOOGLE_CLIENT_ID) return; // 開発トークンは期限なし
    const attempt = () => {
      if (tokenRef.current !== token) return; // もう新しいトークンになっている
      if (Date.now() >= exp) { expire(); return; }
      void loadGis().then((id) => id.prompt()).catch(() => {});
      // 15 秒待って変わらなければ、期限が切れていれば出し直し、まだなら 1 分後にもう一度
      refreshTimer.current = setTimeout(() => {
        if (tokenRef.current !== token) return;
        if (Date.now() >= exp) expire();
        else refreshTimer.current = setTimeout(attempt, 60_000);
      }, 15_000);
    };
    refreshTimer.current = setTimeout(attempt, refreshDelayMs(exp, Date.now()));
  }, [expire]);

  const applyToken = useCallback((token: string) => {
    tokenRef.current = token;
    writeStored(token);
    setSub(tokenSub(token));
    setStatus("signedIn");
    scheduleRefresh(token);
    const ws = waiters.current;
    waiters.current = [];
    ws.forEach((w) => w(token));
  }, [scheduleRefresh]);

  // API クライアントへの橋
  useEffect(() => {
    setAuthBridge({
      getToken: () => tokenRef.current,
      waitForNewToken: () => {
        // 401: いまのトークンは使えない。ログインし直すまで待つ
        if (tokenRef.current) expire();
        setStatus((s) => (s === "signedIn" ? "expired" : s));
        return new Promise<string>((resolve) => { waiters.current.push(resolve); });
      },
    });
  }, [expire]);

  const onCredential = useCallback((r: CredentialResponse) => applyToken(r.credential), [applyToken]);

  const initGis = useCallback(() => {
    if (!GOOGLE_CLIENT_ID) return;
    loadGis()
      .then((id) => {
        if (!gisReady.current) {
          id.initialize({
            client_id: GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true,
            cancel_on_tap_outside: false, use_fedcm_for_prompt: true, itp_support: true,
          });
          gisReady.current = true;
        }
        pendingButtons.current.forEach((el) => drawButton(id, el));
        pendingButtons.current = [];
      })
      .catch(() => setGisFailed(true));
  }, [onCredential]);

  // 起動: 保存済みのトークンがあれば使う。GIS はログイン画面が要るときに読む
  useEffect(() => {
    // sessionStorage はブラウザでしか読めないので、描画のあとに読む（状態の更新は次の tick）
    void Promise.resolve().then(() => {
      const stored = readStored();
      if (stored) applyToken(stored);
      else setStatus("signedOut");
    });
    initGis();
    return clearRefresh;
  }, [applyToken, initGis]);

  const renderGoogleButton = useCallback((el: HTMLElement) => {
    if (!GOOGLE_CLIENT_ID) return;
    const id = window.google?.accounts?.id;
    if (id && gisReady.current) drawButton(id, el);
    else pendingButtons.current.push(el);
  }, []);

  const devLogin = useCallback((s: string) => {
    if (!DEV_AUTH) return;
    const clean = s.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "dev-user";
    applyToken(DEV_PREFIX + clean);
  }, [applyToken]);

  const logout = useCallback(() => {
    clearRefresh();
    tokenRef.current = null;
    writeStored(null);
    try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* 無視 */ }
    setSub(null);
    setStatus("signedOut");
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, sub, gisFailed, devLogin, logout, renderGoogleButton }),
    [status, sub, gisFailed, devLogin, logout, renderGoogleButton],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function drawButton(id: NonNullable<Window["google"]>["accounts"]["id"], el: HTMLElement): void {
  el.innerHTML = "";
  id.renderButton(el, {
    type: "standard", theme: "filled_black", size: "large", text: "signin_with", shape: "rectangular",
    logo_alignment: "left", locale: "ja", width: Math.min(Math.max(el.clientWidth, 200), 400),
  });
}
