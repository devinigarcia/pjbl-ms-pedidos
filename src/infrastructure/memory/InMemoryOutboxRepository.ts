import type { OutboxMessage, OutboxRepository } from '../../application/ports/OutboxRepository';
import { cloneOutboxMessage, type InMemoryDatabase, type StoredOutboxMessage } from './InMemoryDatabase';

export class InMemoryOutboxRepository implements OutboxRepository {
  constructor(private readonly db: InMemoryDatabase) {}

  async listRecent(limit: number): Promise<{ items: OutboxMessage[]; total: number }> {
    const newestFirst = [...this.db.outbox].sort((a, b) => -byOccurrence(a, b));
    return {
      items: newestFirst.slice(0, limit).map(({ message }) => cloneOutboxMessage(message)),
      total: this.db.outbox.length,
    };
  }

  async fetchPending(limit: number): Promise<OutboxMessage[]> {
    return this.db.outbox
      .filter(({ message }) => message.processedAt === null)
      .sort(byOccurrence)
      .slice(0, limit)
      .map(({ message }) => cloneOutboxMessage(message));
  }

  async markProcessed(id: string, processedAt: Date): Promise<void> {
    const message = this.findPending(id);
    if (!message) return;
    message.processedAt = new Date(processedAt);
    message.attempts += 1;
    message.lastError = null;
  }

  async markFailed(id: string, error: string): Promise<void> {
    const message = this.findPending(id);
    if (!message) return;
    message.attempts += 1;
    message.lastError = error.slice(0, 1000);
  }

  async countPending(): Promise<number> {
    return this.db.outbox.filter(({ message }) => message.processedAt === null).length;
  }

  private findPending(id: string): OutboxMessage | undefined {
    const key = id.toLowerCase();
    return this.db.outbox.find(({ message }) => message.id === key && message.processedAt === null)?.message;
  }
}

/** Mais antigas primeiro; a ordem de inserção desempata. */
function byOccurrence(a: StoredOutboxMessage, b: StoredOutboxMessage): number {
  return a.message.occurredAt.getTime() - b.message.occurredAt.getTime() || a.sequence - b.sequence;
}
