"""メモリ上の窓によるレート制限。1 インスタンス・ワーカー 1 つ前提（ARCHITECTURE ADR-4）。"""
from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable


class RateLimiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = {}

    def hit(self, key: str, rules: list[tuple[int, int]]) -> int | None:
        """1 回数える。rules は (窓の秒数, 上限回数) の並び。
        どれかを超えたら数えずに待ち秒数（切り上げ）を返す。通れば None。"""
        now = self._clock()
        longest = max(w for w, _ in rules)
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and now - q[0] >= longest:
                q.popleft()
            retry = 0
            for window, limit in rules:
                recent = [t for t in q if now - t < window]
                if len(recent) >= limit:
                    retry = max(retry, math.ceil(recent[0] + window - now))
            if retry:
                return max(retry, 1)
            q.append(now)
            if len(self._hits) > 20000:
                self._sweep(now, longest)
            return None

    def _sweep(self, now: float, longest: float) -> None:
        for k in [k for k, q in self._hits.items() if not q or now - q[-1] >= longest]:
            del self._hits[k]
