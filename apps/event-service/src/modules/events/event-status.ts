// apps/event-service/src/modules/events/event-status.ts
//
// Máquina de estados para o ciclo de vida de um evento.
// Define o grafo de transições válidas — impossível pular etapas.
//
// Por que máquina de estados?
//   Sem ela, qualquer status pode ser atribuído a qualquer momento.
//   Com ela, um evento 'cancelled' não pode voltar para 'published' —
//   invariante de negócio aplicada no código, não só na documentação.

export const EVENT_STATUS = {
  DRAFT:     'draft',
  PUBLISHED: 'published',
  ON_SALE:   'on_sale',
  SOLD_OUT:  'sold_out',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
} as const;

export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];

// Grafo de transições permitidas (directed graph)
const TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft:     ['published', 'cancelled'],
  published: ['on_sale', 'cancelled'],
  on_sale:   ['sold_out', 'cancelled', 'completed'],
  sold_out:  ['on_sale', 'cancelled', 'completed'],  // pode ter cancelamentos → libera assentos
  cancelled: [],  // estado final — sem saída
  completed: [],  // estado final — sem saída
};

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão: classe utilitária de domínio sem estado
export class EventStatusMachine {
  static canTransition(from: EventStatus, to: EventStatus): boolean {
    // eslint-disable-next-line security/detect-object-injection -- TRANSITIONS é um objeto de lookup com chaves fixas tipadas
    return TRANSITIONS[from].includes(to);
  }

  /**
   * Valida a transição e lança erro se inválida.
   * Chamado no service antes de atualizar o banco.
   */
  static assertTransition(from: EventStatus, to: EventStatus): void {
    if (!this.canTransition(from, to)) {
      // eslint-disable-next-line security/detect-object-injection -- chave tipada como EventStatus (valor fixo do enum)
      const allowed = TRANSITIONS[from].join(', ');
      throw new Error(
        `Transição inválida: ${from} → ${to}. Permitidas a partir de '${from}': [${allowed}]`,
      );
    }
  }

  /**
   * Verifica se o evento aceita novas reservas.
   */
  static isOnSale(status: EventStatus): boolean {
    return status === EVENT_STATUS.ON_SALE;
  }
}
