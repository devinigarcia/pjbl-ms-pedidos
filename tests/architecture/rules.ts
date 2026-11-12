// Regras de arquitetura. Cada função recebe os arquivos analisados pelo scanner e devolve
// a lista de violações em texto (lista vazia = regra respeitada).

import type { Layer, SourceFile } from './dependencyScanner';

/** Pacotes que a camada de aplicação pode usar. Qualquer outro é framework/infra vazando. */
export const APPLICATION_ALLOWED_PACKAGES = ['zod', 'node:crypto'];

/** Driver de banco e SDK de fila: só a infraestrutura pode conhecer. */
export const INFRASTRUCTURE_ONLY_PACKAGES = ['mssql', '@azure/storage-queue'];

/** Coisas de HTTP: só a camada de API pode conhecer. */
export const API_ONLY_PACKAGES = ['express', 'swagger-ui-express', 'helmet', 'cors', 'pino-http'];

function forbiddenLayerImports(files: SourceFile[], from: Layer, forbidden: Layer[]): string[] {
  return files
    .filter((file) => file.layer === from)
    .flatMap((file) =>
      file.imports
        .filter((imp) => imp.kind === 'internal' && forbidden.includes(imp.targetLayer!))
        .map((imp) => `${file.path} importa ${imp.specifier} (camada ${imp.targetLayer})`),
    );
}

/** Domain não depende de nenhuma outra camada e não usa pacote nenhum (nem do Node). */
export function domainIsPure(files: SourceFile[]): string[] {
  const packages = files
    .filter((file) => file.layer === 'domain')
    .flatMap((file) =>
      file.imports
        .filter((imp) => imp.kind === 'external')
        .map((imp) => `${file.path} usa o pacote ${imp.packageName}`),
    );
  return [...forbiddenLayerImports(files, 'domain', ['application', 'infrastructure', 'api', 'root']), ...packages];
}

/** Application só enxerga o Domain; de pacote, só zod e node:crypto. */
export function applicationIsIndependent(files: SourceFile[]): string[] {
  const packages = files
    .filter((file) => file.layer === 'application')
    .flatMap((file) =>
      file.imports
        .filter((imp) => imp.kind === 'external' && !APPLICATION_ALLOWED_PACKAGES.includes(imp.packageName!))
        .map((imp) => `${file.path} usa o pacote ${imp.packageName}`),
    );
  return [...forbiddenLayerImports(files, 'application', ['infrastructure', 'api', 'root']), ...packages];
}

/** Infrastructure não conhece a API. */
export function infrastructureDoesNotDependOnApi(files: SourceFile[]): string[] {
  return forbiddenLayerImports(files, 'infrastructure', ['api', 'root']);
}

/** API não importa Infrastructure (quem junta as duas é só o main.ts). */
export function apiDoesNotDependOnInfrastructure(files: SourceFile[]): string[] {
  return forbiddenLayerImports(files, 'api', ['infrastructure', 'root']);
}

function packagesOnlyIn(files: SourceFile[], packages: string[], allowedLayer: Layer): string[] {
  return files
    .filter((file) => file.layer !== allowedLayer)
    .flatMap((file) =>
      file.imports
        .filter((imp) => imp.kind === 'external' && packages.includes(imp.packageName!))
        .map((imp) => `${file.path} usa ${imp.packageName}, que só pode aparecer em ${allowedLayer}`),
    );
}

export function driversOnlyInInfrastructure(files: SourceFile[]): string[] {
  return packagesOnlyIn(files, INFRASTRUCTURE_ONLY_PACKAGES, 'infrastructure');
}

export function httpFrameworkOnlyInApi(files: SourceFile[]): string[] {
  return packagesOnlyIn(files, API_ONLY_PACKAGES, 'api');
}

/** Vertical slice: uma feature não importa código de outra (o que é comum fica fora de features/). */
export function featuresAreIsolated(files: SourceFile[]): string[] {
  return files
    .filter((file) => file.feature)
    .flatMap((file) =>
      file.imports
        .filter((imp) => imp.kind === 'internal' && imp.targetFeature && imp.targetFeature !== file.feature)
        .map((imp) => `${file.path} (feature ${file.feature}) importa a feature ${imp.targetFeature}`),
    );
}

function featureNames(files: SourceFile[], layer: Layer): string[] {
  return [...new Set(files.filter((file) => file.layer === layer && file.feature).map((file) => file.feature!))].sort();
}

/** Toda feature da Application tem o seu adaptador HTTP em api/features/<F>/<F>Endpoint.ts (e vice-versa). */
export function everyFeatureHasEndpoint(files: SourceFile[]): string[] {
  const paths = new Set(files.map((file) => file.path));
  const missingEndpoints = featureNames(files, 'application')
    .filter((feature) => !paths.has(`api/features/${feature}/${feature}Endpoint.ts`))
    .map((feature) => `falta api/features/${feature}/${feature}Endpoint.ts`);
  const orphanEndpoints = featureNames(files, 'api')
    .filter((feature) => !paths.has(`application/features/${feature}/${feature}.ts`))
    .map((feature) => `api/features/${feature} não tem caso de uso em application/features/${feature}/${feature}.ts`);
  return [...missingEndpoints, ...orphanEndpoints];
}

/** Cada application/features/<F>/<F>.ts exporta a classe <F>Handler. */
export function everyFeatureExportsHandler(files: SourceFile[]): string[] {
  return featureNames(files, 'application').flatMap((feature) => {
    const file = files.find((candidate) => candidate.path === `application/features/${feature}/${feature}.ts`);
    if (!file) {
      return [`falta application/features/${feature}/${feature}.ts`];
    }
    const exportsHandler = new RegExp(`export\\s+class\\s+${feature}Handler\\b`).test(file.source);
    return exportsHandler ? [] : [`${file.path} não exporta a classe ${feature}Handler`];
  });
}

/** Fora das quatro camadas só existe o main.ts (composition root). */
export function onlyMainOutsideLayers(files: SourceFile[]): string[] {
  return files
    .filter((file) => file.layer === 'root' && file.path !== 'main.ts')
    .map((file) => `${file.path} está fora das camadas (só o main.ts pode ficar na raiz de src)`);
}
