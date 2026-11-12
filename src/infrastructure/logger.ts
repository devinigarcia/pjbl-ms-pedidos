import pino, { type Logger } from 'pino';

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    base: { service: 'ms-pedidos' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // garantia extra: se algum dia alguém logar os cabeçalhos, a chave interna não aparece
    redact: { paths: ['req.headers["x-api-key"]', 'req.headers.authorization'], censor: '[oculto]' },
  });
}
