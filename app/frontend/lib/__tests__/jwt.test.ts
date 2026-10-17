import { describe, expect, it } from "vitest";
import { decodeClaims, isDevToken, refreshDelayMs, tokenExpiryMs, tokenSub } from "../jwt";

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;

describe("ID トークンの期限と取り直し", () => {
  it("exp（秒）をミリ秒で返し、sub を読める", () => {
    const t = jwt({ exp: 1_800_000_000, sub: "u-1" });
    expect(tokenExpiryMs(t)).toBe(1_800_000_000_000);
    expect(tokenSub(t)).toBe("u-1");
  });
  it("開発トークン（dev:）は期限なし", () => {
    expect(isDevToken("dev:abc")).toBe(true);
    expect(tokenExpiryMs("dev:abc")).toBeNull();
  });
  it("壊れたトークンでも落ちない", () => {
    expect(decodeClaims("x.y.z")).toBeNull();
    expect(tokenExpiryMs("壊れている")).toBeNull();
  });
  it("期限の 5 分前に取り直す", () => {
    const now = 1_000_000;
    expect(refreshDelayMs(now + 60 * 60 * 1000, now)).toBe(55 * 60 * 1000);
  });
  it("すでに 5 分を切っていたら、すぐ取り直す（待ち 0）", () => {
    const now = 1_000_000;
    expect(refreshDelayMs(now + 4 * 60 * 1000, now)).toBe(0);
    expect(refreshDelayMs(now - 1, now)).toBe(0);
  });
});
