import type { Router } from 'express';
import type { ListOrderEventsHandler } from '../../../application/features/ListOrderEvents/ListOrderEvents';

export function mapListOrderEvents(router: Router, handler: ListOrderEventsHandler): void {
  router.get('/events', async (req, res) => {
    res.json(await handler.execute(req.query));
  });
}
