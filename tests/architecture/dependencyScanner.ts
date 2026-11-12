// Scanner de dependências "caseiro" usado pelos testes de arquitetura.
// Lê os arquivos .ts de src/, extrai os imports por expressão regular e diz, para cada um,
// de que camada e de que feature ele é. Não usa nenhuma biblioteca: é só fs + regex.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Layer = 'domain' | 'application' | 'infrastructure' | 'api' | 'root';

const LAYERS: readonly Layer[] = ['domain', 'application', 'infrastructure', 'api'];

export interface ImportInfo {
  /** Texto do import, como está no código. */
  specifier: string;
  kind: 'internal' | 'external';
  /** Só para imports internos: caminho do arquivo importado, relativo a src (sem extensão). */
  targetPath?: string;
  targetLayer?: Layer;
  targetFeature?: string;
  /** Só para imports externos: nome do pacote (`zod`, `@azure/storage-queue`, `node:crypto`). */
  packageName?: string;
}

export interface SourceFile {
  /** Caminho relativo a src, sempre com `/`. */
  path: string;
  layer: Layer;
  /** Nome da pasta em `features/<Nome>/`, quando o arquivo está dentro de uma. */
  feature?: string;
  imports: ImportInfo[];
  source: string;
}

export function layerOf(relativePath: string): Layer {
  const first = relativePath.split('/')[0] ?? '';
  return (LAYERS as readonly string[]).includes(first) ? (first as Layer) : 'root';
}

export function featureOf(relativePath: string): string | undefined {
  return /(?:^|\/)features\/([^/]+)\//.exec(relativePath)?.[1];
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

// Tira comentários para um import que está só comentado não contar como dependência.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  // import x from '...'; import type { X } from '...'; export { X } from '...'; export * from '...'
  /\b(?:import|export)\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // import '...';
  /\bimport\s*['"]([^'"]+)['"]/g,
  // import('...') e require('...')
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function extractSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      found.add(match[1]!);
    }
  }
  return [...found];
}

/** Analisa um arquivo a partir do conteúdo. Separado da leitura do disco para poder testar as regras com exemplos. */
export function parseSource(relativePath: string, source: string): SourceFile {
  const filePath = relativePath.replace(/\\/g, '/');

  const imports = extractSpecifiers(source).map((specifier): ImportInfo => {
    if (!specifier.startsWith('.')) {
      return { specifier, kind: 'external', packageName: packageNameOf(specifier) };
    }
    const targetPath = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier));
    return {
      specifier,
      kind: 'internal',
      targetPath,
      targetLayer: layerOf(targetPath),
      targetFeature: featureOf(`${targetPath}.ts`),
    };
  });

  return { path: filePath, layer: layerOf(filePath), feature: featureOf(filePath), imports, source };
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

export const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');

/** Lê e analisa todos os .ts de src/. */
export function scanSources(srcDir: string = SRC_DIR): SourceFile[] {
  return listTypeScriptFiles(srcDir)
    .map((fullPath) => parseSource(path.relative(srcDir, fullPath), readFileSync(fullPath, 'utf8')))
    .sort((a, b) => a.path.localeCompare(b.path));
}
