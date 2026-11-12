import type { Router } from 'express';
import type { ListOrdersHandler } from '../../../application/features/ListOrders/ListOrders';

export function mapListOrders(router: Router, handler: ListOrdersHandler): void {
  router.get('/orders', async (req, res) => {
    res.json(await handler.execute(req.query));
  });
}
