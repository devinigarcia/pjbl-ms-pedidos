import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxRelay, type RelayRunResult } from '../../../src/infrastructure/outbox/OutboxRelay';

const INTERVAL = 3000;
const EMPTY: RelayRunResult = { published: 0, failed: 0, pending: 0 };
const PUBLISHED: RelayRunResult = { published: 1, failed: 0, pending: 0 };
const FAILED: RelayRunResult = { published: 0, failed: 1, pending: 1 };

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Função de dispatch de mentira: cada chamada devolve o próximo resultado da fila (ou "vazio"). */
function fakeDispatch(...results: Array<RelayRunResult | Error>) {
  const queue = [...results];
  return vi.fn(async (): Promise<RelayRunResult> => {
    const next = queue.shift() ?? EMPTY;
    if (next instanceof Error) throw next;
    return next;
  });
}

/** Dispatch que fica "em andamento" até o teste liberar. Também conta quantas rodadas rodaram juntas. */
function gatedDispatch(result: RelayRunResult = PUBLISHED) {
  const releases: Array<() => void> = [];
  let running = 0;
  let maxRunning = 0;

  const dispatch = vi.fn(async (): Promise<RelayRunResult> => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise<void>((resolve) => releases.push(resolve));
    running -= 1;
    return result;
  });

  return {
    dispatch,
    releaseNext: () => releases.shift()?.(),
    maxRunning: () => maxRunning,
  };
}

/** Deixa as promises pendentes andarem, sem avançar o relógio. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('OutboxRelay (orientado a sinal)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('na subida faz uma varredura única e, com o outbox vazio, fica ocioso (nenhum timer)', async () => {
    const dispatch = fakeDispatch(EMPTY);
    const relay = new OutboxRelay(dispatch, INTERVAL, silentLogger);

    relay.start();
    await relay.whenIdle();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // pode passar o tempo que for: sem sinal, o banco não é consultado de novo
    await vi.advanceTimersByTimeAsync(INTERVAL * 100);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('notify() publica na hora, sem esperar o intervalo', async () => {
    const dispatch = fakeDispatch(EMPTY, PUBLISHED);
    const relay = new OutboxRelay(dispatch, INTERVAL, silentLogger);
    relay.start();
    await relay.whenIdle();

    relay.notify();
    expect(dispatch).toHaveBeenCalledTimes(2); // disparou de forma síncrona, relógio parado
    await relay.whenIdle();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('se sobrar mensagem pendente (falha ao publicar), agenda nova tentativa para daqui a um intervalo', async () => {
    const dispatch = fakeDispatch(FAILED, FAILED, PUBLISHED);
    const relay = new OutboxRelay(dispatch, INTERVAL, silentLogger);

    relay.start();
    await relay.whenIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(dispatch).toHaveBeenCalledTimes(1); // ainda não deu o tempo

    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(2); // segunda tentativa, falhou de novo
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(dispatch).toHaveBeenCalledTimes(3); // agora publicou
    await relay.whenIdle();
    expect(vi.getTimerCount()).toBe(0); // e voltou a ficar ocioso
  });

  it('erro na rodada (banco fora, por exemplo) também agenda nova tentativa', async () => {
    const dispatch = fakeDispatch(new Error('banco indisponível'), PUBLISHED);
    const relay = new OutboxRelay(dispatch, INTERVAL, silentLogger);

    relay.start();
    await relay.whenIdle();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    await relay.whenIdle();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('notify() durante uma rodada não perde o evento: roda mais uma logo em seguida, nunca duas juntas', async () => {
    const gated = gatedDispatch();
    const relay = new OutboxRelay(gated.dispatch, INTERVAL, silentLogger);

    relay.start(); // rodada 1 fica em andamento
    await flush();
    relay.notify(); // chegou evento novo no meio da rodada
    relay.notify(); // vários avisos viram uma rodada extra só
    expect(gated.dispatch).toHaveBeenCalledTimes(1);

    gated.releaseNext(); // termina a rodada 1
    await flush();
    expect(gated.dispatch).toHaveBeenCalledTimes(2); // rodada 2 começou sem esperar o intervalo

    gated.releaseNext();
    await relay.whenIdle();
    expect(gated.dispatch).toHaveBeenCalledTimes(2);
    expect(gated.maxRunning()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('notify() com tentativa agendada cancela o timer e roda agora', async () => {
    const dispatch = fakeDispatch(FAILED, PUBLISHED);
    const relay = new OutboxRelay(dispatch, INTERVAL, silentLogger);
    relay.start();
    await relay.whenIdle();
    expect(vi.getTimerCount()).toBe(1);

    relay.notify();
    await relay.whenIdle();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() cancela a tentativa agendada e depois disso notify() não faz nada', async () => {
    const dispatch = fakeDispatch(FAILED);
    const relay = new OutboxRelay(dispatch, INTERVAL, silentLogger);
    relay.start();
    await relay.whenIdle();
    expect(vi.getTimerCount()).toBe(1);

    await relay.stop();
    expect(vi.getTimerCount()).toBe(0);

    relay.notify();
    await vi.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('stop() espera a rodada em andamento terminar e não agenda mais nada', async () => {
    const gated = gatedDispatch(FAILED);
    const relay = new OutboxRelay(gated.dispatch, INTERVAL, silentLogger);
    relay.start();
    await flush();

    let stopped = false;
    const stopping = relay.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false); // ainda tem publicação em andamento

    gated.releaseNext();
    await stopping;
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // sobrou pendência, mas o serviço está desligando
  });

  it('antes do start() o notify() é ignorado, e start() repetido não dispara outra varredura', async () => {
    const dispatch = fakeDispatch();
    const relay = new OutboxRelay(dispatch, INTERVAL, silentLogger);

    relay.notify();
    expect(dispatch).not.toHaveBeenCalled();

    relay.start();
    relay.start();
    await relay.whenIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
