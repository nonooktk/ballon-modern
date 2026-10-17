// API クライアント。境界は docs/openapi.yaml。
// - Authorization: Bearer <ID トークン> と X-Client-Tz-Offset を毎回付ける
// - 401 は新しいトークンを待って、同じ op_id で 1 回だけ送り直す
// - 429 rate_limited は Retry-After 後に同じ op_id で 1 回だけ再送する。daily_cap は再送しない
import { API_BASE } from "./config";
import { runSerial } from "./serial";
import type {
  CancelResult, ConfirmDetail, ConfirmResult, ErrorCode, Home, PressResult, ResetResult, Trend,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 認証まわりの橋。AuthProvider が差し込む。テストでは差し替える。 */
export interface AuthBridge {
  getToken(): string | null;
  /** 401 のとき。新しいトークンが入るまで待ち、入ったら解決する。 */
  waitForNewToken(): Promise<string>;
}

let bridge: AuthBridge = {
  getToken: () => null,
  waitForNewToken: () => new Promise<string>(() => {}),
};
export function setAuthBridge(b: AuthBridge): void {
  bridge = b;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike | null = null;
/** テスト用。 */
export function setFetchForTest(f: FetchLike | null): void {
  fetchImpl = f;
}
let sleepImpl = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function setSleepForTest(f: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = f ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
}

async function doFetch(url: string, init: RequestInit): Promise<Response> {
  if (fetchImpl) return fetchImpl(url, init);
  // リテラルで書くのは、本番ビルドでこの枝ごとモックを取り除くため（別ファイルの定数だと残る）
  if (process.env.NEXT_PUBLIC_MOCK === "1") {
    const { mockFetch } = await import("./mock/server");
    return mockFetch(url, init);
  }
  return fetch(url, init);
}

/** 端末の時差（分）。日本は 540。 */
export function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export function newOpId(): string {
  return crypto.randomUUID();
}

const MAX_RETRY_WAIT_SEC = 30;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let reauthed = false;
  let rateRetried = false;
  for (;;) {
    const token = bridge.getToken();
    const headers: Record<string, string> = {
      "X-Client-Tz-Offset": String(tzOffsetMinutes()),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await doFetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "network", "つながらない…。少し待って、もう一度…！");
    }

    if (res.ok) return (await res.json()) as T;

    let code: ErrorCode = "unknown";
    let message = "うまくいかなかった…。もう一度…！";
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      if (j.error) code = j.error as ErrorCode;
      if (j.message) message = j.message;
    } catch {
      /* 本文が JSON でなければ既定の文言 */
    }

    if (res.status === 401 && !reauthed) {
      reauthed = true;
      await bridge.waitForNewToken();
      continue; // 同じ body（同じ op_id）で送り直す
    }
    if (res.status === 429 && code === "rate_limited" && !rateRetried) {
      rateRetried = true;
      const ra = Number(res.headers.get("Retry-After"));
      const sec = Math.min(Math.max(Number.isFinite(ra) && ra > 0 ? ra : 1, 1), MAX_RETRY_WAIT_SEC);
      await sleepImpl(sec * 1000);
      continue;
    }
    const ra = Number(res.headers.get("Retry-After"));
    throw new ApiError(res.status, code, message, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
}

export const api = {
  getHome: () => request<Home>("GET", "/home"),
  getTrend: () => request<Trend>("GET", "/trend"),

  /**
   * 行為ボタンを押す。op_id は押すたびに新しく作る。
   * 1 日 1 回の行為は、取り消し・復活・確定と同じ記録を触るので serialKey で直列にする。
   */
  pressAction: (actionId: string, opId: string, serialKey?: string) => {
    const send = () => request<PressResult>("POST", "/records", { op_id: opId, action_id: actionId });
    return serialKey ? runSerial(serialKey, send) : send();
  },

  /** 確定。同じ記録への操作は serialKey で直列にする。 */
  confirmRecord: (recordId: string, opId: string, detail: ConfirmDetail, serialKey: string) =>
    runSerial(serialKey, () =>
      request<ConfirmResult>("PUT", `/records/${recordId}/confirm`, { op_id: opId, ...detail }),
    ),

  /** デモ用の全リセット（本人の明示操作だけ）。op_id が同じ再送は何も消さない */
  resetMe: (opId: string) =>
    runSerial("reset", () => request<ResetResult>("POST", "/me/reset", { op_id: opId })),

  cancelRecord: (recordId: string, opId: string, serialKey: string) =>
    runSerial(serialKey, () =>
      request<CancelResult>("POST", `/records/${recordId}/cancel`, { op_id: opId }),
    ),
};

/** 利用者に見せてよい文（API の message を優先。無いときは code で決める）。 */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return "うまくいかなかった…。もう一度…！";
}
