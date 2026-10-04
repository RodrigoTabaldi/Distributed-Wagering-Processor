// Biblioteca usada para calcular valores decimais sem converter dinheiro para number.
import { Decimal } from 'decimal.js';

// Contrato de entrada e saída tendo o valor como string ("25.00") e moeda ("BRL").
export interface MoneyProps {
  amount: string;
  currency: string;
}

// Identifica um valor ou formato de moeda inválido.
export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

// Identifica a tentativa de calcular ou comparar valores de moedas diferentes.
export class CurrencyMismatchError extends Error {
  constructor(expected: string, received: string) {
    super(
      `Cannot operate on different currencies: ${expected} and ${received}`,
    );
    this.name = 'CurrencyMismatchError';
  }
}

// NUMERIC(20,2) comporta 20 dígitos; usamos 21 para detectar overflow sem perder centavos.
// A configuração isolada não muda o comportamento de outros usos de decimal.js.

const MoneyDecimal = Decimal.clone({ precision: 21 });

// Limite da coluna NUMERIC(20,2), também definido nas migrations do PostgreSQL.
const maximumAmount = new MoneyDecimal('999999999999999999.99');

// Obtém os códigos de moeda reconhecidos pelo runtime, como BRL, USD e EUR.
const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));

// Representa dinheiro e concentra suas regras, sem depender do NestJS.
export class Money {
  readonly #value: Decimal;

  // A moeda é pública para consulta; Object.freeze impede sua alteração em execução.
  public readonly currency: string;

  // O construtor privado obriga a criação pelos métodos da classe.
  // Também valida resultados internos, para impedir que operações excedam o limite.
  private constructor(value: Decimal, currency: string) {
    // abs() verifica a magnitude: o limite vale tanto para positivos quanto negativos.
    if (value.abs().greaterThan(maximumAmount)) {
      throw new InvalidMoneyError('Amount exceeds NUMERIC(20,2) capacity');
    }

    // Normaliza o zero para evitar representar um resultado como "-0.00".
    this.#value = value.isZero() ? new MoneyDecimal('0.00') : value;
    this.currency = currency;
    // Impede alterações nas propriedades públicas em execução.
    Object.freeze(this);
  }

  // Factory de entrada valida os dados antes de criar Money.
  // Valores negativos são proibidos aqui, mas podem resultar de cálculos internos.
  static from(props: MoneyProps): Money {
    if (
      // Verificações em execução também protegem contra dados externos fora dos tipos TS.
      !props ||
      typeof props.amount !== 'string' ||
      // Rejeita espaços e quebras de linha, sem corrigir a entrada silenciosamente.
      props.amount.trim() !== props.amount ||
      // Exige de 1 a 18 dígitos inteiros, ponto e exatamente 2 casas decimais.
      !/^[0-9]{1,18}\.[0-9]{2}$/.test(props.amount)
    ) {
      throw new InvalidMoneyError(
        'Amount must be a non-negative decimal string with exactly two decimal places and at most 18 integer digits',
      );
    }
    Money.assertCurrency(props.currency);

    // A string vai diretamente para Decimal, preservando os centavos.
    return new Money(new MoneyDecimal(props.amount), props.currency);
  }

  // Cria zero na moeda informada, passando pelas mesmas validações de entrada.
  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  // Soma valores da mesma moeda e retorna um novo Money; os originais não mudam.
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.plus(other.#value), this.currency);
  }

  // Subtrai e retorna um novo Money. Um resultado negativo é útil na reconciliação;
  // impedir saldo negativo é responsabilidade da Wallet.
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.minus(other.#value), this.currency);
  }

  // Inverte o sinal: "25.00" vira "-25.00", sem modificar o objeto original.
  negate(): Money {
    return new Money(this.#value.negated(), this.currency);
  }

  // Consulta se o valor é exatamente zero.
  isZero(): boolean {
    return this.#value.isZero();
  }

  // Positivo significa maior que zero; zero não é considerado positivo.
  isPositive(): boolean {
    return !this.isZero() && this.#value.isPositive();
  }

  // Negativo significa menor que zero; zero não é considerado negativo.
  isNegative(): boolean {
    return !this.isZero() && this.#value.isNegative();
  }

  // Compara se este valor é menor que o outro, exigindo a mesma moeda.
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.lessThan(other.#value);
  }

  // Compara igualdade exata. Moedas diferentes geram erro.
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.equals(other.#value);
  }

  // Produz o contrato JSON, sem expor o Decimal interno. JSON.stringify usa este método.
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  // Retorna somente o valor com duas casas. Ex: "25.00", sem símbolo ou código da moeda.
  // Este método não aceita nem corrige casas excedentes.
  toString(): string {
    return this.#value.toFixed(2);
  }

  // Valida a moeda antes da criação. Códigos desconhecidos ou fora do padrão são rejeitados.
  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || !supportedCurrencies.has(currency)) {
      throw new InvalidMoneyError('Currency must be a supported ISO-4217 code');
    }
  }

  // Regra compartilhada por soma, subtração e comparações: não misturar moedas.
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
