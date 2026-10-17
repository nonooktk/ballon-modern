// ID トークンの中身を読む（表示・期限の把握用。検証は API の仕事で、画面は信用しない）。
export interface IdTokenClaims {
  exp?: number;
  sub?: string;
}

export function decodeClaims(jwt: string): IdTokenClaims | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bin = atob(b64);
    const json = decodeURIComponent(
      Array.from(bin, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
    );
    return JSON.parse(json) as IdTokenClaims;
  } catch {
    return null;
  }
}

export const DEV_PREFIX = "dev:";

/** 開発ログインのトークン（dev:<sub>）か。期限は無い。 */
export function isDevToken(token: string): boolean {
  return token.startsWith(DEV_PREFIX);
}

/** トークンの期限（ミリ秒）。無ければ null。 */
export function tokenExpiryMs(token: string): number | null {
  if (isDevToken(token)) return null;
  const c = decodeClaims(token);
  return c?.exp ? c.exp * 1000 : null;
}

export function tokenSub(token: string): string {
  if (isDevToken(token)) return token;
  return decodeClaims(token)?.sub ?? token.slice(-16);
}

/** 期限の何分前に取り直すか（ARCHITECTURE §6.2: 5 分前） */
export const REFRESH_BEFORE_MS = 5 * 60 * 1000;
const MAX_TIMEOUT = 2_000_000_000; // setTimeout の上限（約 24 日）に収める

/** 取り直しを始めるまでの待ち時間（ミリ秒）。すでに 5 分を切っていれば 0。 */
export function refreshDelayMs(expMs: number, nowMs: number): number {
  return Math.min(Math.max(expMs - REFRESH_BEFORE_MS - nowMs, 0), MAX_TIMEOUT);
}
