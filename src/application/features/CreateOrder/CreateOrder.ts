import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Order } from '../../../domain/order/Order';
import { ORDER_RULES } from '../../../domain/order/OrderRules';
import { toOutboxMessages } from '../../events/OrderIntegrationEvent';
import type { OrderRepository } from '../../ports/OrderRepository';
import type { OutboxSignal } from '../../ports/OutboxSignal';
import type { RequestContext } from '../../RequestContext';
import { customerEmailSchema, customerNameSchema, notesSchema } from '../../schemas';
import { validate } from '../../validation';
import { toOrderView, type OrderView } from '../../views';

export const createOrderSchema = z.object({
  customerName: customerNameSchema,
  customerEmail: customerEmailSchema,
  notes: notesSchema,
  items: z
    .array(
      z.object({
        productId: z.string().trim().min(1).max(ORDER_RULES.productIdMax),
        productName: z.string().trim().min(1).max(ORDER_RULES.productNameMax),
        unitPrice: z.number().finite().positive('Deve ser maior que zero.').max(ORDER_RULES.maxUnitPrice),
        quantity: z.number().int('Deve ser um número inteiro.').min(ORDER_RULES.minQuantity).max(ORDER_RULES.maxQuantity),
      }),
    )
    .min(ORDER_RULES.minItems, 'O pedido precisa de pelo menos 1 item.')
    .max(ORDER_RULES.maxItems),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export class CreateOrderHandler {
  constructor(
    private readonly orders: OrderRepository,
    private readonly outboxSignal: OutboxSignal,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: unknown, context: RequestContext): Promise<OrderView> {
    const data = validate(createOrderSchema, input);

    // As regras de negócio (item repetido, total etc.) estão no agregado.
    const order = Order.create({ id: randomUUID(), ...data }, this.now());

    // Pedido e evento `order.created` vão juntos: ou gravam os dois, ou nenhum.
    const outbox = toOutboxMessages(order.pullEvents(), context.correlationId);
    await this.orders.create(order, outbox);

    // Transação confirmada: avisa o relay para publicar agora (ele não fica consultando o banco à toa).
    this.outboxSignal.notify();

    return toOrderView(order);
  }
}
