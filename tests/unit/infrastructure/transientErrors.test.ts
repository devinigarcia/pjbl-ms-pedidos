import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableError } from '../../../src/application/errors';
import { retryWithBackoff } from '../../../src/infrastructure/sql/retry';
import { isTransientSqlError, withTransientRetry } from '../../../src/infrastructure/sql/transientErrors';
import { captureError } from '../../support/testKit';

/** Erro no formato que o driver `mssql` devolve. */
function sqlError(fields: { code?: string; number?: number; message?: string; originalError?: unknown }): Error {
  return Object.assign(new Error(fields.message ?? 'erro de banco'), fields);
}

const PAUSED = sqlError({ code: 'EREQUEST', number: 40613, message: "Database 'pjbl-pedidos' is not currently available." });

/** Relógio de mentira: o `sleep` só soma o tempo, sem esperar de verdade. */
function fakeClock() {
  let current = 0;
  const delays: number[] = [];
  return {
    delays,
    now: () => current,
    sleep: async (ms: number) => {
      delays.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('isTransientSqlError', () => {
  it.each([40613, 40197, 40501, 49918, 49919, 49920])('erro %i do Azure SQL é passageiro', (number) => {
    expect(isTransientSqlError(sqlError({ code: 'EREQUEST', number }))).toBe(true);
  });

  it.each(['ETIMEOUT', 'ESOCKET', 'ECONNCLOSED'])('código %s do driver é passageiro', (code) => {
    expect(isTransientSqlError(sqlError({ code }))).toBe(true);
  });

  it('reconhece o erro embrulhado em originalError (falha de login com o banco acordando)', () => {
    const fromDriver = Object.assign(new Error("Database 'x' on server 'y' is not currently available."), {
      code: 'ELOGIN',
      isTransient: true,
    });
    const wrapped = sqlError({ code: 'ELOGIN', message: 'Login failed.', originalError: fromDriver });

    expect(isTransientSqlError(wrapped)).toBe(true);
    // mesmo sem a marca isTransient, o texto do servidor é reconhecido
    expect(isTransientSqlError(sqlError({ code: 'ELOGIN', message: 'Database is not currently available. (40613)' }))).toBe(true);
  });

  it.each([
    ['chave duplicada', sqlError({ code: 'EREQUEST', number: 2627 })],
    ['violação de CHECK', sqlError({ code: 'EREQUEST', number: 547 })],
    ['senha errada', sqlError({ code: 'ELOGIN', number: 18456, message: "Login failed for user 'x'." })],
    ['erro comum', new Error('algo quebrou')],
    ['texto', 'ETIMEOUT'],
    ['nulo', null],
    ['indefinido', undefined],
  ])('%s não é passageiro', (_name, error) => {
    expect(isTransientSqlError(error)).toBe(false);
  });

  it('não entra em laço com erros que apontam um para o outro', () => {
    const a: { cause?: unknown; message: string } = { message: 'a' };
    const b = { cause: a, message: 'b' };
    a.cause = b;
    expect(isTransientSqlError(a)).toBe(false);
  });
});

describe('withTransientRetry', () => {
  it('devolve o resultado direto quando a operação dá certo de primeira', async () => {
    const clock = fakeClock();
    const operation = vi.fn(async () => 'ok');

    expect(await withTransientRetry(operation, clock)).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(clock.delays).toEqual([]);
  });

  it('repete a operação inteira enquanto o erro for passageiro, com espera crescente', async () => {
    const clock = fakeClock();
    const attempts: number[] = [];
    const onRetry = vi.fn();
    const operation = async (attempt: number) => {
      attempts.push(attempt);
      if (attempt < 4) throw PAUSED;
      return 'acordou';
    };

    expect(await withTransientRetry(operation, { ...clock, onRetry })).toBe('acordou');
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(clock.delays).toEqual([1000, 2000, 4000]);
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenLastCalledWith({ attempt: 3, delayMs: 4000, error: PAUSED });
  });

  it('erro que não é passageiro sobe na hora, sem repetir', async () => {
    const clock = fakeClock();
    const duplicate = sqlError({ code: 'EREQUEST', number: 2627, message: 'Violation of PRIMARY KEY constraint' });
    const operation = vi.fn(async () => {
      throw duplicate;
    });

    expect(await captureError(withTransientRetry(operation, clock))).toBe(duplicate);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(clock.delays).toEqual([]);
  });

  it('desiste depois de ~20 segundos e lança DATABASE_UNAVAILABLE com Retry-After de 10s', async () => {
    const clock = fakeClock();
    const operation = vi.fn(async () => {
      throw PAUSED;
    });

    const error = await captureError(withTransientRetry(operation, clock));

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    const unavailable = error as ServiceUnavailableError;
    expect(unavailable.code).toBe('DATABASE_UNAVAILABLE');
    expect(unavailable.retryAfterSeconds).toBe(10);
    expect(unavailable.message).toContain('acordar');
    expect(unavailable.cause).toBe(PAUSED);

    // esperas de 1s, 2s, 4s, 5s e 5s = 17s; a próxima (5s) passaria dos 20s
    expect(clock.delays).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(operation).toHaveBeenCalledTimes(6);
    expect(clock.now()).toBeLessThanOrEqual(20_000);
  });

  it('conta o tempo gasto nas próprias tentativas (conexão que demora a falhar)', async () => {
    const clock = fakeClock();
    const operation = vi.fn(async () => {
      clock.advance(15_000); // cada tentativa leva 15s até dar timeout
      throw sqlError({ code: 'ETIMEOUT' });
    });

    const error = await captureError(withTransientRetry(operation, clock));

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(operation).toHaveBeenCalledTimes(2); // 15s + 1s de espera + 15s já estourou o limite
  });
});

describe('retryWithBackoff (conexão inicial)', () => {
  it('tenta até dar certo, dobrando a espera até o teto', async () => {
    const delays: number[] = [];
    const operation = vi.fn(async (attempt: number) => {
      if (attempt < 5) throw new Error('banco dormindo');
      return 'conectado';
    });

    const result = await retryWithBackoff(operation, {
      attempts: 6,
      baseDelayMs: 2000,
      maxDelayMs: 15_000,
      sleep: async (ms) => void delays.push(ms),
    });

    expect(result).toBe('conectado');
    expect(delays).toEqual([2000, 4000, 8000, 15_000]);
  });

  it('depois da última tentativa devolve o erro original', async () => {
    const failure = new Error('servidor não existe');
    const operation = vi.fn(async () => {
      throw failure;
    });

    const error = await captureError(
      retryWithBackoff(operation, { attempts: 6, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined }),
    );

    expect(error).toBe(failure);
    expect(operation).toHaveBeenCalledTimes(6);
  });
});
