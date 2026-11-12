import { ServiceUnavailableError } from '../../application/errors';

// Números de erro do Azure SQL que significam "tente de novo daqui a pouco":
// 40613 banco indisponível (é o que aparece enquanto o serverless acorda), 40197 e 40501 serviço
// ocupado/reconfigurando, 49918/49919/49920 muitas operações em andamento.
const TRANSIENT_ERROR_NUMBERS = new Set([40613, 40197, 40501, 49918, 49919, 49920]);

// Códigos do driver para problemas de rede/conexão.
const TRANSIENT_ERROR_CODES = new Set(['ETIMEOUT', 'ESOCKET', 'ECONNCLOSED']);

// Na falha de login o driver nem sempre repassa o número, só o texto do servidor.
const TRANSIENT_MESSAGE = /is not currently available|\b(40613|40197|40501|49918|49919|49920)\b/i;

interface ErrorLike {
  code?: unknown;
  number?: unknown;
  message?: unknown;
  isTransient?: unknown;
  originalError?: unknown;
  cause?: unknown;
}

/**
 * Diz se o erro é passageiro (banco acordando, conexão caiu, timeout).
 * O `mssql` embrulha o erro do driver em `originalError`, então a função olha a cadeia inteira.
 */
export function isTransientSqlError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as ErrorLike;

    if (candidate.isTransient === true) return true;
    if (typeof candidate.number === 'number' && TRANSIENT_ERROR_NUMBERS.has(candidate.number)) return true;
    if (typeof candidate.code === 'string' && TRANSIENT_ERROR_CODES.has(candidate.code)) return true;
    if (typeof candidate.message === 'string' && TRANSIENT_MESSAGE.test(candidate.message)) return true;

    current = candidate.originalError ?? candidate.cause;
  }
  return false;
}

export interface TransientRetryOptions {
  /** Tempo máximo, somando tentativas e esperas, antes de desistir. */
  maxTotalMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Trocáveis nos testes. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS = 10;

const DATABASE_UNAVAILABLE_MESSAGE =
  'O banco de dados está temporariamente indisponível. O Azure SQL gratuito pausa quando fica sem uso ' +
  'e leva cerca de um minuto para acordar. Tente novamente em alguns segundos.';

/**
 * Executa uma operação de banco e, se o erro for passageiro, repete A OPERAÇÃO INTEIRA
 * (nunca um pedaço de transação) com esperas curtas: 1s, 2s, 4s, 5s... até uns 20s no total.
 * Erro que não é passageiro sobe na hora. Se o tempo acabar, vira ServiceUnavailableError (503 na API).
 */
export async function withTransientRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const maxTotalMs = options.maxTotalMs ?? 20_000;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  const startedAt = now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isTransientSqlError(error)) {
        throw error;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      if (now() - startedAt + delayMs > maxTotalMs) {
        throw new ServiceUnavailableError(
          'DATABASE_UNAVAILABLE',
          DATABASE_UNAVAILABLE_MESSAGE,
          DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS,
          { cause: error },
        );
      }
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
