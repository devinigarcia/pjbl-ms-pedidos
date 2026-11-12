import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export interface AsyncApiDocument {
  /** Conteúdo original de docs/asyncapi.yaml. */
  yaml: string;
  /** O mesmo documento convertido para objeto (servido como JSON). */
  json: Record<string, unknown>;
}

// O arquivo fica em docs/ na raiz do projeto. Tanto src/api quanto dist/api estão dois níveis abaixo
// da raiz, então o mesmo caminho relativo serve para `npm run dev`, para os testes e para a imagem Docker.
function defaultAsyncApiPath(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'docs', 'asyncapi.yaml'),
    path.resolve(process.cwd(), 'docs', 'asyncapi.yaml'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Lê a especificação dos eventos uma vez, na subida do serviço. */
export function loadAsyncApiDocument(filePath: string = defaultAsyncApiPath()): AsyncApiDocument {
  const yaml = readFileSync(filePath, 'utf8');
  const json = parse(yaml) as Record<string, unknown>;
  return { yaml, json };
}
