import { z } from 'zod';
import { ORDER_STATUSES } from '../../../domain/order/OrderStatus';
import type { OrderRepository } from '../../ports/OrderRepository';
import { emptyAsUndefined } from '../../schemas';
import { validate } from '../../validation';
import { toOrderView, type OrderView } from '../../views';

export const MAX_PAGE_SIZE = 100;

export const listOrdersSchema = z.object({
  status: z.preprocess(
    (value) => (typeof value === 'string' ? emptyAsUndefined(value.toUpperCase()) : value),
    z.enum(ORDER_STATUSES).optional(),
  ),
  search: z.preprocess(emptyAsUndefined, z.string().trim().max(100).optional()),
  page: z.preprocess(emptyAsUndefined, z.coerce.number().int('Deve ser um número inteiro.').min(1).default(1)),
  pageSize: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int('Deve ser um número inteiro.').min(1).max(MAX_PAGE_SIZE).default(20),
  ),
});

export interface ListOrdersResult {
  items: OrderView[];
  total: number;
  page: number;
  pageSize: number;
}

export class ListOrdersHandler {
  constructor(private readonly orders: OrderRepository) {}

  async execute(query: unknown): Promise<ListOrdersResult> {
    const { status, search, page, pageSize } = validate(listOrdersSchema, query);
    const { items, total } = await this.orders.list({ status, search, page, pageSize });
    return { items: items.map(toOrderView), total, page, pageSize };
  }
}
