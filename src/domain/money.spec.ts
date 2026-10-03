// describe agrupa testes; it define um caso; expect verifica o resultado esperado.
import { describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
  type MoneyProps,
} from './money.js';

// Atalho dos testes para criar Money em reais sem repetir a moeda em cada chamada.
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  // it.each executa o mesmo teste para cada valor da lista, incluindo zero e o limite.
  // Verifica que string e JSON preservam os centavos e o contrato { amount, currency }.
  it.each(['0.00', '1.00', '25.50', '1000.99', '999999999999999999.99'])(
    'preserves the exact decimal value %s in the JSON contract',
    (amount) => {
      // toBe compara um valor diretamente; toEqual compara o conteúdo de objetos.
      expect(brl(amount).toString()).toBe(amount);
      expect(JSON.parse(JSON.stringify(brl(amount)))).toEqual({
        amount,
        currency: 'BRL',
      });
    },
  );

  // Entradas fora do contrato devem falhar, nunca ser corrigidas ou arredondadas.
  // A lista cobre formato, sinal, escala, espaços, notação científica e limite monetário.
  it.each([
    '',
    'abc',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '10.999',
    '10.000',
    '-10.00',
    '-0.00',
    '+10.00',
    '1',
    '1.0',
    '.50',
    '1.',
    '1,00',
    ' 1.00',
    '1.00 ',
    '1.00\n',
    '1.00\r',
    '0xff',
    '1_000.00',
    '1000000000000000000.00',
  ])('rejects invalid input %j without silently rounding', (amount) => {
    // Passamos uma função para expect executar e verificar o erro com toThrow.
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  // Tipos TypeScript não validam dados em execução: um payload pode trazer outro tipo.
  // Envolver cada caso em { amount } evita que o Bun interprete [] como argumentos do teste.
  it.each(
    [25, NaN, Infinity, null, undefined, {}, []].map((amount) => ({ amount })),
  )('rejects a non-string amount %j at runtime', ({ amount }) => {
    // A conversão de tipo é proposital neste teste: simula dados externos inválidos.
    expect(() => Money.from({ amount, currency: 'BRL' } as MoneyProps)).toThrow(
      InvalidMoneyError,
    );
  });

  // Mesmo um contrato ausente deve produzir erro de domínio, sem acesso indevido a null.
  it('rejects a missing contract at runtime', () => {
    expect(() => Money.from(null as unknown as MoneyProps)).toThrow(
      InvalidMoneyError,
    );
  });

  // Não normalizamos moedas silenciosamente, o chamador precisa enviar um código válido.
  it.each(['', 'brl', ' BRL', 'BRL ', 'ZZZ', 'REAL'])(
    'rejects an invalid currency %j',
    (currency) => {
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    },
  );

  // O modelo aceita moedas diferentes, embora uma operação nunca possa misturá-las.
  it.each(['BRL', 'USD', 'EUR'])(
    'supports a distinct currency %s',
    (currency) => {
      expect(Money.zero(currency).toJSON()).toEqual({
        amount: '0.00',
        currency,
      });
    },
  );

  // Caso clássico de imprecisão com number 0.1 + 0.2. Money deve produzir "0.30" exato.
  it('adds fractional amounts exactly', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  // Valores grandes revelam conversões indevidas para number e perda de centavos.
  // Também verificamos a subtração perto do limite planejado para o PostgreSQL.
  it('preserves cents above the JavaScript safe integer range', () => {
    expect(brl('9007199254740993.01').add(brl('0.01')).toString()).toBe(
      '9007199254740993.02',
    );
    expect(brl('999999999999999999.99').subtract(brl('0.01')).toString()).toBe(
      '999999999999999999.98',
    );
  });

  // Entrada negativa é proibida, mas uma diferença calculada pode ser negativa.
  // Isso permite informar quanto o saldo armazenado difere do saldo reconstruído.
  it('supports negative internal results for reconciliation', () => {
    const difference = brl('10.00').subtract(brl('25.50'));
    expect(difference.toString()).toBe('-15.50');
    expect(difference.isNegative()).toBe(true);
    expect(difference.negate().toString()).toBe('15.50');
  });

  // Zero não é positivo nem negativo; inverter seu sinal não deve gerar "-0.00".
  it('distinguishes positive, negative and zero amounts', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(zero.negate().toString()).toBe('0.00');
    expect(brl('1.00').subtract(brl('1.00')).toString()).toBe('0.00');
  });

  // Comparações devem distinguir até um centavo e tratar igualdade como não sendo menor.
  it('compares values exactly in the same currency', () => {
    expect(brl('10.00').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(brl('10.01'))).toBe(false);
    expect(brl('10.00').isLessThan(brl('10.01'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('10.01').isLessThan(brl('10.00'))).toBe(false);
  });

  // "1.00 BRL" e "1.00 USD" não são equivalentes; calcular ou comparar deve gerar erro.
  it('rejects mixed currencies for arithmetic and comparisons', () => {
    const real = brl('1.00');
    const dollar = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => real.add(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.subtract(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.equals(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.isLessThan(dollar)).toThrow(CurrencyMismatchError);
  });

  // Imutabilidade: resultados novos não alteram os valores usados na operação.
  it('returns new values without changing either operand', () => {
    const original = brl('10.00');
    const operand = brl('2.00');
    expect(original.add(operand).toString()).toBe('12.00');
    expect(original.subtract(operand).toString()).toBe('8.00');
    expect(original.negate().toString()).toBe('-10.00');
    // Mesmo somar zero retorna outro objeto; not.toBe verifica identidade diferente.
    expect(original.add(Money.zero('BRL'))).not.toBe(original);
    expect(original.toString()).toBe('10.00');
    expect(operand.toString()).toBe('2.00');
    // Verifica proteção em execução, além do readonly do TypeScript.
    expect(Object.isFrozen(original)).toBe(true);
    expect(Reflect.set(original, 'currency', 'USD')).toBe(false);
    // Alterar o objeto retornado por toJSON não pode modificar o Money original.
    const serialized = original.toJSON();
    serialized.amount = '999.00';
    expect(original.toString()).toBe('10.00');
  });

  // Overflow significa ultrapassar o limite monetário, positivo ou negativo.
  // Rejeitar é mais seguro que arredondar ou produzir um valor que o banco não comportará.
  it('rejects overflow in both directions without corrupting operands', () => {
    const maximum = brl('999999999999999999.99');
    expect(() => maximum.add(brl('0.01'))).toThrow(InvalidMoneyError);
    expect(() => maximum.negate().subtract(brl('0.01'))).toThrow(
      InvalidMoneyError,
    );
    expect(maximum.toString()).toBe('999999999999999999.99');
  });

  // Outra parte do sistema pode mudar a precisão global de Decimal.
  // Money deve manter sua precisão própria e continuar preservando os centavos.
  it('is unaffected by global decimal precision changes', () => {
    const previousPrecision = Decimal.precision;
    try {
      Decimal.set({ precision: 2 });
      expect(brl('999999999999999999.98').add(brl('0.01')).toString()).toBe(
        '999999999999999999.99',
      );
    } finally {
      // Restaura a configuração mesmo se o teste falhar, sem afetar os próximos testes.
      Decimal.set({ precision: previousPrecision });
    }
  });
});
