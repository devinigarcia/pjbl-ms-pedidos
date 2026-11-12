import { ConflictError, DomainError } from '../errors';
import { roundMoney } from '../shared/money';
import type { OrderDomainEvent, OrderEventData, OrderEventType } from './OrderEvents';
import { EMAIL_PATTERN, ORDER_RULES } from './OrderRules';
import { allowedTransitions, canTransition, type OrderStatus } from './OrderStatus';

export interface OrderItem {
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
}

/** Estado completo do pedido, do jeito que é guardado no banco. */
export interface OrderProps {
  id: string;
  customerName: string;
  customerEmail: string;
  status: OrderStatus;
  items: OrderItem[];
  total: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOrderInput {
  id: string;
  customerName: string;
  customerEmail: string;
  notes?: string | null;
  items: OrderItem[];
}

export interface CustomerDataInput {
  customerName: string;
  customerEmail: string;
  notes?: string | null;
}

export function itemSubtotal(item: OrderItem): number {
  return roundMoney(item.unitPrice * item.quantity);
}

/**
 * Agregado Pedido. Todas as regras de negócio ficam aqui: quem chama (casos de uso)
 * só pede a operação e depois persiste o resultado junto com os eventos de `pullEvents()`.
 */
export class Order {
  private props: OrderProps;
  private events: OrderDomainEvent[] = [];

  private constructor(props: OrderProps) {
    this.props = props;
  }

  /** Cria um pedido novo (sempre PENDENTE) e registra o evento `order.created`. */
  static create(input: NewOrderInput, now: Date): Order {
    const customer = normalizeCustomer(input);
    const items = normalizeItems(input.items);
    const total = roundMoney(items.reduce((sum, item) => sum + itemSubtotal(item), 0));

    const order = new Order({
      id: input.id.toLowerCase(),
      ...customer,
      status: 'PENDENTE',
      items,
      total,
      createdAt: now,
      updatedAt: now,
    });
    order.record('order.created', now);
    return order;
  }

  /** Remonta um pedido que veio do banco. Não valida de novo nem gera evento. */
  static restore(props: OrderProps): Order {
    return new Order({ ...props, items: props.items.map((item) => ({ ...item })) });
  }

  get id(): string {
    return this.props.id;
  }

  get customerName(): string {
    return this.props.customerName;
  }

  get customerEmail(): string {
    return this.props.customerEmail;
  }

  get status(): OrderStatus {
    return this.props.status;
  }

  get items(): OrderItem[] {
    return this.props.items.map((item) => ({ ...item }));
  }

  get total(): number {
    return this.props.total;
  }

  get notes(): string | null {
    return this.props.notes;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  /** Soma das quantidades (não é a quantidade de linhas). */
  get itemCount(): number {
    return this.props.items.reduce((sum, item) => sum + item.quantity, 0);
  }

  get allowedTransitions(): OrderStatus[] {
    return allowedTransitions(this.props.status);
  }

  /** Dados do cliente só podem mudar enquanto o pedido está PENDENTE. Itens nunca mudam. */
  updateCustomer(input: CustomerDataInput, now: Date): void {
    if (this.props.status !== 'PENDENTE') {
      throw new ConflictError(
        'ORDER_NOT_EDITABLE',
        `Só é possível editar pedidos com status PENDENTE (status atual: ${this.props.status}).`,
      );
    }
    const customer = normalizeCustomer(input);
    this.props = { ...this.props, ...customer, updatedAt: now };
  }

  /** Aplica uma transição da máquina de estados. Cancelar gera o evento `order.cancelled`. */
  changeStatus(next: OrderStatus, now: Date): void {
    const current = this.props.status;
    if (!canTransition(current, next)) {
      const allowed = allowedTransitions(current);
      const hint = allowed.length > 0 ? `Transições permitidas: ${allowed.join(', ')}.` : `${current} é um status final.`;
      throw new ConflictError('INVALID_STATUS_TRANSITION', `Não é possível mudar o pedido de ${current} para ${next}. ${hint}`);
    }
    this.props = { ...this.props, status: next, updatedAt: now };
    if (next === 'CANCELADO') {
      this.record('order.cancelled', now);
    }
  }

  /** Só pedido CANCELADO pode ser excluído (os outros fazem parte do histórico de vendas). */
  assertCanBeDeleted(): void {
    if (this.props.status !== 'CANCELADO') {
      throw new ConflictError(
        'ORDER_NOT_DELETABLE',
        `Só é possível excluir pedidos com status CANCELADO (status atual: ${this.props.status}).`,
      );
    }
  }

  /** Devolve os eventos gerados desde a última chamada e esvazia a lista. */
  pullEvents(): OrderDomainEvent[] {
    const pulled = this.events;
    this.events = [];
    return pulled;
  }

  /** Cópia do estado, para os repositórios persistirem. */
  toProps(): OrderProps {
    return { ...this.props, items: this.items };
  }

  private record(type: OrderEventType, occurredAt: Date): void {
    this.events.push({ type, occurredAt, data: this.snapshot() });
  }

  private snapshot(): OrderEventData {
    return {
      orderId: this.props.id,
      customerName: this.props.customerName,
      customerEmail: this.props.customerEmail,
      status: this.props.status,
      total: this.props.total,
      items: this.props.items.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    };
  }
}

function normalizeCustomer(input: CustomerDataInput): Pick<OrderProps, 'customerName' | 'customerEmail' | 'notes'> {
  const customerName = String(input.customerName ?? '').trim();
  if (customerName.length < ORDER_RULES.customerNameMin || customerName.length > ORDER_RULES.customerNameMax) {
    throw new DomainError(
      'INVALID_CUSTOMER_NAME',
      `O nome do cliente deve ter entre ${ORDER_RULES.customerNameMin} e ${ORDER_RULES.customerNameMax} caracteres.`,
    );
  }

  const customerEmail = String(input.customerEmail ?? '')
    .trim()
    .toLowerCase();
  if (customerEmail.length > ORDER_RULES.customerEmailMax || !EMAIL_PATTERN.test(customerEmail)) {
    throw new DomainError('INVALID_CUSTOMER_EMAIL', 'O e-mail do cliente é inválido.');
  }

  const trimmedNotes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (trimmedNotes.length > ORDER_RULES.notesMax) {
    throw new DomainError('INVALID_NOTES', `A observação deve ter no máximo ${ORDER_RULES.notesMax} caracteres.`);
  }

  return { customerName, customerEmail, notes: trimmedNotes === '' ? null : trimmedNotes };
}

function normalizeItems(input: OrderItem[]): OrderItem[] {
  if (!Array.isArray(input) || input.length < ORDER_RULES.minItems || input.length > ORDER_RULES.maxItems) {
    throw new DomainError(
      'INVALID_ITEMS',
      `O pedido deve ter de ${ORDER_RULES.minItems} a ${ORDER_RULES.maxItems} itens.`,
    );
  }

  const seen = new Set<string>();
  return input.map((raw, index) => {
    const position = index + 1;
    const productId = String(raw.productId ?? '').trim();
    const productName = String(raw.productName ?? '').trim();

    if (productId === '' || productId.length > ORDER_RULES.productIdMax) {
      throw new DomainError('INVALID_ITEM', `Item ${position}: o identificador do produto é obrigatório.`);
    }
    if (productName === '' || productName.length > ORDER_RULES.productNameMax) {
      throw new DomainError('INVALID_ITEM', `Item ${position}: o nome do produto é obrigatório.`);
    }
    if (seen.has(productId)) {
      throw new DomainError(
        'DUPLICATED_ITEM',
        `O produto ${productId} aparece mais de uma vez no pedido. Some as quantidades em um único item.`,
        [{ field: `items.${index}.productId`, message: 'Produto repetido no pedido.' }],
      );
    }
    seen.add(productId);

    if (
      !Number.isInteger(raw.quantity) ||
      raw.quantity < ORDER_RULES.minQuantity ||
      raw.quantity > ORDER_RULES.maxQuantity
    ) {
      throw new DomainError(
        'INVALID_QUANTITY',
        `Item ${position}: a quantidade deve ser um número inteiro entre ${ORDER_RULES.minQuantity} e ${ORDER_RULES.maxQuantity}.`,
      );
    }

    const unitPrice = typeof raw.unitPrice === 'number' && Number.isFinite(raw.unitPrice) ? roundMoney(raw.unitPrice) : NaN;
    if (!(unitPrice >= ORDER_RULES.minUnitPrice) || unitPrice > ORDER_RULES.maxUnitPrice) {
      throw new DomainError(
        'INVALID_UNIT_PRICE',
        `Item ${position}: o preço unitário deve ser maior que zero (e no máximo ${ORDER_RULES.maxUnitPrice}).`,
      );
    }

    return { productId, productName, unitPrice, quantity: raw.quantity };
  });
}
