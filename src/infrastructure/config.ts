// Leitura das variáveis de ambiente num lugar só. O resto do código recebe o objeto pronto.

export type DatabaseDriver = 'sql' | 'memory';

export interface AppConfig {
  port: number;
  dbDriver: DatabaseDriver;
  sqlConnectionString?: string;
  queueConnectionString?: string;
  queueName: string;
  outboxIntervalMs: number;
  internalApiKey?: string;
  corsOrigin: string;
  logLevel: string;
  publicUrl?: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const sqlConnectionString = optional(env.SQL_CONNECTION_STRING);

  return {
    port: integer(env.PORT, 'PORT', 3002, 1, 65535),
    dbDriver: resolveDriver(optional(env.DB_DRIVER), sqlConnectionString),
    sqlConnectionString,
    queueConnectionString: optional(env.QUEUE_CONNECTION_STRING),
    queueName: optional(env.QUEUE_NAME) ?? 'order-events',
    outboxIntervalMs: integer(env.OUTBOX_INTERVAL_MS, 'OUTBOX_INTERVAL_MS', 3000, 100, 3_600_000),
    internalApiKey: optional(env.INTERNAL_API_KEY),
    corsOrigin: optional(env.CORS_ORIGIN) ?? '*',
    logLevel: optional(env.LOG_LEVEL) ?? 'info',
    publicUrl: optional(env.PUBLIC_URL)?.replace(/\/+$/, ''),
  };
}

// Sem DB_DRIVER, quem decide é a connection string: se existe usa SQL, senão sobe em memória.
function resolveDriver(driver: string | undefined, sqlConnectionString: string | undefined): DatabaseDriver {
  const chosen = driver?.toLowerCase() ?? (sqlConnectionString ? 'sql' : 'memory');
  if (chosen !== 'sql' && chosen !== 'memory') {
    throw new ConfigError(`DB_DRIVER inválido: "${driver}". Use "sql" ou "memory".`);
  }
  if (chosen === 'sql' && !sqlConnectionString) {
    throw new ConfigError('DB_DRIVER=sql exige a variável SQL_CONNECTION_STRING.');
  }
  return chosen;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function integer(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  const value = optional(raw);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} inválido: "${value}". Informe um número inteiro entre ${min} e ${max}.`);
  }
  return parsed;
}
