import sql from 'mssql';
import type { Logger } from 'pino';
import { retryWithBackoff, type RetryOptions } from './retry';

export interface ConnectSqlOptions {
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  retry?: Partial<RetryOptions>;
}

/**
 * Abre o pool de conexões com o Azure SQL.
 *
 * A connection string vem no formato ADO que o portal do Azure mostra
 * (`Server=tcp:...,1433;Database=...;User ID=...;Password=...;Encrypt=true`).
 *
 * O banco serverless gratuito "dorme" depois de um tempo sem uso e a primeira conexão
 * costuma falhar enquanto ele acorda. Por isso são 6 tentativas com espera crescente
 * (a falha definitiva derruba o processo e a plataforma reinicia o contêiner).
 */
export async function connectSql(connectionString: string, options: ConnectSqlOptions = {}): Promise<sql.ConnectionPool> {
  const { logger } = options;
  const config = buildSqlConfig(connectionString);

  return retryWithBackoff(
    async (attempt) => {
      const pool = new sql.ConnectionPool(config);
      try {
        await pool.connect();
      } catch (error) {
        await pool.close().catch(() => undefined);
        throw error;
      }
      // Erros de conexões ociosas do pool chegam por evento; sem ouvinte derrubariam o processo.
      pool.on('error', (error) => logger?.error({ err: error }, 'erro em conexão do pool SQL'));
      logger?.info({ server: config.server, database: config.database, attempt }, 'conectado ao SQL');
      return pool;
    },
    {
      // esperas de 3s, 6s, 12s, 20s e 20s: pouco mais de 1 minuto, que é o tempo que o banco leva para acordar
      attempts: 6,
      baseDelayMs: 3_000,
      maxDelayMs: 20_000,
      ...options.retry,
      onRetry: ({ attempt, attempts, delayMs, error }) =>
        logger?.warn(
          { attempt, attempts, delayMs, reason: error instanceof Error ? error.message : String(error) },
          'falha ao conectar no SQL (o banco pode estar acordando), tentando de novo',
        ),
    },
  );
}

/** Converte a connection string ADO na configuração do driver e completa os padrões. */
export function buildSqlConfig(connectionString: string): sql.config {
  const parsed = sql.ConnectionPool.parseConnectionString(connectionString);
  if (!parsed.server) {
    throw new Error('SQL_CONNECTION_STRING inválida: não encontrei o servidor (use o formato "Server=tcp:...;Database=...").');
  }

  return {
    ...parsed,
    connectionTimeout: parsed.connectionTimeout ?? 30_000,
    requestTimeout: parsed.requestTimeout ?? 30_000,
    options: {
      ...parsed.options,
      // o Azure SQL só aceita conexão criptografada
      encrypt: parsed.options.encrypt ?? true,
    },
    pool: {
      max: 10,
      // min 0 deixa o pool esvaziar quando não há uso, senão o banco serverless nunca pausa
      min: 0,
      idleTimeoutMillis: 30_000,
      ...parsed.pool,
    },
  };
}
