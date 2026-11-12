// Teste de integração com SQL Server / Azure SQL DE VERDADE.
//
// Só roda quando a variável SQL_TEST_CONNECTION_STRING está definida (mesmo formato da
// SQL_CONNECTION_STRING). Sem ela, o arquivo inteiro aparece como "skipped".
//
//   PowerShell:  $env:SQL_TEST_CONNECTION_STRING = "Server=tcp:...;Database=...;User ID=...;Password=...;Encrypt=true"
//                npm test -- tests/integration/sqlRepositories.test.ts
//
// Os testes criam pedidos marcados com um texto único e apagam tudo no final, então podem rodar
// num banco que já tem dados. Mesmo assim, o ideal é usar um banco separado do que está em produção.

import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toOutboxMessages } from '../../src/application/events/OrderIntegrationEvent';
import { Order } from '../../src/domain/order/Order';
import { connectSql } from '../../src/infrastructure/sql/connectSql';
import { MIGRATION_STATEMENTS, runMigrations } from '../../src/infrastructure/sql/migrations';
import { SqlOrderRepository } from '../../src/infrastructure/sql/SqlOrderRepository';
import { SqlOutboxRepository } from '../../src/infrastructure/sql/SqlOutboxRepository';
import { describeRepositoryContract, type RepositoryFixture } from '../support/repositoryContract';

const connectionString = process.env.SQL_TEST_CONNECTION_STRING;
const marker = `it${randomUUID().slice(0, 8)}`;

describe.skipIf(!connectionString)('Azure SQL — integração (SQL_TEST_CONNECTION_STRING)', () => {
  let pool: sql.ConnectionPool;
  let fixture: RepositoryFixture;

  beforeAll(async () => {
    // connectSql já espera o banco serverless "acordar" (6 tentativas com espera crescente)
    pool = await connectSql(connectionString!);
    await runMigrations(pool);
    fixture = { orders: new SqlOrderRepository(pool), outbox: new SqlOutboxRepository(pool), marker };
  });

  afterAll(async () => {
    if (!pool) return;
    // Limpeza: tudo que os testes criaram leva o marcador no e-mail do cliente (que também está no payload do evento).
    const like = `%${marker}@teste.local%`;
    await pool.request().input('like', sql.NVarChar(200), like).query('DELETE FROM dbo.OutboxMessages WHERE Payload LIKE @like;');
    await pool.request().input('like', sql.NVarChar(200), like).query('DELETE FROM dbo.Orders WHERE CustomerEmail LIKE @like;');
    await pool.close();
  });

  describe('migração', () => {
    it('é idempotente: rodar de novo (duas vezes) não dá erro nem duplica nada', async () => {
      await runMigrations(pool);
      await runMigrations(pool);

      const tables = await pool.request().query<{ name: string }>(
        `SELECT name FROM sys.tables WHERE name IN (N'Orders', N'OrderItems', N'OutboxMessages') AND schema_id = SCHEMA_ID(N'dbo') ORDER BY name;`,
      );
      expect(tables.recordset.map((row) => row.name)).toEqual(['OrderItems', 'Orders', 'OutboxMessages']);

      const indexes = await pool.request().query<{ name: string; total: number }>(
        `SELECT name, COUNT(*) AS total FROM sys.indexes WHERE name LIKE N'IX[_]%'
         AND object_id IN (OBJECT_ID(N'dbo.Orders'), OBJECT_ID(N'dbo.OrderItems'), OBJECT_ID(N'dbo.OutboxMessages'))
         GROUP BY name ORDER BY name;`,
      );
      const expectedIndexes = MIGRATION_STATEMENTS.map((statement) => /CREATE INDEX (\w+)/.exec(statement)?.[1])
        .filter((name): name is string => Boolean(name))
        .sort();
      expect(indexes.recordset.map((row) => row.name).sort()).toEqual(expectedIndexes);
      expect(indexes.recordset.every((row) => row.total === 1)).toBe(true);
    });
  });

  describe('detalhes que só existem no SQL', () => {
    async function createOrder(): Promise<Order> {
      const order = Order.create(
        {
          id: randomUUID(),
          customerName: `Cliente SQL ${marker}`,
          customerEmail: `sql.${marker}@teste.local`,
          items: [
            { productId: 'prod-cafe', productName: 'Café torrado 500g', unitPrice: 24.9, quantity: 2 },
            { productId: 'prod-filtro', productName: 'Filtro de papel 103', unitPrice: 6.5, quantity: 1 },
          ],
        },
        new Date(),
      );
      await fixture.orders.create(order, toOutboxMessages(order.pullEvents(), `corr-${marker}`));
      return order;
    }

    const countRows = async (table: 'OrderItems' | 'OutboxMessages', column: 'OrderId' | 'AggregateId', id: string) => {
      const result = await pool
        .request()
        .input('id', sql.UniqueIdentifier, id)
        .query<{ total: number }>(`SELECT COUNT(*) AS total FROM dbo.${table} WHERE ${column} = @id;`);
      return result.recordset[0]!.total;
    };

    it('grava pedido, itens e outbox na mesma transação, com os tipos certos nas colunas', async () => {
      const order = await createOrder();

      const row = await pool
        .request()
        .input('id', sql.UniqueIdentifier, order.id)
        .query<{ Status: string; Total: number; CreatedAt: Date; Notes: string | null }>(
          'SELECT Status, Total, CreatedAt, Notes FROM dbo.Orders WHERE Id = @id;',
        );
      expect(row.recordset[0]).toMatchObject({ Status: 'PENDENTE', Total: 56.3, Notes: null });
      expect(row.recordset[0]!.CreatedAt.toISOString()).toBe(order.createdAt.toISOString());
      expect(await countRows('OrderItems', 'OrderId', order.id)).toBe(2);
      expect(await countRows('OutboxMessages', 'AggregateId', order.id)).toBe(1);
    });

    it('excluir o pedido apaga os itens em cascata e mantém os eventos', async () => {
      const order = await createOrder();
      const loaded = (await fixture.orders.findById(order.id))!;
      loaded.changeStatus('CANCELADO', new Date());
      await fixture.orders.save(loaded, 'PENDENTE', toOutboxMessages(loaded.pullEvents(), `corr-${marker}`));
      expect(await countRows('OrderItems', 'OrderId', order.id)).toBe(2);

      expect(await fixture.orders.delete(order.id, 'CANCELADO')).toBe(true);

      expect(await countRows('OrderItems', 'OrderId', order.id)).toBe(0);
      expect(await countRows('OutboxMessages', 'AggregateId', order.id)).toBe(2);
    });

    it('o banco recusa status fora da lista (CHECK), como segunda barreira além do domínio', async () => {
      const order = await createOrder();

      await expect(
        pool
          .request()
          .input('id', sql.UniqueIdentifier, order.id)
          .query(`UPDATE dbo.Orders SET Status = N'INVENTADO' WHERE Id = @id;`),
      ).rejects.toThrow(/CK_Orders_Status/);
    });

    it('aceita o id em maiúsculas ou minúsculas e sempre devolve em minúsculas', async () => {
      const order = await createOrder();

      const found = await fixture.orders.findById(order.id.toUpperCase());

      expect(found!.id).toBe(order.id.toLowerCase());
    });
  });

  // Os mesmos testes de contrato do repositório em memória: criar+ler, listagem com filtro e
  // paginação, outbox na mesma transação, concorrência otimista, exclusão.
  describeRepositoryContract('Azure SQL', () => fixture);
});
