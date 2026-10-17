import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, api, setAuthBridge, setFetchForTest, setSleepForTest } from "../api";

interface Call { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }
let calls: Call[];
let responses: Array<() => Response>;
let slept: number[];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const ERR = (status: number, error: string, headers?: Record<string, string>) => json(status, { error, message: `文言:${error}` }, headers);
const PROGRESS = { level: 1, current_points: 10, required_points: 50, remaining_points: 40, total_points: 10, is_max: false };
const PRESS_OK = json(200, { record_id: "r1", reason: "granted", granted_points: 10, confirm_state: "none", progress: PROGRESS, level_up: null });

let token: string | null;
let newTokenWaiters: Array<(t: string) => void>;

beforeEach(() => {
  calls = []; responses = []; slept = []; token = "tok-old"; newTokenWaiters = [];
  setFetchForTest(async (url, init) => {
    calls.push({
      url, method: String(init?.method), headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const next = responses.shift();
    if (!next) throw new Error("想定外の呼び出し");
    return next();
  });
  setSleepForTest(async (ms) => { slept.push(ms); });
  setAuthBridge({
    getToken: () => token,
    waitForNewToken: () => new Promise<string>((resolve) => { newTokenWaiters.push((t) => { token = t; resolve(t); }); }),
  });
});
afterEach(() => { setFetchForTest(null); setSleepForTest(null); });

describe("api クライアント", () => {
  it("Bearer と時差ヘッダを付け、op_id と action_id を送る", async () => {
    responses = [PRESS_OK];
    const r = await api.pressAction("water", "op-1");
    expect(r.granted_points).toBe(10);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toMatch(/\/records$/);
    expect(calls[0].headers.Authorization).toBe("Bearer tok-old");
    expect(calls[0].headers["X-Client-Tz-Offset"]).toBe(String(-new Date().getTimezoneOffset()));
    expect(calls[0].body).toEqual({ op_id: "op-1", action_id: "water" });
  });

  it("429 rate_limited は Retry-After のあと、同じ op_id で 1 回だけ再送する", async () => {
    responses = [ERR(429, "rate_limited", { "Retry-After": "2" }), PRESS_OK];
    await api.pressAction("water", "op-2");
    expect(slept).toEqual([2000]);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual(calls[0].body);
  });

  it("429 rate_limited が 2 回続いたら、2 回目は再送せずエラーにする", async () => {
    responses = [ERR(429, "rate_limited", { "Retry-After": "1" }), ERR(429, "rate_limited", { "Retry-After": "1" })];
    await expect(api.pressAction("water", "op-3")).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(calls).toHaveLength(2);
  });

  it("Retry-After が長すぎても 30 秒までしか待たない", async () => {
    responses = [ERR(429, "rate_limited", { "Retry-After": "600" }), PRESS_OK];
    await api.pressAction("water", "op-4");
    expect(slept).toEqual([30000]);
  });

  it("429 daily_cap は再送しない", async () => {
    responses = [ERR(429, "daily_cap")];
    await expect(api.pressAction("water", "op-5")).rejects.toMatchObject({ code: "daily_cap" });
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("401 は新しいトークンを待ち、同じ op_id・新しいトークンで 1 回送り直す", async () => {
    responses = [ERR(401, "token_expired"), PRESS_OK];
    const p = api.pressAction("water", "op-6");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1); // ログインし直すまで待っている
    newTokenWaiters[0]("tok-new");
    await p;
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.Authorization).toBe("Bearer tok-new");
    expect(calls[1].body).toEqual(calls[0].body);
  });

  it("エラーの形 {error, message} を ApiError にして、message をそのまま持つ", async () => {
    responses = [ERR(409, "cancel_expired")];
    const e = await api.cancelRecord("r1", "op-7", "rec:r1").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("cancel_expired");
    expect(e.message).toBe("文言:cancel_expired");
  });

  it("通信できないときは network のエラー（叱らない文言）", async () => {
    setFetchForTest(async () => { throw new TypeError("fetch failed"); });
    const e = await api.getHome().catch((x) => x);
    expect(e).toMatchObject({ code: "network", status: 0 });
    expect(e.message).toContain("もう一度");
  });

  it("確定と取り消しは同じキーで直列に送られる", async () => {
    const order: string[] = [];
    setFetchForTest(async (url) => {
      order.push(`開始 ${url.split("/").pop()}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`終了 ${url.split("/").pop()}`);
      return url.endsWith("/confirm")
        ? json(200, { record_id: "r1", granted_points: 20, confirm_state: "done", progress: PROGRESS, level_up: null })()
        : json(200, { record_id: "r1", cancelled: true, progress: PROGRESS })();
    });
    await Promise.all([
      api.confirmRecord("r1", "op-a", { portion: "normal" }, "once:dinner"),
      api.cancelRecord("r1", "op-b", "once:dinner"),
    ]);
    expect(order).toEqual(["開始 confirm", "終了 confirm", "開始 cancel", "終了 cancel"]);
  });
});
