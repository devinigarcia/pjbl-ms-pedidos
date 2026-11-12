import sql from 'mssql';
import type { OutboxMessage, OutboxRepository } from '../../application/ports/OutboxRepository';
import { mapOutboxRow, OUTBOX_COLUMNS, type OutboxRow } from './sqlHelpers';
import { withTransientRetry, type TransientRetryOptions } from './transientErrors';

/** Leitura e baixa das mensagens do outbox. A inserção acontece no SqlOrderRepository, junto do pedido. */
export class SqlOutboxRepository implements OutboxRepository {
  constructor(
    private readonly pool: sql.ConnectionPool,
    private readonly retry: TransientRetryOptions = {},
  ) {}

  listRecent(limit: number): Promise<{ items: OutboxMessage[]; total: number }> {
    return withTransientRetry(async () => {
      const result = await this.pool
        .request()
        .input('limit', sql.Int, limit)
        .query(
          `SELECT TOP (@limit) ${OUTBOX_COLUMNS}
           FROM dbo.OutboxMessages
           ORDER BY OccurredAt DESC, Id DESC;
           SELECT COUNT(*) AS Total FROM dbo.OutboxMessages;`,
        );

      const [rows, countRows] = result.recordsets as unknown as [OutboxRow[], Array<{ Total: number }>];
      return { items: rows.map(mapOutboxRow), total: Number(countRows[0]?.Total ?? 0) };
    }, this.retry);
  }

  fetchPending(limit: number): Promise<OutboxMessage[]> {
    return withTransientRetry(async () => {
      const result = await this.pool
        .request()
        .input('limit', sql.Int, limit)
        .query<OutboxRow>(
          `SELECT TOP (@limit) ${OUTBOX_COLUMNS}
           FROM dbo.OutboxMessages
           WHERE ProcessedAt IS NULL
           ORDER BY OccurredAt ASC, Id ASC;`,
        );
      return result.recordset.map(mapOutboxRow);
    }, this.retry);
  }

  markProcessed(id: string, processedAt: Date): Promise<void> {
    // O `ProcessedAt IS NULL` deixa a baixa idempotente: repetir não incrementa Attempts de novo.
    return withTransientRetry(async () => {
      await this.pool
        .request()
        .input('id', sql.UniqueIdentifier, id)
        .input('processedAt', sql.DateTime2(3), processedAt)
        .query(
          `UPDATE dbo.OutboxMessages
           SET ProcessedAt = @processedAt, Attempts = Attempts + 1, LastError = NULL
           WHERE Id = @id AND ProcessedAt IS NULL;`,
        );
    }, this.retry);
  }

  markFailed(id: string, error: string): Promise<void> {
    return withTransientRetry(async () => {
      await this.pool
        .request()
        .input('id', sql.UniqueIdentifier, id)
        .input('lastError', sql.NVarChar(1000), error.slice(0, 1000))
        .query(
          `UPDATE dbo.OutboxMessages
           SET Attempts = Attempts + 1, LastError = @lastError
           WHERE Id = @id AND ProcessedAt IS NULL;`,
        );
    }, this.retry);
  }

  countPending(): Promise<number> {
    return withTransientRetry(async () => {
      const result = await this.pool
        .request()
        .query<{ Total: number }>('SELECT COUNT(*) AS Total FROM dbo.OutboxMessages WHERE ProcessedAt IS NULL;');
      return Number(result.recordset[0]?.Total ?? 0);
    }, this.retry);
  }
}
