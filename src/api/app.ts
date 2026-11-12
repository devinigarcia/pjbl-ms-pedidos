import cors from 'cors';
import express, { Router, type Express, type Response } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { ChangeOrderStatusHandler } from '../application/features/ChangeOrderStatus/ChangeOrderStatus';
import type { CreateOrderHandler } from '../application/features/CreateOrder/CreateOrder';
import type { DeleteOrderHandler } from '../application/features/DeleteOrder/DeleteOrder';
import type { DispatchOrderEventsHandler } from '../application/features/DispatchOrderEvents/DispatchOrderEvents';
import type { GetOrderHandler } from '../application/features/GetOrder/GetOrder';
import type { ListOrderEventsHandler } from '../application/features/ListOrderEvents/ListOrderEvents';
import type { ListOrdersHandler } from '../application/features/ListOrders/ListOrders';
import type { UpdateOrderHandler } from '../application/features/UpdateOrder/UpdateOrder';
import type { EventPublisherKind } from '../application/ports/EventPublisher';
import type { AsyncApiDocument } from './asyncapi';
import { mapEventsDocs } from './eventsDocs';
import { mapChangeOrderStatus } from './features/ChangeOrderStatus/ChangeOrderStatusEndpoint';
import { mapCreateOrder } from './features/CreateOrder/CreateOrderEndpoint';
import { mapDeleteOrder } from './features/DeleteOrder/DeleteOrderEndpoint';
import { mapDispatchOrderEvents } from './features/DispatchOrderEvents/DispatchOrderEventsEndpoint';
import { mapGetOrder } from './features/GetOrder/GetOrderEndpoint';
import { mapListOrderEvents } from './features/ListOrderEvents/ListOrderEventsEndpoint';
import { mapListOrders } from './features/ListOrders/ListOrdersEndpoint';
import { mapUpdateOrder } from './features/UpdateOrder/UpdateOrderEndpoint';
import { apiKey } from './middlewares/apiKey';
import { CORRELATION_HEADER, correlationId } from './middlewares/correlationId';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { buildOpenApiDocument } from './openapi';

export interface AppHandlers {
  createOrder: CreateOrderHandler;
  listOrders: ListOrdersHandler;
  getOrder: GetOrderHandler;
  updateOrder: UpdateOrderHandler;
  changeOrderStatus: ChangeOrderStatusHandler;
  deleteOrder: DeleteOrderHandler;
  listOrderEvents: ListOrderEventsHandler;
  dispatchOrderEvents: DispatchOrderEventsHandler;
}

export interface AppDependencies {
  handlers: AppHandlers;
  logger: Logger;
  asyncApi: AsyncApiDocument;
  /** Só para o /health informar como o serviço está configurado. */
  health: { database: 'sql' | 'memory'; publisher: EventPublisherKind };
  internalApiKey?: string;
  /** `*` ou uma lista de origens separadas por vírgula. */
  corsOrigin?: string;
  publicUrl?: string;
}

/**
 * Monta a aplicação Express. Recebe tudo pronto (casos de uso, logger, configuração):
 * quem conhece banco e fila é só o main.ts.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(correlationId());
  app.use(
    pinoHttp({
      logger: deps.logger,
      // o probe de saúde bate aqui o tempo todo; não precisa encher o log
      autoLogging: { ignore: (req) => req.url === '/health' },
      customProps: (_req, res) => ({ correlationId: (res as Response).locals?.correlationId }),
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // só o essencial: cabeçalhos (onde vem a chave interna) ficam fora do log
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  // CSP desligada para as páginas do Swagger UI e do AsyncAPI conseguirem carregar seus scripts
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: parseCorsOrigin(deps.corsOrigin), exposedHeaders: [CORRELATION_HEADER, 'location', 'retry-after'] }));
  app.use(express.json({ limit: '100kb' }));

  // ---- rotas públicas (sem x-api-key) ----
  const publicRoutes = Router();
  publicRoutes.get('/', (_req, res) => res.redirect('/docs'));
  publicRoutes.get('/health', (_req, res) => {
    // Não consulta o banco de propósito: o probe da plataforma manteria o Azure SQL gratuito acordado.
    res.json({
      status: 'ok',
      service: 'ms-pedidos',
      database: deps.health.database,
      publisher: deps.health.publisher,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  const openApiDocument = buildOpenApiDocument({ publicUrl: deps.publicUrl });
  publicRoutes.get('/openapi.json', (_req, res) => res.json(openApiDocument));
  mapEventsDocs(publicRoutes, deps.asyncApi);
  app.use(publicRoutes);
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, { customSiteTitle: 'ms-pedidos — Swagger' }));

  // ---- daqui para baixo exige a chave interna (quando INTERNAL_API_KEY está definida) ----
  app.use(apiKey(deps.internalApiKey));

  // Vertical slices: cada feature registra a própria rota.
  const features = Router();
  mapCreateOrder(features, deps.handlers.createOrder);
  mapListOrders(features, deps.handlers.listOrders);
  mapGetOrder(features, deps.handlers.getOrder);
  mapUpdateOrder(features, deps.handlers.updateOrder);
  mapChangeOrderStatus(features, deps.handlers.changeOrderStatus);
  mapDeleteOrder(features, deps.handlers.deleteOrder);
  mapListOrderEvents(features, deps.handlers.listOrderEvents);
  mapDispatchOrderEvents(features, deps.handlers.dispatchOrderEvents);
  app.use(features);

  app.use(notFoundHandler());
  app.use(errorHandler(deps.logger));
  return app;
}

function parseCorsOrigin(value: string | undefined): string | string[] {
  if (!value || value.trim() === '*') return '*';
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length === 1 ? origins[0]! : origins;
}
