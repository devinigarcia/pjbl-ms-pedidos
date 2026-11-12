import { randomUUID } from 'node:crypto';
import { InMemoryDatabase } from '../../../src/infrastructure/memory/InMemoryDatabase';
import { InMemoryOrderRepository } from '../../../src/infrastructure/memory/InMemoryOrderRepository';
import { InMemoryOutboxRepository } from '../../../src/infrastructure/memory/InMemoryOutboxRepository';
import { describeRepositoryContract } from '../../support/repositoryContract';

// O repositório em memória precisa se comportar igual ao do SQL. Os mesmos testes rodam
// contra o Azure SQL em tests/integration/sqlRepositories.test.ts.
describeRepositoryContract('em memória', () => {
  const database = new InMemoryDatabase();
  return {
    orders: new InMemoryOrderRepository(database),
    outbox: new InMemoryOutboxRepository(database),
    marker: `it${randomUUID().slice(0, 8)}`,
  };
});
