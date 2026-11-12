import { z } from 'zod';
import type { OutboxRepository } from '../../ports/OutboxRepository';
import { emptyAsUndefined } from '../../schemas';
import { validate } from '../../validation';
import { toOutboxItemView, type OutboxItemView } from '../../views';

export const MAX_EVENTS_LIMIT = 100;

export const listOrderEventsSchema = z.object({
  limit: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int('Deve ser um número inteiro.').min(1).max(MAX_EVENTS_LIMIT).default(20),
  ),
});

export interface ListOrderEventsResult {
  items: OutboxItemView[];
  /** Total de mensagens no outbox (não só as devolvidas). */
  total: number;
}

export class ListOrderEventsHandler {
  constructor(private readonly outbox: OutboxRepository) {}

  async execute(query: unknown): Promise<ListOrderEventsResult> {
    const { limit } = validate(listOrderEventsSchema, query);
    const { items, total } = await this.outbox.listRecent(limit);
    return { items: items.map(toOutboxItemView), total };
  }
}
