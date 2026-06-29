// Avalia, a partir do placar REAL de um jogo já finalizado, se um mercado
// específico bateu ("green") ou não ("red") — é a mesma definição de
// condição de cada mercado que já existe em CRITERIOS_MERCADO no
// analyze/route.js, só que aplicada ao resultado real em vez de aos dados
// pré-jogo. Mantida separada (não importa nada de analyze/route.js) pra
// poder ser usada tanto pelo cron de resolução automática quanto por testes.
//
// dados esperados:
//   golsA, golsB           -> placar final (obrigatório pra quase todos)
//   golsA1T, golsB1T       -> placar do intervalo (só mercados de 1º tempo)
//   corners                -> total de escanteios dos dois lados (só +8.5 Escanteios)
//   ladoAprovado           -> '1X' | 'X2' (só Dupla Chance — ver nota abaixo)
//
// Retorna 'green' | 'red' | null. null = dado insuficiente pra decidir (NUNCA
// adivinha) — quem chama deve deixar o resultado pendente nesse caso, não
// gravar um green/red errado por falta de informação.
export function avaliarResultadoMercado(mercado, dados) {
  const { golsA, golsB, golsA1T, golsB1T, corners, ladoAprovado } = dados;
  const temPlacarFinal = golsA != null && golsB != null;

  switch (mercado) {
    case 'Lay 2x2':
      if (!temPlacarFinal) return null;
      return (golsA === 2 && golsB === 2) ? 'red' : 'green';

    case '+1.5 Gols':
      if (!temPlacarFinal) return null;
      return (golsA + golsB) >= 2 ? 'green' : 'red';

    case '+0.5 Gols':
      if (!temPlacarFinal) return null;
      return (golsA + golsB) >= 1 ? 'green' : 'red';

    case 'Under 3.5 Gols':
      if (!temPlacarFinal) return null;
      return (golsA + golsB) <= 3 ? 'green' : 'red';

    case 'Lay Empate':
      if (!temPlacarFinal) return null;
      return golsA !== golsB ? 'green' : 'red';

    case 'BTTS Não':
      if (!temPlacarFinal) return null;
      return (golsA === 0 || golsB === 0) ? 'green' : 'red';

    case '-2.5 Gols 1T':
      if (golsA1T == null || golsB1T == null) return null;
      return (golsA1T + golsB1T) <= 2 ? 'green' : 'red';

    case '+0.5 Gols 1T':
      if (golsA1T == null || golsB1T == null) return null;
      return (golsA1T + golsB1T) >= 1 ? 'green' : 'red';

    case '+8.5 Escanteios':
      if (corners == null) return null;
      return corners >= 9 ? 'green' : 'red';

    case 'Dupla Chance':
      // Esse mercado aprova "1X" (Time A não perde) ou "X2" (Time B não
      // perde) dependendo de qual lado a IA identificou como favorito — e
      // isso NÃO é uma propriedade fixa do mercado, é uma decisão por
      // análise. Sem saber qual lado foi aprovado, não tem como resolver
      // certo (1-0 bate "1X" mas não bate "X2"). Exige o campo
      // "lado_aprovado" ter sido salvo no momento da análise.
      if (!temPlacarFinal || (ladoAprovado !== '1X' && ladoAprovado !== 'X2')) return null;
      if (ladoAprovado === '1X') return golsA >= golsB ? 'green' : 'red';
      return golsB >= golsA ? 'green' : 'red';

    default:
      return null;
  }
}
