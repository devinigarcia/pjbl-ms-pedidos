import sql from 'mssql';
import type { OrderListFilter, OrderRepository } from '../../application/ports/OrderRepository';
import type { OutboxMessage } from '../../application/ports/OutboxRepository';
import { Order, type OrderItem, type OrderProps } from '../../domain/order/Order';
import type { OrderStatus } from '../../domain/order/OrderStatus';
import {
  affectedRows,
  escapeLike,
  insertOutboxMessages,
  isDuplicateKeyError,
  normalizeGuid,
  rollbackQuietly,
} from './sqlHelpers';
import { withTransientRetry, type TransientRetryOptions } from './transientErrors';

interface OrderRow {
  Id: string;
  CustomerName: string;
  CustomerEmail: string;
  Status: string;
  Total: number;
  Notes: string | null;
  CreatedAt: Date;
  UpdatedAt: Date;
}

interface OrderItemRow {
  OrderId: string;
  ProductId: string;
  ProductName: string;
  UnitPrice: number;
  Quantity: number;
}

const ORDER_COLUMNS = 'o.Id, o.CustomerName, o.CustomerEmail, o.Status, o.Total, o.Notes, o.CreatedAt, o.UpdatedAt';
const ITEM_COLUMNS = 'i.OrderId, i.ProductId, i.ProductName, i.UnitPrice, i.Quantity';

/**
 * Pedidos no Azure SQL.
 *
 *  - toda entrada vai por parâmetro tipado (nada de concatenar valor em SQL);
 *  - tudo que mexe em pedido + outbox roda dentro de uma transação só;
 *  - cada método público passa pelo `withTransientRetry`: se o banco gratuito estiver acordando,
 *    a operação INTEIRA é repetida (a transação é aberta de novo, nunca reaproveitada).
 */
export class SqlOrderRepository implements OrderRepository {
  constructor(
    private readonly pool: sql.ConnectionPool,
    private readonly retry: TransientRetryOptions = {},
  ) {}

  create(order: Order, outbox: OutboxMessage[]): Promise<void> {
    const props = order.toProps();
    return withTransientRetry(async (attempt) => {
      try {
        await this.insertOrder(props, outbox);
      } catch (error) {
        // Só acontece em nova tentativa: a anterior chegou a confirmar a transação, mas a conexão
        // caiu antes da resposta. O pedido (com itens e outbox) já está gravado, então está tudo certo.
        if (attempt > 1 && isDuplicateKeyError(error)) {
          return;
        }
        throw error;
      }
    }, this.retry);
  }

  findById(id: string): Promise<Order | null> {
    return withTransientRetry(async () => {
      const result = await this.pool
        .request()
        .input('id', sql.UniqueIdentifier, id)
        .query(
          `SELECT ${ORDER_COLUMNS} FROM dbo.Orders o WHERE o.Id = @id;
           SELECT ${ITEM_COLUMNS} FROM dbo.OrderItems i WHERE i.OrderId = @id ORDER BY i.Id;`,
        );

      const [orderRows, itemRows] = result.recordsets as unknown as [OrderRow[], OrderItemRow[]];
      const row = orderRows[0];
      return row ? toOrder(row, itemRows) : null;
    }, this.retry);
  }

  list(filter: OrderListFilter): Promise<{ items: Order[]; total: number }> {
    return withTransientRetry(() => this.queryPage(filter), this.retry);
  }

  save(order: Order, expectedStatus: OrderStatus, outbox: OutboxMessage[]): Promise<boolean> {
    const props = order.toProps();
    return withTransientRetry((attempt) => this.updateOrder(props, expectedStatus, outbox, attempt), this.retry);
  }

  delete(id: string, expectedStatus: OrderStatus): Promise<boolean> {
    return withTransientRetry(async () => {
      // Os itens saem junto pelo ON DELETE CASCADE da chave estrangeira.
      const result = await this.pool
        .request()
        .input('id', sql.UniqueIdentifier, id)
        .input('expectedStatus', sql.NVarChar(20), expectedStatus)
        .query('DELETE FROM dbo.Orders WHERE Id = @id AND Status = @expectedStatus;');
      return affectedRows(result) > 0;
    }, this.retry);
  }

  private async insertOrder(props: OrderProps, outbox: OutboxMessage[]): Promise<void> {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();

    try {
      await new sql.Request(transaction)
        .input('id', sql.UniqueIdentifier, props.id)
        .input('customerName', sql.NVarChar(120), props.customerName)
        .input('customerEmail', sql.NVarChar(160), props.customerEmail)
        .input('status', sql.NVarChar(20), props.status)
        .input('total', sql.Decimal(12, 2), props.total)
        .input('notes', sql.NVarChar(500), props.notes)
        .input('createdAt', sql.DateTime2(3), props.createdAt)
        .input('updatedAt', sql.DateTime2(3), props.updatedAt)
        .query(
          `INSERT INTO dbo.Orders (Id, CustomerName, CustomerEmail, Status, Total, Notes, CreatedAt, UpdatedAt)
           VALUES (@id, @customerName, @customerEmail, @status, @total, @notes, @createdAt, @updatedAt);`,
        );

      // Um INSERT por item, em ordem: o IDENTITY preserva a ordem em que os itens vieram no pedido.
      for (const item of props.items) {
        await new sql.Request(transaction)
          .input('orderId', sql.UniqueIdentifier, props.id)
          .input('productId', sql.NVarChar(64), item.productId)
          .input('productName', sql.NVarChar(160), item.productName)
          .input('unitPrice', sql.Decimal(12, 2), item.unitPrice)
          .input('quantity', sql.Int, item.quantity)
          .query(
            `INSERT INTO dbo.OrderItems (OrderId, ProductId, ProductName, UnitPrice, Quantity)
             VALUES (@orderId, @productId, @productName, @unitPrice, @quantity);`,
          );
      }

      // O evento entra na MESMA transação do pedido: é isso que faz o outbox ser "transacional".
      await insertOutboxMessages(transaction, outbox);
      await transaction.commit();
    } catch (error) {
      await rollbackQuietly(transaction);
      throw error;
    }
  }

  private async queryPage(filter: OrderListFilter): Promise<{ items: Order[]; total: number }> {
    // O WHERE é montado só com trechos fixos; os valores do filtro entram como parâmetros.
    const conditions: string[] = [];
    const search = filter.search?.trim();
    if (filter.status) {
      conditions.push('o.Status = @status');
    }
    if (search) {
      conditions.push(`(o.CustomerName LIKE @search ESCAPE '\\' OR o.CustomerEmail LIKE @search ESCAPE '\\')`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const request = this.pool
      .request()
      .input('offset', sql.Int, (filter.page - 1) * filter.pageSize)
      .input('pageSize', sql.Int, filter.pageSize);
    if (filter.status) {
      request.input('status', sql.NVarChar(20), filter.status);
    }
    if (search) {
      request.input('search', sql.NVarChar(256), `%${escapeLike(search)}%`);
    }

    const result = await request.query(
      `SELECT COUNT(*) AS Total FROM dbo.Orders o ${where};
       SELECT ${ORDER_COLUMNS}
       FROM dbo.Orders o
       ${where}
       ORDER BY o.CreatedAt DESC, o.Id DESC
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;`,
    );

    const [countRows, orderRows] = result.recordsets as unknown as [Array<{ Total: number }>, OrderRow[]];
    const total = Number(countRows[0]?.Total ?? 0);
    if (orderRows.length === 0) {
      return { items: [], total };
    }

    // Itens de todos os pedidos da página numa consulta só: a lista de ids vai como JSON e o OPENJSON
    // transforma em linhas (evita uma consulta por pedido e também um IN montado na mão).
    const ids = orderRows.map((row) => normalizeGuid(row.Id));
    const itemsResult = await this.pool
      .request()
      .input('ids', sql.NVarChar(sql.MAX), JSON.stringify(ids))
      .query<OrderItemRow>(
        `SELECT ${ITEM_COLUMNS}
         FROM dbo.OrderItems i
         INNER JOIN OPENJSON(@ids) AS pageIds ON i.OrderId = CONVERT(UNIQUEIDENTIFIER, pageIds.[value])
         ORDER BY i.Id;`,
      );

    const itemsByOrder = new Map<string, OrderItemRow[]>();
    for (const item of itemsResult.recordset) {
      const orderId = normalizeGuid(item.OrderId);
      const bucket = itemsByOrder.get(orderId);
      if (bucket) {
        bucket.push(item);
      } else {
        itemsByOrder.set(orderId, [item]);
      }
    }

    return {
      items: orderRows.map((row) => toOrder(row, itemsByOrder.get(normalizeGuid(row.Id)) ?? [])),
      total,
    };
  }

  private async updateOrder(
    props: OrderProps,
    expectedStatus: OrderStatus,
    outbox: OutboxMessage[],
    attempt: number,
  ): Promise<boolean> {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();

    try {
      // Concorrência otimista: só atualiza se o status no banco ainda for o que o caso de uso leu.
      // Se duas requisições cancelarem ao mesmo tempo, a segunda afeta 0 linhas e não gera evento.
      const result = await new sql.Request(transaction)
        .input('id', sql.UniqueIdentifier, props.id)
        .input('expectedStatus', sql.NVarChar(20), expectedStatus)
        .input('customerName', sql.NVarChar(120), props.customerName)
        .input('customerEmail', sql.NVarChar(160), props.customerEmail)
        .input('notes', sql.NVarChar(500), props.notes)
        .input('status', sql.NVarChar(20), props.status)
        .input('updatedAt', sql.DateTime2(3), props.updatedAt)
        .query(
          `UPDATE dbo.Orders
           SET CustomerName = @customerName,
               CustomerEmail = @customerEmail,
               Notes = @notes,
               Status = @status,
               UpdatedAt = @updatedAt
           WHERE Id = @id AND Status = @expectedStatus;`,
        );

      if (affectedRows(result) === 0) {
        // Em nova tentativa, 0 linhas também pode significar que a tentativa anterior foi confirmada
        // e só a resposta se perdeu. Se o pedido já está exatamente como íamos gravar, deu certo.
        const alreadyApplied = attempt > 1 && (await this.matchesState(transaction, props));
        await transaction.rollback();
        return alreadyApplied;
      }

      await insertOutboxMessages(transaction, outbox);
      await transaction.commit();
      return true;
    } catch (error) {
      await rollbackQuietly(transaction);
      throw error;
    }
  }

  private async matchesState(transaction: sql.Transaction, props: OrderProps): Promise<boolean> {
    const result = await new sql.Request(transaction)
      .input('id', sql.UniqueIdentifier, props.id)
      .input('status', sql.NVarChar(20), props.status)
      .input('updatedAt', sql.DateTime2(3), props.updatedAt)
      .query<{ Total: number }>(
        'SELECT COUNT(*) AS Total FROM dbo.Orders WHERE Id = @id AND Status = @status AND UpdatedAt = @updatedAt;',
      );
    return Number(result.recordset[0]?.Total ?? 0) > 0;
  }
}

function toOrder(row: OrderRow, itemRows: OrderItemRow[]): Order {
  const items: OrderItem[] = itemRows.map((item) => ({
    productId: item.ProductId,
    productName: item.ProductName,
    // DECIMAL: o driver pode devolver número ou texto dependendo da versão; Number() cobre os dois
    unitPrice: Number(item.UnitPrice),
    quantity: Number(item.Quantity),
  }));

  return Order.restore({
    id: normalizeGuid(row.Id),
    customerName: row.CustomerName,
    customerEmail: row.CustomerEmail,
    status: row.Status as OrderStatus,
    items,
    total: Number(row.Total),
    notes: row.Notes ?? null,
    createdAt: row.CreatedAt,
    updatedAt: row.UpdatedAt,
  });
}
