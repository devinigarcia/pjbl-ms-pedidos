import { describe, expect, it } from 'vitest';
import { ConflictError, DomainError } from '../../../src/domain/errors';
import { itemSubtotal, Order } from '../../../src/domain/order/Order';
import { coffee, filter, newOrderInput, PRODUCT_COFFEE } from '../../support/testKit';

const NOW = new Date('2025-06-10T12:00:00.000Z');
const LATER = new Date('2025-06-10T13:00:00.000Z');

function expectDomainError(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
}

describe('Order.create', () => {
  it('cria o pedido PENDENTE, normaliza os dados do cliente e calcula total e itemCount', () => {
    const order = Order.create(
      newOrderInput({ customerName: '  Ana Souza ', customerEmail: ' Ana@Exemplo.COM ', notes: '  ' }),
      NOW,
    );

    expect(order.status).toBe('PENDENTE');
    expect(order.customerName).toBe('Ana Souza');
    expect(order.customerEmail).toBe('ana@exemplo.com');
    expect(order.notes).toBeNull();
    expect(order.total).toBe(56.3); // 2 x 24.90 + 1 x 6.50
    expect(order.itemCount).toBe(3);
    expect(order.createdAt).toEqual(NOW);
    expect(order.updatedAt).toEqual(NOW);
    expect(order.allowedTransitions).toEqual(['PAGO', 'CANCELADO']);
  });

  it('arredonda preço, subtotal e total para 2 casas', () => {
    const order = Order.create(
      newOrderInput({
        items: [coffee({ unitPrice: 0.1, quantity: 3 }), filter({ unitPrice: 19.999, quantity: 1 })],
      }),
      NOW,
    );

    expect(order.items.map((item) => item.unitPrice)).toEqual([0.1, 20]);
    expect(itemSubtotal(order.items[0]!)).toBe(0.3); // sem arredondar daria 0.30000000000000004
    expect(order.total).toBe(20.3);
  });

  it('gera o evento order.created com a foto do pedido, e pullEvents esvazia a lista', () => {
    const order = Order.create(newOrderInput(), NOW);

    const events = order.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'order.created',
      occurredAt: NOW,
      data: {
        orderId: order.id,
        customerName: 'Ana Souza',
        customerEmail: 'ana@exemplo.com',
        status: 'PENDENTE',
        total: 56.3,
        items: [
          { productId: PRODUCT_COFFEE, productName: 'Café torrado 500g', quantity: 2, unitPrice: 24.9 },
          { productId: filter().productId, productName: 'Filtro de papel 103', quantity: 1, unitPrice: 6.5 },
        ],
      },
    });
    expect(order.pullEvents()).toEqual([]);
  });

  it('recusa produto repetido (DUPLICATED_ITEM é regra de negócio, não conflito)', () => {
    const action = () => Order.create(newOrderInput({ items: [coffee(), coffee({ quantity: 1 })] }), NOW);

    expectDomainError(action, 'DUPLICATED_ITEM');
    expect(() => action()).not.toThrow(ConflictError);
  });

  it('exige de 1 a 20 itens', () => {
    const manyItems = (count: number) =>
      Array.from({ length: count }, (_, index) => coffee({ productId: `produto-${index}` }));

    expectDomainError(() => Order.create(newOrderInput({ items: [] }), NOW), 'INVALID_ITEMS');
    expectDomainError(() => Order.create(newOrderInput({ items: manyItems(21) }), NOW), 'INVALID_ITEMS');
    expect(Order.create(newOrderInput({ items: manyItems(20) }), NOW).items).toHaveLength(20);
  });

  it.each([0, -1, 1000, 1.5, Number.NaN])('recusa quantidade %s (precisa ser inteiro de 1 a 999)', (quantity) => {
    expectDomainError(() => Order.create(newOrderInput({ items: [coffee({ quantity })] }), NOW), 'INVALID_QUANTITY');
  });

  it('aceita os limites de quantidade (1 e 999)', () => {
    const order = Order.create(newOrderInput({ items: [coffee({ quantity: 1 }), filter({ quantity: 999 })] }), NOW);
    expect(order.itemCount).toBe(1000);
  });

  it.each([0, -5, 0.004, Number.POSITIVE_INFINITY, 100_000.01])('recusa preço unitário %s', (unitPrice) => {
    expectDomainError(() => Order.create(newOrderInput({ items: [coffee({ unitPrice })] }), NOW), 'INVALID_UNIT_PRICE');
  });

  it.each(['', 'ana', 'ana@', 'ana@exemplo', 'ana souza@exemplo.com'])('recusa o e-mail "%s"', (customerEmail) => {
    expectDomainError(() => Order.create(newOrderInput({ customerEmail }), NOW), 'INVALID_CUSTOMER_EMAIL');
  });

  it('recusa nome curto demais e observação longa demais', () => {
    expectDomainError(() => Order.create(newOrderInput({ customerName: 'A' }), NOW), 'INVALID_CUSTOMER_NAME');
    expectDomainError(() => Order.create(newOrderInput({ customerName: 'x'.repeat(121) }), NOW), 'INVALID_CUSTOMER_NAME');
    expectDomainError(() => Order.create(newOrderInput({ notes: 'x'.repeat(501) }), NOW), 'INVALID_NOTES');
  });
});

describe('Order.restore', () => {
  it('remonta o pedido sem gerar evento e sem compartilhar a lista de itens', () => {
    const props = Order.create(newOrderInput(), NOW).toProps();
    const restored = Order.restore(props);

    props.items[0]!.quantity = 500; // mexer na origem não pode afetar o agregado
    expect(restored.pullEvents()).toEqual([]);
    expect(restored.itemCount).toBe(3);
    expect(restored.total).toBe(56.3);
  });
});

describe('Order.updateCustomer', () => {
  it('altera os dados do cliente de um pedido PENDENTE, sem gerar evento', () => {
    const order = Order.create(newOrderInput(), NOW);
    order.pullEvents();

    order.updateCustomer({ customerName: 'Ana Lima', customerEmail: 'ANA.LIMA@exemplo.com', notes: 'Portaria 2' }, LATER);

    expect(order.customerName).toBe('Ana Lima');
    expect(order.customerEmail).toBe('ana.lima@exemplo.com');
    expect(order.notes).toBe('Portaria 2');
    expect(order.updatedAt).toEqual(LATER);
    expect(order.createdAt).toEqual(NOW);
    expect(order.total).toBe(56.3); // itens não mudam
    expect(order.pullEvents()).toEqual([]);
  });

  it('recusa a edição quando o pedido não está mais PENDENTE (ORDER_NOT_EDITABLE)', () => {
    const order = Order.create(newOrderInput(), NOW);
    order.changeStatus('PAGO', LATER);
    const edit = () => order.updateCustomer({ customerName: 'Outro Nome', customerEmail: 'x@y.com' }, LATER);

    expectDomainError(edit, 'ORDER_NOT_EDITABLE');
    expect(edit).toThrow(ConflictError);
    expect(order.customerName).toBe('Ana Souza');
  });

  it('valida os novos dados com as mesmas regras da criação', () => {
    const order = Order.create(newOrderInput(), NOW);
    expectDomainError(
      () => order.updateCustomer({ customerName: 'Ana', customerEmail: 'email-invalido' }, LATER),
      'INVALID_CUSTOMER_EMAIL',
    );
  });
});

describe('Order.assertCanBeDeleted', () => {
  it('só deixa excluir pedido CANCELADO', () => {
    const order = Order.create(newOrderInput(), NOW);
    expectDomainError(() => order.assertCanBeDeleted(), 'ORDER_NOT_DELETABLE');

    order.changeStatus('CANCELADO', LATER);
    expect(() => order.assertCanBeDeleted()).not.toThrow();
  });
});
