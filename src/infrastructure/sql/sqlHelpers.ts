import sql from 'mssql';
import type { OutboxMessage } from '../../application/ports/OutboxRepository';
import type { OrderEventType } from '../../domain/order/OrderEvents';

/**
 * Escapa os curingas do LIKE para o texto digitado ser procurado ao pé da letra.
 * Usado junto com `ESCAPE '\'` na consulta.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_[]/g, (char) => `\\${char}`);
}

/** O SQL Server devolve UNIQUEIDENTIFIER em maiúsculas; a API trabalha sempre com minúsculas. */
export function normalizeGuid(value: string): string {
  return value.toLowerCase();
}

/** Linhas afetadas pelo (único) comando da requisição. */
export function affectedRows(result: { rowsAffected: number[] }): number {
  return result.rowsAffected[0] ?? 0;
}

/** Violação de chave primária (2627) ou de índice único (2601). */
export function isDuplicateKeyError(error: unknown): boolean {
  const number = (error as { number?: unknown } | null)?.number;
  return number === 2627 || number === 2601;
}

/** Desfaz a transação sem esconder o erro original (se o servidor já abortou, o rollback também falha). */
export async function rollbackQuietly(transaction: sql.Transaction): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // nada a fazer: a transação já não existe mais do lado do servidor
  }
}

export interface OutboxRow {
  Id: string;
  Type: string;
  AggregateId: string;
  Payload: string;
  OccurredAt: Date;
  ProcessedAt: Date | null;
  Attempts: number;
  LastError: string | null;
}

export const OUTBOX_COLUMNS = 'Id, Type, AggregateId, Payload, OccurredAt, ProcessedAt, Attempts, LastError';

export function mapOutboxRow(row: OutboxRow): OutboxMessage {
  return {
    id: normalizeGuid(row.Id),
    type: row.Type as OrderEventType,
    aggregateId: normalizeGuid(row.AggregateId),
    payload: JSON.parse(row.Payload) as OutboxMessage['payload'],
    occurredAt: row.OccurredAt,
    processedAt: row.ProcessedAt ?? null,
    attempts: Number(row.Attempts),
    lastError: row.LastError ?? null,
  };
}

/** Insere as mensagens do outbox DENTRO da transação recebida (a mesma do pedido). */
export async function insertOutboxMessages(transaction: sql.Transaction, messages: OutboxMessage[]): Promise<void> {
  for (const message of messages) {
    await new sql.Request(transaction)
      .input('id', sql.UniqueIdentifier, message.id)
      .input('type', sql.NVarChar(50), message.type)
      .input('aggregateId', sql.UniqueIdentifier, message.aggregateId)
      .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(message.payload))
      .input('occurredAt', sql.DateTime2(3), message.occurredAt)
      .query(
        `INSERT INTO dbo.OutboxMessages (Id, Type, AggregateId, Payload, OccurredAt, ProcessedAt, Attempts, LastError)
         VALUES (@id, @type, @aggregateId, @payload, @occurredAt, NULL, 0, NULL);`,
      );
  }
}
