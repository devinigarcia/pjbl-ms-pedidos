import type { Router } from 'express';
import type { ChangeOrderStatusHandler } from '../../../application/features/ChangeOrderStatus/ChangeOrderStatus';
import { getCorrelationId } from '../../middlewares/correlationId';

export function mapChangeOrderStatus(router: Router, handler: ChangeOrderStatusHandler): void {
  router.patch('/orders/:id/status', async (req, res) => {
    const order = await handler.execute(req.params.id, req.body, { correlationId: getCorrelationId(res) });
    res.json(order);
  });
}
