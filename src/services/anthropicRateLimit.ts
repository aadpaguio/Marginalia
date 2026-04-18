/**
 * Shared handling for Anthropic org rate limits (429 / TPM windows).
 * Smart Scan and thread/eval requests both use the same proxy and can hit the same limits.
 */

export const RATE_LIMIT_RETRY_DELAYS_SEC = [60, 90, 120] as const;
export const MAX_RATE_LIMIT_RETRIES = 3;

export function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("Too Many Requests")
  );
}

/** Parse retry_after=N appended by `ask_claude_thread_proxy` from the Retry-After header. */
export function parseRetryAfterSeconds(e: unknown): number | null {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const m = msg.match(/retry_after=(\d+)/i);
  return m ? Math.min(300, Math.max(1, parseInt(m[1], 10))) : null;
}

export type AnthropicRateLimitRetryOptions = {
  /** Invoked once per second during the countdown before retry (inclusive of 0). */
  onRateLimitWait?: (secondsLeft: number) => void;
};

export async function withAnthropicRateLimitRetry<T>(
  fn: () => Promise<T>,
  options?: AnthropicRateLimitRetryOptions
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const headerSec = parseRetryAfterSeconds(e);
      const delaySec = headerSec ?? RATE_LIMIT_RETRY_DELAYS_SEC[attempt] ?? 120;
      if (attempt < MAX_RATE_LIMIT_RETRIES && isRateLimitError(e)) {
        console.warn(
          "[Anthropic] rate limited; waiting %ds then retrying (attempt %d of %d)",
          delaySec,
          attempt + 1,
          MAX_RATE_LIMIT_RETRIES
        );
        for (let left = delaySec; left >= 0; left--) {
          options?.onRateLimitWait?.(left);
          if (left > 0) await new Promise((r) => setTimeout(r, 1000));
        }
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}
