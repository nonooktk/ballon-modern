import { describe, expect, it } from "vitest";
import { bigLabel, dateLabel, mergeProgress, smallLabel } from "../home";
import type { Progress } from "../types";

const P = (total: number, cur = total): Progress => ({
  level: 1, current_points: cur, required_points: 50, remaining_points: 50 - cur, total_points: total, is_max: false,
});

describe("mergeProgress（点は減らない）", () => {
  it("古い応答が遅れて届いても、点を巻き戻さない", () => {
    expect(mergeProgress(P(30), P(20)).total_points).toBe(30);
  });
  it("新しい応答は採る", () => {
    expect(mergeProgress(P(30), P(40)).total_points).toBe(40);
  });
  it("累計が同じなら新しい応答を採る（取り消しなど）", () => {
    const next = { ...P(30), remaining_points: 20 };
    expect(mergeProgress(P(30), next)).toBe(next);
  });
});

describe("札の文言", () => {
  it("大は「…！」つき、小は無し（どちらの形で API が返しても揃う）", () => {
    expect(bigLabel("夕食を食べた")).toBe("夕食を食べた…！");
    expect(bigLabel("夕食を食べた…！")).toBe("夕食を食べた…！");
    expect(smallLabel("朝食を食べた…！")).toBe("朝食を食べた");
    expect(smallLabel("朝食を食べた")).toBe("朝食を食べた");
  });
  it("日付は API の local_date をそのまま整える（端末の時計は見ない）", () => {
    expect(dateLabel("2026-10-17", "night")).toBe("10月17日（土）夜");
    expect(dateLabel("不正な値", "morning")).toBe("朝");
  });
});
