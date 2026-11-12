// Composition root: é o único arquivo que conhece ao mesmo tempo a infraestrutura e a API.
// Aqui as peças são criadas e ligadas umas nas outras; o resto do código só enxerga interfaces.

import type { Server } from 'node:http';
import { createApp } from './api/app';
import { loadAsyncApiDocument } from './api/asyncapi';
import { ChangeOrderStatusHandler } from './application/features/ChangeOrderStatus/ChangeOrderStatus';
import { CreateOrderHandler } from './application/features/CreateOrder/CreateOrder';
import { DeleteOrderHandler } from './application/features/DeleteOrder/DeleteOrder';
import { DispatchOrderEventsHandler } from './application/features/DispatchOrderEvents/DispatchOrderEvents';
import { GetOrderHandler } from './application/features/GetOrder/GetOrder';
import { ListOrderEventsHandler } from './application/features/ListOrderEvents/ListOrderEvents';
import { ListOrdersHandler } from './application/features/ListOrders/ListOrders';
import { UpdateOrderHandler } from './application/features/UpdateOrder/UpdateOrder';
import type { EventPublisher } from './application/ports/EventPublisher';
import type { OrderRepository } from './application/ports/OrderRepository';
import type { OutboxRepository } from './application/ports/OutboxRepository';
import { loadConfig, type AppConfig } from './infrastructure/config';
import { createLogger } from './infrastructure/logger';
import { InMemoryDatabase } from './infrastructure/memory/InMemoryDatabase';
import { InMemoryOrderRepository } from './infrastructure/memory/InMemoryOrderRepository';
import { InMemoryOutboxRepository } from './infrastructure/memory/InMemoryOutboxRepository';
import { AzureQueueEventPublisher } from './infrastructure/messaging/AzureQueueEventPublisher';
import { LogEventPublisher } from './infrastructure/messaging/LogEventPublisher';
import { OutboxRelay } from './infrastructure/outbox/OutboxRelay';
import { connectSql } from './infrastructure/sql/connectSql';
import { runMigrations } from './infrastructure/sql/migrations';
import { SqlOrderRepository } from './infrastructure/sql/SqlOrderRepository';
import { SqlOutboxRepository } from './infrastructure/sql/SqlOutboxRepository';
import type { TransientRetryOptions } from './infrastructure/sql/transientErrors';

interface Persistence {
  orders: OrderRepository;
  outbox: OutboxRepository;
  close: () => Promise<void>;
}

type AppLogger = ReturnType<typeof createLogger>;

async function createPersistence(config: AppConfig, logger: AppLogger): Promise<Persistence> {
  if (config.dbDriver === 'sql' && config.sqlConnectionString) {
    const pool = await connectSql(config.sqlConnectionString, { logger });
    await runMigrations(pool, logger);

    const retry: TransientRetryOptions = {
      onRetry: ({ attempt, delayMs, error }) =>
        logger.warn(
          { attempt, delayMs, reason: error instanceof Error ? error.message : String(error) },
          'banco indisponível no momento (pode estar acordando), repetindo a operação',
        ),
    };
    return {
      orders: new SqlOrderRepository(pool, retry),
      outbox: new SqlOutboxRepository(pool, retry),
      close: () => pool.close(),
    };
  }

  logger.warn('SQL_CONNECTION_STRING não definida: os pedidos ficam só em memória e somem quando o processo parar');
  const database = new InMemoryDatabase();
  return {
    orders: new InMemoryOrderRepository(database),
    outbox: new InMemoryOutboxRepository(database),
    close: async () => undefined,
  };
}

function createPublisher(config: AppConfig, logger: AppLogger): EventPublisher {
  if (config.queueConnectionString) {
    return AzureQueueEventPublisher.fromConnectionString(config.queueConnectionString, config.queueName);
  }
  logger.warn('QUEUE_CONNECTION_STRING não definida: os eventos serão apenas escritos no log');
  return new LogEventPublisher(logger);
}

async function bootstrap(): Promise<void> {
  // Em desenvolvimento as variáveis podem vir de um arquivo .env (na nuvem vêm da plataforma).
  try {
    process.loadEnvFile('.env');
  } catch {
    // sem .env, segue com o que já está no ambiente
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const persistence = await createPersistence(config, logger);
  const publisher = createPublisher(config, logger);

  // O relay é quem implementa a porta OutboxSignal: os casos de uso avisam e ele publica.
  const dispatchOrderEvents = new DispatchOrderEventsHandler(persistence.outbox, publisher);
  const relay = new OutboxRelay(() => dispatchOrderEvents.execute(), config.outboxIntervalMs, logger);

  const app = createApp({
    handlers: {
      createOrder: new CreateOrderHandler(persistence.orders, relay),
      listOrders: new ListOrdersHandler(persistence.orders),
      getOrder: new GetOrderHandler(persistence.orders),
      updateOrder: new UpdateOrderHandler(persistence.orders),
      changeOrderStatus: new ChangeOrderStatusHandler(persistence.orders, relay),
      deleteOrder: new DeleteOrderHandler(persistence.orders),
      listOrderEvents: new ListOrderEventsHandler(persistence.outbox),
      dispatchOrderEvents,
    },
    logger,
    asyncApi: loadAsyncApiDocument(),
    health: { database: config.dbDriver, publisher: publisher.kind },
    internalApiKey: config.internalApiKey,
    corsOrigin: config.corsOrigin,
    publicUrl: config.publicUrl,
  });

  const server: Server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, database: config.dbDriver, publisher: publisher.kind, queue: config.queueName },
      `ms-pedidos no ar: http://localhost:${config.port}/docs`,
    );
  });

  // Varredura única da subida: publica o que ficou pendente se o processo caiu depois do commit.
  relay.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'encerrando: parando o relay e fechando conexões');

    // se algo travar, não fica pendurado para sempre
    setTimeout(() => process.exit(1), 10_000).unref();

    await relay.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await persistence.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error: unknown) => {
  // O logger pode nem ter sido criado ainda (erro de configuração), então vai no console mesmo.
  console.error('Falha ao iniciar o ms-pedidos:', error instanceof Error ? error.message : error);
  process.exit(1);
});
