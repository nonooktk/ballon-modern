// 同じ記録への操作（確定・取り消し・復活）は直列に送る（前の応答を待ってから次を送る）。
// キーごとに Promise を鎖でつなぐ。前の操作が失敗しても、次の操作は流す。
const tails = new Map<string, Promise<unknown>>();

export function runSerial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
