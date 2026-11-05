// 共用的 HTTP 重試工具：429、5xx 和網路中斷會自動重試。
export async function withRetry(fn, label, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable || err instanceof TypeError; // TypeError = fetch 網路錯誤
      if (!retryable || i === tries - 1) break;
      const wait = err.retryAfterMs ?? 2000 * 2 ** i;
      console.warn(`[${label}] 第 ${i + 1} 次失敗，${wait}ms 後重試：${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function httpError(res, label) {
  const body = await res.text().catch(() => '');
  const err = new Error(`${label} HTTP ${res.status}：${body.slice(0, 500)}`);
  err.retryable = res.status === 429 || res.status >= 500;
  const ra = Number(res.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
  return err;
}
