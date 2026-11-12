import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/infrastructure/config';
import { buildSqlConfig } from '../../../src/infrastructure/sql/connectSql';
import { MIGRATION_STATEMENTS } from '../../../src/infrastructure/sql/migrations';
import { escapeLike, isDuplicateKeyError, normalizeGuid } from '../../../src/infrastructure/sql/sqlHelpers';

describe('loadConfig', () => {
  it('sem nenhuma variável sobe em memória, na porta 3002, com o publisher de log', () => {
    expect(loadConfig({})).toEqual({
      port: 3002,
      dbDriver: 'memory',
      sqlConnectionString: undefined,
      queueConnectionString: undefined,
      queueName: 'order-events',
      outboxIntervalMs: 3000,
      internalApiKey: undefined,
      corsOrigin: '*',
      logLevel: 'info',
      publicUrl: undefined,
    });
  });

  it('com SQL_CONNECTION_STRING usa SQL, a não ser que DB_DRIVER=memory force o contrário', () => {
    const SQL_CONNECTION_STRING = 'Server=tcp:exemplo.database.windows.net,1433;Database=pjbl-pedidos';

    expect(loadConfig({ SQL_CONNECTION_STRING }).dbDriver).toBe('sql');
    expect(loadConfig({ SQL_CONNECTION_STRING, DB_DRIVER: 'memory' }).dbDriver).toBe('memory');
  });

  it('lê as demais variáveis e tira a barra do final de PUBLIC_URL', () => {
    const config = loadConfig({
      PORT: '8080',
      QUEUE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
      QUEUE_NAME: 'fila-teste',
      OUTBOX_INTERVAL_MS: '500',
      INTERNAL_API_KEY: ' chave-de-teste ',
      CORS_ORIGIN: 'https://front.exemplo.com',
      LOG_LEVEL: 'debug',
      PUBLIC_URL: 'https://pedidos.exemplo.com/',
    });

    expect(config).toMatchObject({
      port: 8080,
      queueConnectionString: 'UseDevelopmentStorage=true',
      queueName: 'fila-teste',
      outboxIntervalMs: 500,
      internalApiKey: 'chave-de-teste',
      corsOrigin: 'https://front.exemplo.com',
      logLevel: 'debug',
      publicUrl: 'https://pedidos.exemplo.com',
    });
  });

  it('recusa configuração inválida com uma mensagem clara', () => {
    expect(() => loadConfig({ DB_DRIVER: 'sql' })).toThrow(ConfigError);
    expect(() => loadConfig({ DB_DRIVER: 'oracle' })).toThrow(/DB_DRIVER inválido/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT inválido/);
    expect(() => loadConfig({ OUTBOX_INTERVAL_MS: '5' })).toThrow(/OUTBOX_INTERVAL_MS inválido/);
  });
});

describe('buildSqlConfig', () => {
  it('entende a connection string no formato ADO do portal do Azure', () => {
    const config = buildSqlConfig(
      'Server=tcp:exemplo.database.windows.net,1433;Database=pjbl-pedidos;User ID=usuario;Password=valor=com;sinais;Encrypt=true;Connection Timeout=60',
    );

    expect(config).toMatchObject({
      server: 'exemplo.database.windows.net',
      port: 1433,
      database: 'pjbl-pedidos',
      user: 'usuario',
      connectionTimeout: 60_000,
      requestTimeout: 30_000,
    });
    expect(config.options?.encrypt).toBe(true);
    // o pool precisa conseguir esvaziar, senão o banco serverless nunca pausa
    expect(config.pool).toMatchObject({ min: 0, max: 10, idleTimeoutMillis: 30_000 });
  });

  it('liga a criptografia por padrão e respeita TrustServerCertificate (SQL Server local em Docker)', () => {
    const config = buildSqlConfig('Server=localhost,1433;Database=pedidos;User ID=sa;Password=x;TrustServerCertificate=true');

    expect(config.options?.encrypt).toBe(true);
    expect(config.options?.trustServerCertificate).toBe(true);
    expect(config.connectionTimeout).toBe(30_000);
  });
});

describe('ajudantes de SQL', () => {
  it('escapeLike faz %, _, [ e \\ serem procurados ao pé da letra', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('ana_souza')).toBe('ana\\_souza');
    expect(escapeLike('[teste]')).toBe('\\[teste]');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike("o'brien")).toBe("o'brien"); // aspas não são problema: o valor vai como parâmetro
    expect(escapeLike('texto comum')).toBe('texto comum');
  });

  it('normalizeGuid deixa em minúsculas o GUID que o SQL Server devolve em maiúsculas', () => {
    expect(normalizeGuid('7F9C2B1E-4D3A-4C8E-9B2F-1A2B3C4D5E6F')).toBe('7f9c2b1e-4d3a-4c8e-9b2f-1a2b3c4d5e6f');
  });

  it('isDuplicateKeyError reconhece violação de chave primária e de índice único', () => {
    expect(isDuplicateKeyError({ number: 2627 })).toBe(true);
    expect(isDuplicateKeyError({ number: 2601 })).toBe(true);
    expect(isDuplicateKeyError({ number: 547 })).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});

describe('migração do banco', () => {
  const normalize = (sqlText: string) => sqlText.replace(/\s+/g, ' ').trim();
  const schemaFile = readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'schema.sql'), 'utf8');

  it('docs/schema.sql tem exatamente os mesmos comandos que o serviço executa na subida', () => {
    // tira os comentários e separa pelos GO
    const documented = schemaFile
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(/^\s*GO\s*$/m)
      .map(normalize)
      .filter(Boolean);

    expect(documented).toEqual(MIGRATION_STATEMENTS.map(normalize));
  });

  it('todo comando é idempotente e cria um objeto só (um statement por batch)', () => {
    for (const statement of MIGRATION_STATEMENTS) {
      expect(statement).toMatch(/^IF (OBJECT_ID\(.+\) IS NULL|NOT EXISTS \(.+\))\nCREATE (TABLE|INDEX) /);
      expect(statement.match(/\bCREATE (TABLE|INDEX)\b/g)).toHaveLength(1);
      expect(statement).not.toMatch(/\bGO\b/);
    }
  });

  it('cria as três tabelas com as regras que protegem os dados', () => {
    const ddl = MIGRATION_STATEMENTS.join('\n');

    for (const table of ['dbo.Orders', 'dbo.OrderItems', 'dbo.OutboxMessages']) {
      expect(ddl).toContain(`CREATE TABLE ${table} (`);
    }
    expect(ddl).toContain('ON DELETE CASCADE');
    expect(ddl).toContain("CHECK (Status IN (N'PENDENTE', N'PAGO', N'ENVIADO', N'ENTREGUE', N'CANCELADO'))");
    expect(ddl).toContain('CHECK (Quantity BETWEEN 1 AND 999)');
    expect(ddl).toMatch(/Total\s+DECIMAL\(12,2\)/);
    expect(ddl).toMatch(/Payload\s+NVARCHAR\(MAX\)/);
  });
});
