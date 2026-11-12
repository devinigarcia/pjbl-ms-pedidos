import { z } from 'zod';
import { ConflictError } from '../../../domain/errors';
import { ORDER_STATUSES } from '../../../domain/order/OrderStatus';
import { toOutboxMessages } from '../../events/OrderIntegrationEvent';
import { findOrderOrThrow } from '../../findOrder';
import type { OrderRepository } from '../../ports/OrderRepository';
import type { OutboxSignal } from '../../ports/OutboxSignal';
import type { RequestContext } from '../../RequestContext';
import { validate } from '../../validation';
import { toOrderView, type OrderView } from '../../views';

export const changeOrderStatusSchema = z.object({
  status: z.preprocess((value) => (typeof value === 'string' ? value.trim().toUpperCase() : value), z.enum(ORDER_STATUSES)),
});

export type ChangeOrderStatusInput = z.infer<typeof changeOrderStatusSchema>;

export class ChangeOrderStatusHandler {
  constructor(
    private readonly orders: OrderRepository,
    private readonly outboxSignal: OutboxSignal,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(id: string, input: unknown, context: RequestContext): Promise<OrderView> {
    const { status } = validate(changeOrderStatusSchema, input);
    const order = await findOrderOrThrow(this.orders, id);

    // Guarda o status que foi LIDO do banco: a gravação só vale se ele ainda for esse.
    const expectedStatus = order.status;
    order.changeStatus(status, this.now());

    // Cancelamento gera `order.cancelled`, gravado no outbox junto com o novo status.
    const outbox = toOutboxMessages(order.pullEvents(), context.correlationId);
    const saved = await this.orders.save(order, expectedStatus, outbox);
    if (!saved) {
      // Outra requisição chegou primeiro. Sem isso, dois cancelamentos simultâneos
      // gerariam dois eventos e o estoque seria devolvido em dobro.
      throw new ConflictError(
        'CONCURRENT_UPDATE',
        'O pedido foi alterado por outra requisição ao mesmo tempo. Consulte o pedido e tente novamente.',
      );
    }
    if (outbox.length > 0) {
      // só o cancelamento gera evento; as outras transições não precisam acordar o relay
      this.outboxSignal.notify();
    }
    return toOrderView(order);
  }
}
