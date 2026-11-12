import type { Router } from 'express';
import type { CreateOrderHandler } from '../../../application/features/CreateOrder/CreateOrder';
import { getCorrelationId } from '../../middlewares/correlationId';

export function mapCreateOrder(router: Router, handler: CreateOrderHandler): void {
  router.post('/orders', async (req, res) => {
    const order = await handler.execute(req.body, { correlationId: getCorrelationId(res) });
    res.status(201).location(`/orders/${order.id}`).json(order);
  });
}
