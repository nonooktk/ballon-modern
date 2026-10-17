import { describe, expect, it } from "vitest";
import { runSerial } from "../serial";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runSerial（同じ記録への操作は直列）", () => {
  it("同じキーは、前の応答を待ってから次を始める", async () => {
    const log: string[] = [];
    const a = runSerial("rec:1", async () => { log.push("a開始"); await sleep(30); log.push("a終了"); });
    const b = runSerial("rec:1", async () => { log.push("b開始"); log.push("b終了"); });
    await Promise.all([a, b]);
    expect(log).toEqual(["a開始", "a終了", "b開始", "b終了"]);
  });

  it("別のキーは並んで進む", async () => {
    const log: string[] = [];
    const a = runSerial("rec:1", async () => { log.push("a開始"); await sleep(30); log.push("a終了"); });
    const b = runSerial("rec:2", async () => { log.push("b開始"); });
    await Promise.all([a, b]);
    expect(log.indexOf("b開始")).toBeLessThan(log.indexOf("a終了"));
  });

  it("前の操作が失敗しても、次の操作は流れる（失敗は呼んだ側に返る）", async () => {
    const a = runSerial("rec:3", async () => { throw new Error("失敗"); });
    const b = runSerial("rec:3", async () => "次は動く");
    await expect(a).rejects.toThrow("失敗");
    await expect(b).resolves.toBe("次は動く");
  });
});
