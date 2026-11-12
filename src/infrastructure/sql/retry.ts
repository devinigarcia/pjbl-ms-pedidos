export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Chamado antes de cada espera, para logar. */
  onRetry?: (info: { attempt: number; attempts: number; delayMs: number; error: unknown }) => void;
  /** Trocável nos testes para não esperar de verdade. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tenta de novo com espera dobrando a cada falha (2s, 4s, 8s...), limitada a `maxDelayMs`. */
export async function retryWithBackoff<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= options.attempts) {
        throw error;
      }
      const delayMs = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
      options.onRetry?.({ attempt, attempts: options.attempts, delayMs, error });
      await sleep(delayMs);
    }
  }
}
