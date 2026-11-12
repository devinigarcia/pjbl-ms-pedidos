import { describe, expect, it } from 'vitest';
import { parseSource, scanSources, type SourceFile } from './dependencyScanner';
import {
  apiDoesNotDependOnInfrastructure,
  applicationIsIndependent,
  domainIsPure,
  driversOnlyInInfrastructure,
  everyFeatureExportsHandler,
  everyFeatureHasEndpoint,
  featuresAreIsolated,
  httpFrameworkOnlyInApi,
  infrastructureDoesNotDependOnApi,
  onlyMainOutsideLayers,
} from './rules';

const files = scanSources();

const EXPECTED_FEATURES = [
  'ChangeOrderStatus',
  'CreateOrder',
  'DeleteOrder',
  'DispatchOrderEvents',
  'GetOrder',
  'ListOrderEvents',
  'ListOrders',
  'UpdateOrder',
];

describe('Arquitetura — Clean Architecture (camadas)', () => {
  it('o scanner encontrou as quatro camadas e o main.ts', () => {
    const layers = new Set(files.map((file) => file.layer));
    expect([...layers].sort()).toEqual(['api', 'application', 'domain', 'infrastructure', 'root']);
    expect(files.length).toBeGreaterThan(30);
  });

  it('Domain não depende de nenhuma camada e não usa nenhum pacote', () => {
    expect(domainIsPure(files)).toEqual([]);
  });

  it('Application não depende de Infrastructure/API e só usa zod e node:crypto', () => {
    expect(applicationIsIndependent(files)).toEqual([]);
  });

  it('Infrastructure não depende da API', () => {
    expect(infrastructureDoesNotDependOnApi(files)).toEqual([]);
  });

  it('API não importa Infrastructure (só o main.ts junta as duas)', () => {
    expect(apiDoesNotDependOnInfrastructure(files)).toEqual([]);
  });

  it('mssql e @azure/storage-queue só aparecem na Infrastructure', () => {
    expect(driversOnlyInInfrastructure(files)).toEqual([]);
  });

  it('express e companhia só aparecem na API', () => {
    expect(httpFrameworkOnlyInApi(files)).toEqual([]);
  });

  it('fora das camadas só existe o main.ts', () => {
    expect(onlyMainOutsideLayers(files)).toEqual([]);
  });
});

describe('Arquitetura — Vertical Slice (features)', () => {
  it('as 8 features existem na Application', () => {
    const features = [...new Set(files.filter((f) => f.layer === 'application' && f.feature).map((f) => f.feature))];
    expect(features.sort()).toEqual(EXPECTED_FEATURES);
  });

  it('uma feature não importa outra feature', () => {
    expect(featuresAreIsolated(files)).toEqual([]);
  });

  it('toda feature da Application tem api/features/<F>/<F>Endpoint.ts', () => {
    expect(everyFeatureHasEndpoint(files)).toEqual([]);
  });

  it('cada <F>.ts exporta a classe <F>Handler', () => {
    expect(everyFeatureExportsHandler(files)).toEqual([]);
  });
});

// Um teste de arquitetura que nunca falha não protege nada. Aqui as mesmas regras recebem
// arquivos "de mentira" com uma violação cada, para provar que elas pegam o problema.
describe('Arquitetura — as regras detectam violações', () => {
  const fake = (path: string, source: string): SourceFile => parseSource(path, source);

  it('Domain importando pacote ou outra camada', () => {
    expect(domainIsPure([fake('domain/order/Order.ts', `import { z } from 'zod';`)])).toHaveLength(1);
    expect(domainIsPure([fake('domain/order/Order.ts', `import { randomUUID } from 'node:crypto';`)])).toHaveLength(1);
    expect(
      domainIsPure([fake('domain/order/Order.ts', `import type { OrderRepository } from '../../application/ports/OrderRepository';`)]),
    ).toHaveLength(1);
  });

  it('Application importando Infrastructure, API ou um framework', () => {
    const source = [
      `import { SqlOrderRepository } from '../../../infrastructure/sql/SqlOrderRepository';`,
      `import { createApp } from '../../../api/app';`,
      `import express from 'express';`,
      `import { z } from 'zod';`,
    ].join('\n');
    expect(applicationIsIndependent([fake('application/features/CreateOrder/CreateOrder.ts', source)])).toHaveLength(3);
  });

  it('Infrastructure importando API e API importando Infrastructure', () => {
    expect(
      infrastructureDoesNotDependOnApi([fake('infrastructure/outbox/OutboxRelay.ts', `import { createApp } from '../../api/app';`)]),
    ).toHaveLength(1);
    expect(
      apiDoesNotDependOnInfrastructure([fake('api/app.ts', `import { loadConfig } from '../infrastructure/config';`)]),
    ).toHaveLength(1);
  });

  it('driver de banco ou SDK de fila fora da Infrastructure (inclusive com require e import dinâmico)', () => {
    expect(driversOnlyInInfrastructure([fake('api/app.ts', `import sql from 'mssql';`)])).toHaveLength(1);
    expect(
      driversOnlyInInfrastructure([fake('application/findOrder.ts', `const { QueueClient } = require('@azure/storage-queue');`)]),
    ).toHaveLength(1);
    expect(driversOnlyInInfrastructure([fake('main.ts', `const sql = await import('mssql');`)])).toHaveLength(1);
    expect(driversOnlyInInfrastructure([fake('infrastructure/sql/connectSql.ts', `import sql from 'mssql';`)])).toEqual([]);
  });

  it('feature importando outra feature', () => {
    const source = `import { GetOrderHandler } from '../GetOrder/GetOrder';`;
    expect(featuresAreIsolated([fake('application/features/UpdateOrder/UpdateOrder.ts', source)])).toHaveLength(1);
    // o endpoint importar o caso de uso da MESMA feature é permitido
    const endpoint = `import type { GetOrderHandler } from '../../../application/features/GetOrder/GetOrder';`;
    expect(featuresAreIsolated([fake('api/features/GetOrder/GetOrderEndpoint.ts', endpoint)])).toEqual([]);
  });

  it('feature sem endpoint, sem handler ou arquivo fora das camadas', () => {
    const feature = fake('application/features/ArchiveOrder/ArchiveOrder.ts', `export class Archiver {}`);
    expect(everyFeatureHasEndpoint([feature])).toEqual(['falta api/features/ArchiveOrder/ArchiveOrderEndpoint.ts']);
    expect(everyFeatureExportsHandler([feature])).toHaveLength(1);
    expect(onlyMainOutsideLayers([fake('utils.ts', ''), fake('main.ts', '')])).toHaveLength(1);
  });

  it('import comentado não conta como dependência', () => {
    const source = `// import sql from 'mssql';\n/* import express from 'express'; */\nexport const x = 1;`;
    expect(parseSource('domain/x.ts', source).imports).toEqual([]);
  });
});
