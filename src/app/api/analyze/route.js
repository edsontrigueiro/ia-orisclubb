export const dynamic = 'force-dynamic';
// Sem isso, a Vercel mata a função no limite padrão (10s no plano Hobby)
// antes mesmo do nosso próprio timeout da chamada à Anthropic ter chance
// de terminar. 60s é o máximo permitido no plano Hobby.
export const maxDuration = 60;
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getCached, setCached } from '@/lib/cache';
import { fetchComRetry } from '@/lib/fetchUtil';
import { getFootballData, logErro } from '@/lib/footballData';
import { calcularBaselinePoisson } from '@/lib/poissonBaseline';

// Cache de análises já feitas, TTL de 2h, pra não gastar chamada de
// API-Football/Anthropic repetindo o mesmo confronto+mercado em sequência.
// Prefixo "analise::" evita colidir com outras chaves de cache (ex: a grade
// de jogos do dia, que usa o mesmo armazenamento compartilhado).
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function chaveCache(jogo, mercado) {
  return `analise::${jogo.trim().toLowerCase()}::${mercado}`;
}

async function lerCache(jogo, mercado) {
  return getCached(chaveCache(jogo, mercado), CACHE_TTL_MS);
}

async function salvarCache(jogo, mercado, payload) {
  return setCached(chaveCache(jogo, mercado), payload);
}

const MERCADOS = {
  'Lay 2x2':        { min: 82 },
  'Dupla Chance':   { min: 86 },
  '+1.5 Gols':      { min: 83 },
  '+0.5 Gols':      { min: 88 },
  '-2.5 Gols 1T':   { min: 86 },
  'Lay Empate':     { min: 84 },
  'Under 3.5 Gols': { min: 85 },
  'BTTS Não':       { min: 88 },
  '+0.5 Gols 1T':   { min: 85 },
  '+8.5 Escanteios':{ min: 85 },
};

// ── Contexto de calibração histórica ────────────────────────────────────
// IMPORTANTE: isso NÃO é a IA "aprendendo" com resultados passados — cada
// chamada à API da Anthropic continua stateless, sem memória entre
// execuções. O que fazemos aqui é buscar, ANTES de cada análise, um resumo
// estatístico real do desempenho desse mercado especificamente (via
// analises_historico) e injetar como CONTEXTO no prompt. É uma aproximação
// barata de retroalimentação — o modelo não muda, mas o dado que ele recebe
// muda com base no histórico real. Só inclui se houver amostra mínima
// (mesmo piso de 15 do protocolo de calibração já alinhado) — abaixo disso,
// taxa bruta engana mais do que ajuda.
const AMOSTRA_MINIMA_CONTEXTO_CALIBRACAO = 15;

function wilsonLowerBound(greens, total) {
  if (!total) return null;
  const z = 1.96;
  const p = greens / total;
  const denominador = 1 + (z * z) / total;
  const centro = p + (z * z) / (2 * total);
  const margem = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return +(((centro - margem) / denominador) * 100).toFixed(1);
}

// Busca o histórico real (aprovadas + resolvidas) desse mercado específico
// pra esse usuário. Roda em paralelo com getFootballData no POST — não é
// bloqueante além do necessário. Falha silenciosa (retorna null) se a query
// der erro: contexto de calibração é um "nice to have" pro prompt, nunca
// deve derrubar a análise principal.
async function buscarContextoCalibracao(userId, mercado) {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db.from('analises_historico')
      .select('resultado')
      .eq('user_id', userId)
      .eq('mercado', mercado)
      .eq('aprovado', true)
      .in('resultado', ['green', 'red']);
    if (error || !data || data.length < AMOSTRA_MINIMA_CONTEXTO_CALIBRACAO) return null;
    const total = data.length;
    const greens = data.filter(d => d.resultado === 'green').length;
    return {
      total,
      taxa_acerto_bruta: +((greens / total) * 100).toFixed(1),
      wilson_lower_bound: wilsonLowerBound(greens, total),
    };
  } catch (e) {
    logErro('contexto_calibracao', { mercado }, e);
    return null;
  }
}

// Critérios estatísticos explícitos por mercado, injetados no prompt da IA
// para os mercados de alta assertividade. Sem isso, a IA julga "no genérico"
// e o score deixa de refletir os sinais que de fato tornam esses mercados
// historicamente mais assertivos.
const CRITERIOS_MERCADO = {
  'Lay 2x2': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Lay 2x2 (aposta CONTRA o placar exato terminar 2-2):
- Qualquer placar exato específico é estatisticamente raro (2-2 normalmente ocorre em menos de 10% dos jogos em quase qualquer contexto) — então a base desse mercado já é favorável por natureza. O risco real está em identificar os confrontos onde 2-2 é MAIS provável que a média, e reprovar esses.
- O perfil de risco pra esse mercado é: dois times com ataque médio-alto e defesa fraca, parecidos entre si (sem favorito claro). Se "media_gols_marcados" e "media_gols_sofridos" dos dois times forem parecidos E ambos médio-altos (ex: 1.5-2.5 marcados, 1.3-2 sofridos), isso é o cenário onde 2-2 fica mais provável — reduza o score.
- Favoritismo claro entre os dois (diferença grande de "media_gols_marcados"/"media_gols_sofridos") REDUZ o risco de 2-2 — favorito tende a vencer com placar diferente de 2-2 (ou por margem maior, ou o adversário fraco nem chega a marcar 2). Isso reforça a aprovação.
- Em "confrontos_diretos", se ALGUM dos jogos recentes (dias_atras < 730) terminou exatamente 2-2 entre esses dois times, isso é precedente direto e forte — reduza bastante o score, mesmo com bom perfil geral.
- Jogos com expectativa de gols muito baixa (combinado < 2) OU muito alta (combinado > 5) tendem a NÃO terminar 2-2 especificamente — favorecem esse mercado. É a faixa intermediária (combinado entre ~3 e 4.5) com times parecidos que é o perigo.
- Exija amostra mínima de 8 jogos disputados na temporada/forma recente para AMBOS os times.`,

  '+1.5 Gols': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Over 1.5 Gols (jogo termina com 2 gols ou mais, total):
- Só aprove se a soma das médias de gols marcados dos dois times for >= 3.0. O threshold antigo (2.6) implicava, sob modelo de Poisson, só ~73% de probabilidade de 2+ gols — bem abaixo do mínimo de 83 desse mercado, e a calibração real confirmou o subdesempenho exatamente nesse mercado. Soma 3.0-3.2 é o que sustenta ~82-84% de probabilidade real. Esse cálculo é reconferido em código depois da sua resposta (Gate 24) — se a soma real não bater, a aprovação é revertida automaticamente.
- Considere também as médias de gols SOFRIDOS dos dois lados — dois ataques medianos contra duas defesas fracas produzem mais gols do que contra defesas sólidas. O campo "baseline_poisson" (Regra 16) já combina ataque e defesa dos dois times numa estimativa única — use-o como âncora.
- Verifique "jogos_sem_marcar_gol" de CADA time individualmente: se QUALQUER UM dos dois tiver taxa alta (>= 25% dos jogos recentes sem marcar), já é sinal de risco real de jogo com 1 gol ou menos — reduza o score, mesmo que o outro time tenha 0% de jogos sem marcar. NÃO trate o outro time marcar sempre como "mitigador" desse risco: pra esse mercado falhar (total <= 1), basta UM dos dois lados ficar sem marcar e o outro marcar só 1 — não é preciso os dois secarem juntos. Se AMBOS tiverem taxa alta simultaneamente, o risco é ainda maior — reduza mais.
- Em "confrontos_diretos", a média de gols totais por jogo nos H2H recentes (dias_atras < 730) deve reforçar a tendência — se os confrontos diretos específicos tiverem sido de poucos gols, isso pesa contra, mesmo com boas médias gerais de cada time isolado.
- Exija amostra mínima de 8 jogos disputados na temporada/forma recente para AMBOS os times.`,

  '+0.5 Gols': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Over 0.5 Gols (pelo menos 1 gol no jogo, mercado naturalmente muito provável):
- Esse é o mercado mais "automático" da lista — 0x0 é o resultado mais raro entre os possíveis na grande maioria dos contextos. Mesmo assim, REPROVE se houver sinal real de risco: exija que NÃO seja verdade simultaneamente que (a) Time A tenha "jogos_sem_marcar_gol" alto (>= 25%) E (b) Time B tenha "jogos_sem_sofrer_gol" alto (>= 25%) — essa combinação especificamente é o perfil de jogo que termina 0x0.
- Mesma checagem no sentido inverso (Time B sem marcar muito + Time A com defesa muito sólida) — se QUALQUER um dos dois lados desse "casal" de condições for verdade, reduza o score.
- Em "confrontos_diretos", um 0x0 recente (dias_atras < 730) entre esses dois times específicos é sinal de alerta real, mesmo sendo mercado tipicamente seguro — reduza o score se isso ocorrer.
- Exija amostra mínima de 8 jogos disputados na temporada/forma recente para AMBOS os times.`,

  'Dupla Chance': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Dupla Chance (1X ou X2) no favorito:
- Só aprove se houver diferença CLARA de qualidade entre os times nos dados: favorito com média de gols marcados >= 1.8 e média de gols sofridos <= 1.2; adversário com média de gols sofridos >= 1.5. Se as médias forem parecidas entre os dois times, isso é um jogo equilibrado — REPROVE, mesmo que um dos nomes "pareça" favorito.
- Se o campo "classificacao" estiver presente, ele é um SEGUNDO caminho pra caracterizar favoritismo claro, independente do critério de médias de gols acima: diferença de 8+ posições na tabela, OU diferença de saldo de gols ("saldo_gols") de 15+, entre os dois times É por si só diferença clara de qualidade — mesmo que as médias de gols dos dois pareçam parecidas (isso acontece quando o favorito vence por eficiência em jogos decisivos, não por volume ofensivo). Nesse caso, pode aprovar mesmo sem o critério de médias acima ser satisfeito — mas cite os números de "classificacao" explicitamente no "insight" como o motivo. Se "classificacao" não estiver presente, ignore esse critério (não é obrigatório, é um caminho A MAIS de aprovação, nunca um requisito a mais).
- Priorize "como_mandante" do Time A e "como_visitante" do Time B (não a média geral) — um time pode ser ótimo em casa e mediano fora, e é justamente o mando de campo que decide esse mercado. EXCEÇÃO: se "modo_copa" for true (torneio internacional, possivelmente em sede neutra), esse mando pode não refletir uma vantagem real de jogar "em casa" — nesse caso baseie-se na forma geral combinada em vez de insistir no recorte mandante/visitante.
- Nos confrontos diretos RECENTES (dias_atras < 730), o favorito não deve ter mais de 1 derrota — dê peso extra aos confrontos com "mesmo_mando_atual": true. 2+ derrotas no H2H recente é sinal de zebra recorrente — reduza o score fortemente. Derrotas com mais de 2 anos NÃO contam pra esse limite (elencos e técnicos mudam — Regra 9); essa contagem é reconferida em código com o mesmo filtro (Gate 14).
- Exija amostra mínima de 8 jogos disputados na temporada para AMBOS os times. Menos que isso, reduza o score e diga isso explicitamente em "alertas".
- Competições eliminatórias / mata-mata (decisão, copa, playoff) têm motivação anormal e mais risco de zebra — se a "liga" indicada nos dados for desse tipo, reduza o score mesmo com favoritismo claro nas médias.`,

  'Lay Empate': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Lay Empate (o jogo não pode terminar em X):
- Só aprove se a soma das médias de gols marcados dos dois times for >= 2.4. Jogos com tendência ofensiva clara empatam menos. Esse cálculo é reconferido em código depois da sua resposta (Gate 15) — se a soma real não bater, a aprovação é revertida automaticamente, então calcule certo.
- Nos confrontos diretos RECENTES (dias_atras < 730), no máximo 2 podem ter terminado empatados. 3+ empates no H2H recente é sinal forte de que esse confronto específico tende ao empate — reprove. Empates com mais de 2 anos não contam pra esse limite (Regra 9). Essa contagem também é reconferida em código com o mesmo filtro (Gate 16).
- Prefira confrontos com diferença de qualidade clara (favorito x zebra). Jogos historicamente equilibrados entre os mesmos dois times tendem a empate; isso deve reduzir o score mesmo se a soma de gols for alta. Se o campo "classificacao" estiver presente (posição/saldo de gols na tabela), use-o como sinal adicional de diferença de qualidade — mesma lógica do critério de "Dupla Chance": diferença de 8+ posições ou saldo de gols de 15+ é diferença clara de qualidade, mesmo com médias de gols parecidas.
- Se "modo_copa" for true (torneio internacional / mata-mata), tenha cautela extra: jogos eliminatórios tendem a ter postura mais conservadora dos dois lados (às vezes o empate até interessa por regra de agregado), o que aumenta o risco de empate independentemente da diferença de qualidade entre os times — mencione isso no "insight" quando aplicável, reduzindo a confiança.
- Exija amostra mínima de 8 jogos disputados na temporada para AMBOS os times.`,

  'Under 3.5 Gols': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Under 3.5 Gols (jogo total com 3 gols ou menos):
- Só aprove se a soma das médias de gols marcados dos dois times for <= 2.1. O threshold antigo (2.6) implicava, sob Poisson, só ~74% de probabilidade de 3 gols ou menos — abaixo do mínimo de 85 desse mercado. Soma <= 2.0-2.1 é o que sustenta ~85-86%. Esse cálculo é reconferido em código depois da sua resposta (Gate 25) — se a soma real não bater, a aprovação é revertida automaticamente.
- Exija que pelo menos um dos dois times tenha taxa de "jogos sem sofrer gol" (clean sheets / jogos disputados) >= 25%. Isso indica capacidade defensiva real, não só sorte pontual.
- Nos confrontos diretos disponíveis (até 10), a média de gols totais por jogo deve ser <= 3.0. Histórico de jogos com 4+ gols entre esses times específicos é motivo forte para reprovar, mesmo com médias de temporada baixas.
- Exija amostra mínima de 8 jogos disputados na temporada para AMBOS os times.`,

  '-2.5 Gols 1T': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Under 2.5 Gols no PRIMEIRO TEMPO (total de gols dos dois times até o intervalo <= 2):
- Esse mercado é especificamente sobre o 1º TEMPO, não o jogo todo. Use o subcampo "primeiro_tempo" dentro de "forma_recente_time_a/b" — ele já vem calculado a partir do placar real do intervalo de cada jogo, NÃO é estimado a partir da média do jogo inteiro. Se "primeiro_tempo" for null, a API não trouxe placar de intervalo pra esses jogos — isso é ESPERADO e comum em jogos de seleção nacional (amistosos, eliminatórias), onde a cobertura de dado é mais pobre que em ligas de clube europeias; diga isso explicitamente no insight ("cobertura de dado de 1º tempo é tipicamente mais pobre pra jogos de seleção") em vez de tratar como uma falha genérica qualquer. Reduza a confiança mesmo assim, mas tente usar "pct_jogos_1t_total_baixo" quando disponível.
- "primeiro_tempo.pct_jogos_1t_total_baixo" de cada time é a métrica mais direta pra esse mercado: é o % dos jogos recentes desse time em que o total de gols no 1T (somando os dois lados) foi <= 2. Só aprove se os dois times tiverem esse percentual >= 75%. O threshold antigo (60%) estava ABAIXO da taxa base do evento (~85-88% dos jogos de futebol terminam o 1T com 2 gols ou menos) — ou seja, aprovava times notavelmente PIORES que a média pra esse mercado. Esse é um mercado estruturalmente favorável, então o papel do critério é EXCLUIR confrontos de risco elevado, não exigir perfil excepcional: um time abaixo de 75% é significativamente mais "movimentado" no 1T que a média e deve ser excluído.
- "estatisticas_time_a/b.pct_gols_marcados_1t_temporada" e "pct_gols_sofridos_1t_temporada" são um SEGUNDO sinal pra esse mercado: % dos gols da TEMPORADA INTEIRA (marcados e sofridos) que saíram até o intervalo, com amostra muito maior que os ~10 jogos de "forma_recente". Se disponível (não-null), use como confirmação — percentual baixo aqui (~33% ou menos seria o "esperado" se gols fossem uniformes ao longo do jogo) reforça que esse time realmente "começa devagar" e não é só coincidência dos últimos jogos. Se esse percentual season for ALTO (time concentra gols no 1T historicamente) mas "pct_jogos_1t_total_baixo" recente for bom, há uma contradição — mencione isso e seja mais conservador.
- PRIORIZE o "primeiro_tempo" DENTRO de "como_mandante" do Time A e "como_visitante" do Time B (não o "primeiro_tempo" geral, que mistura jogos em casa e fora) — mando de campo afeta o ritmo do 1º tempo igual afeta o jogo todo: um time pode começar devagar em casa e rápido fora, por exemplo. Use o geral só como reforço/comparação, não como fonte principal. EXCEÇÃO: se "modo_copa" for true (torneio internacional, possivelmente em sede neutra), esse recorte de mando pode não refletir uma vantagem/contexto real — nesse caso use o "primeiro_tempo" geral combinado.
- Em "confrontos_diretos", use o campo "placar_1t" quando presente — H2H com 1T historicamente movimentado (2+ gols no intervalo) entre esses dois times específicos é motivo forte pra reprovar, mesmo com boas médias gerais.
- Times que costumam "começar devagar" (média de gols marcados no 1T bem menor que a média do jogo completo) favorecem esse mercado — compare "media_gols_marcados_1t" com "media_gols_marcados" geral pra notar esse padrão.
- Exija amostra mínima de 8 jogos com dado de 1º tempo disponível pra AMBOS os times.`,

  'BTTS Não': `CRITÉRIOS DE ALTA ASSERTIVIDADE — BTTS Não (Ambas as equipes NÃO marcam, ou seja, pelo menos um lado fica a zero):
- Exija que PELO MENOS UM dos dois times tenha "jogos_sem_marcar_gol" / "jogos_considerados" >= 30% (ataque fraco/inconsistente) OU que o ADVERSÁRIO tenha "jogos_sem_sofrer_gol" / "jogos_considerados" >= 30% (defesa sólida o suficiente pra anular esse ataque). Sem pelo menos um desses dois sinais, REPROVE — não existe motivo estatístico real pra um dos lados ficar a zero.
- Combine com diferença de qualidade: favorito x zebra tende a deixar a zebra sem marcar mais do que jogos equilibrados, onde os dois lados costumam ter alguma chance.
- Nos confrontos diretos disponíveis (até 10), conte quantos tiveram os dois times marcando — se isso ocorreu em mais da metade dos H2H recentes (dias_atras < 730), é sinal de que ESSE confronto específico tende a ter os dois marcando, mesmo que as médias gerais sugiram o contrário; reduza o score nesse caso.
- Exija amostra mínima de 8 jogos disputados na temporada/forma recente para AMBOS os times.`,

  '+0.5 Gols 1T': `CRITÉRIOS DE ALTA ASSERTIVIDADE — +0.5 Gols no PRIMEIRO TEMPO (pelo menos 1 gol no intervalo):
- Use "primeiro_tempo.pct_jogos_1t_sem_gols" de cada time — é o % dos jogos recentes em que o 1T terminou 0x0. Só aprove se os DOIS times tiverem esse percentual <= 15% (ou seja, em pelo menos 85% dos jogos recentes de cada time houve gol antes do intervalo). O threshold antigo (25%) era praticamente igual à taxa base do evento (~25-30% dos jogos de futebol têm 1T 0x0) — não filtrava nada: aprovava perfil mediano num mercado cujo mínimo declarado é 85, que exige perfil EXCEPCIONAL de gols cedo (λ de 1º tempo ~1.9 combinado, contra ~1.1-1.2 típico). Esse mercado NÃO é estruturalmente favorável como o "-2.5 Gols 1T" — a taxa base de "pelo menos 1 gol no 1T" é ~72%, bem abaixo do mínimo de 85 — então só confrontos genuinamente excepcionais devem passar. Espere aprovar POUCO nesse mercado; isso é o comportamento correto.
- "estatisticas_time_a/b.pct_gols_marcados_1t_temporada"/"pct_gols_sofridos_1t_temporada" são um segundo sinal, com amostra de TEMPORADA INTEIRA (bem maior que os ~10 jogos de "forma_recente"). Se disponível, percentual ALTO aqui (time concentra gols no 1T historicamente) reforça a aprovação; percentual baixo é sinal de alerta mesmo se os últimos jogos pareceram bons.
- PRIORIZE o "primeiro_tempo" DENTRO de "como_mandante" do Time A e "como_visitante" do Time B (não o "primeiro_tempo" geral, que mistura casa e fora) — um time pode demorar a marcar fora mas começar rápido em casa, por exemplo. Use o geral só como reforço/comparação. EXCEÇÃO: se "modo_copa" for true, use o "primeiro_tempo" geral combinado, pelo mesmo motivo já explicado nos outros mercados (mando pode não ser real em sede neutra).
- Se "primeiro_tempo" for null pra qualquer um dos dois times, mesma ressalva do mercado "-2.5 Gols 1T": é comum em jogos de seleção nacional, mas reduz a confiança — diga isso no insight.
- Em "confrontos_diretos", use "placar_1t" quando presente: se a maioria dos H2H recentes (dias_atras < 730) teve 1T 0x0, isso é sinal forte contra esse mercado específico, mesmo com boas médias gerais de cada time.
- Times ofensivos que "começam rápido" (média de gols no 1T próxima ou maior que a média do jogo completo dividida por 2) reforçam esse mercado.
- Exija amostra mínima de 8 jogos com dado de 1º tempo disponível pra AMBOS os times.`,

  '+8.5 Escanteios': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Over 8.5 Escanteios (total de escanteios do jogo, dos dois times somados, mínimo 9):
- Os dados trazem "escanteios" dentro de "forma_recente_time_a/b" — é a média de escanteios TOTAIS (dos dois lados, não só desse time) nos jogos recentes em que esse time jogou. Se "escanteios" for null, ou se "jogos_considerados" dentro dele for bem menor que os 10 jogos buscados, a API não tem esse dado disponível pra boa parte desses jogos — cobertura de escanteio é tipicamente mais pobre que cobertura de gol, e MUITO mais pobre em jogos de seleção nacional (amistosos, eliminatórias) do que em ligas de clube europeias. Isso é uma limitação conhecida da fonte de dado, não uma falha — diga isso explicitamente no insight quando acontecer ("cobertura de escanteios é tipicamente mais pobre em jogos de seleção"), em vez de tratar como erro genérico. Reprove mesmo assim por dado insuficiente, mas com essa explicação específica.
- Calcule a média combinada: (escanteios_time_a + escanteios_time_b) / 2. Só aprove se essa média combinada for >= 11.5. O threshold antigo (9.5) implicava, com o desvio-padrão típico de escanteios (~3.5/jogo), só ~61% de probabilidade de 9+ escanteios — pouco mais que cara ou coroa, contra um mínimo declarado de 85 nesse mercado. Média combinada ~11.5-12 é o que sustenta ~80-84%. ATENÇÃO: essa média combinada pode esconder um time com histórico de poucos escanteios sendo puxado pra cima só pelo número do adversário — se QUALQUER um dos dois times, isoladamente, tiver média própria bem abaixo da combinada, reduza o score mesmo com a combinada aprovada. Isso é reconferido em código (Gate 17): média combinada >= 11.5 e piso mínimo por time — se falhar, a aprovação é revertida automaticamente.
- Se "escanteios_h2h" estiver disponível (confrontos diretos específicos entre esses dois times), dê peso MAIOR a ele do que à média geral de cada time separado — é o dado mais específico que existe pra esse confronto. Se "escanteios_h2h.media_escanteios" for visivelmente menor que a média combinada geral, reduza o score.
- Escanteio é um dado mais "ruidoso" que gol (varia mais jogo a jogo) — seja mais conservador aqui do que seria em mercados de gols com números parecidos. Exija amostra mínima de 8 jogos com dado de escanteio disponível pra AMBOS os times. Esse mercado tende a ser mais confiável em ligas de clube do que em jogos de seleção, justamente por causa da cobertura de dado.`,
};
// ── Enforcement determinístico (Gates 1-3) ──────────────────────────────────
// A Regra 12 do system prompt PEDE pra IA descontar confiança quando um
// percentual alto vem de amostra pequena, mas isso é só instrução de texto —
// nada no código garantia que ela de fato fizesse isso. As funções abaixo
// rodam DEPOIS da IA responder e revertem a aprovação na marra quando o dado
// real (não o que a IA disse) não sustenta, registrando um alerta explícito
// em vez de mudar o resultado em silêncio.
// Gate 1: amostra geral mínima (todos os mercados).
// Gate 2: qualidade geral do dado da competição (todos os mercados) — pega
//         ligas de cobertura ruim (2ª/3ª divisão, ligas pequenas/novas) sem
//         precisar saber o nome da liga.
// Gate 3: amostra fina de 1º tempo (só -2.5 Gols 1T e +0.5 Gols 1T).
const AMOSTRA_MINIMA_GERAL = 8;   // mesmo número exigido em todo CRITERIOS_MERCADO
const AMOSTRA_MINIMA_RECORTE = 6; // recorte mandante/visitante/1T — limiar da Regra 12

// Mercados cujo critério depende do recorte de 1º tempo (mando-específico ou
// geral em modo copa) — é onde a amostra "fina" mais aparece, e foi
// justamente onde caíram 2 dos 3 últimos reds registrados.
const MERCADOS_1T = new Set(['-2.5 Gols 1T', '+0.5 Gols 1T']);

function aplicarEnforcementDeterministico(mercado, dadosReais, result, min) {
  if (!result.aprovado) return; // só precisa intervir quando a IA aprovou

  const formaA = dadosReais.forma_recente_time_a;
  const formaB = dadosReais.forma_recente_time_b;

  // Sinais de qualidade de dado, calculados sempre (independente de qual
  // gate decide aprovar/reprovar) e anexados no result pra serem logados em
  // analises_historico via registrarHistoricoAnalise. Sem isso gravado, não
  // dá pra calibrar depois se esses sinais de fato preveem red, nem
  // verificar se o Gate 2 está prevenindo recorrência dos 4 reds que o
  // motivaram (todos em ligas de baixa cobertura).
  const oddAusenteFlag = dadosReais.odds_mercado_real == null;
  const crossCheckTemporadaAusenteFlag = !!dadosReais.estatisticas_indisponiveis;
  const h2hVazioFlag = !!dadosReais.confrontos_diretos_indisponivel;
  const h2hSoAntigoFlag = !h2hVazioFlag && Array.isArray(dadosReais.confrontos_diretos) &&
    dadosReais.confrontos_diretos.every(j => j.dias_atras == null || j.dias_atras > 730);
  const h2hFracoFlag = h2hVazioFlag || h2hSoAntigoFlag;
  const matchAproximadoFlag = dadosReais.match_exato_a === false || dadosReais.match_exato_b === false;
  result._sinaisQualidade = {
    match_exato_a: dadosReais.match_exato_a ?? null,
    match_exato_b: dadosReais.match_exato_b ?? null,
    // odd_real_ausente continua calculado e salvo como metadado informativo
    // (útil pra calibração/relatório histórico), mas — por instrução
    // explícita do Edson — PAROU de contar pra sinais_fracos_count/Gate 2.
    // A odd (presente ou ausente) não deve influenciar aprovação/reprovação
    // em nenhuma medida, nem indiretamente via qualidade de dado.
    odd_real_ausente: oddAusenteFlag,
    crosscheck_temporada_ausente: crossCheckTemporadaAusenteFlag,
    h2h_fraco: h2hFracoFlag,
    sinais_fracos_count: [crossCheckTemporadaAusenteFlag, h2hFracoFlag, matchAproximadoFlag].filter(Boolean).length,
  };

  // Gate 0 — se os DOIS times vieram de match aproximado (nenhum nome bateu
  // exato com a base da API), o risco não é só "dado fraco", é estarmos
  // potencialmente analisando o confronto errado por completo (homônimos).
  // Isso é mais grave que qualquer critério estatístico — reprova sem
  // excepção, antes de considerar mais nada.
  if (dadosReais.match_exato_a === false && dadosReais.match_exato_b === false) {
    result.aprovado = false;
    result.score = Math.min(result.score, min - 1);
    result.alertas = [
      ...(result.alertas || []),
      `[Enforcement automático] Nenhum dos dois times foi identificado por nome exato na base da API-Football — risco real de o confronto analisado não ser o pretendido. Aprovação da IA foi revertida pelo código — Gate 0.`,
    ];
    return;
  }

  // Gate 1 — amostra geral mínima de 8 jogos, a mesma exigida em TODO
  // mercado no prompt. Sem isso pra qualquer um dos dois times, não existe
  // critério estatístico que se sustente — reprova sem excepção, mesmo que
  // a IA tenha dado um score acima do mínimo.
  const amostraGeralA = formaA?.jogos_considerados ?? null;
  const amostraGeralB = formaB?.jogos_considerados ?? null;
  if (amostraGeralA == null || amostraGeralA < AMOSTRA_MINIMA_GERAL ||
      amostraGeralB == null || amostraGeralB < AMOSTRA_MINIMA_GERAL) {
    result.aprovado = false;
    result.score = Math.min(result.score, min - 1);
    result.alertas = [
      ...(result.alertas || []),
      `[Enforcement automático] Amostra geral insuficiente (mínimo ${AMOSTRA_MINIMA_GERAL} jogos) — Time A: ${amostraGeralA ?? 'sem dado'}, Time B: ${amostraGeralB ?? 'sem dado'}. Aprovação da IA foi revertida pelo código — Gate 1.`,
    ];
    return;
  }

  // Gate 2 — qualidade geral do dado, vale pra TODOS os mercados, não só
  // 1º tempo. Não depende de saber o nome da liga: mede 3 sinais que ficam
  // fracos automaticamente em ligas de cobertura pior (2ª/3ª divisão, ligas
  // novas/pequenas), sem precisar manter lista nenhuma de liga proibida.
  // Se 2 ou mais desses 3 sinais vierem fracos juntos, reprova.
  // Originalmente eram 4 sinais (incluindo odd real ausente) — por
  // instrução explícita do Edson, a odd parou de contar aqui (e em
  // qualquer outro lugar do sistema): odd ausente ou presente não deve
  // influenciar aprovação/reprovação em nenhuma medida. O campo
  // "odd_real_ausente" continua calculado e salvo em result._sinaisQualidade
  // só como metadado informativo pra relatório/calibração histórica, fora
  // da contagem que decide o Gate.
  // 3º sinal: identificação de time NÃO foi por nome exato (caiu pro
  // primeiro resultado de busca por relevância da API) — risco real de
  // estarmos olhando o time errado, o que torna TODOS os outros dados
  // (forma, H2H) potencialmente inválidos, não só "fracos".
  const { crosscheck_temporada_ausente: crossCheckTemporadaAusente, h2h_fraco: h2hFraco, sinais_fracos_count: sinaisFracos } = result._sinaisQualidade;
  const matchTimeAproximado = dadosReais.match_exato_a === false || dadosReais.match_exato_b === false;
  if (sinaisFracos >= 2) {
    result.aprovado = false;
    result.score = Math.min(result.score, min - 1);
    result.alertas = [
      ...(result.alertas || []),
      `[Enforcement automático] Qualidade geral de dado insuficiente pra essa competição — estatística de temporada ${crossCheckTemporadaAusente ? 'ausente' : 'disponível'}, H2H ${h2hFraco ? 'vazio ou só com jogos com mais de 2 anos' : 'ok'}, identificação de time ${matchTimeAproximado ? 'NÃO foi exata (risco de time errado)' : 'exata'}. Aprovação da IA foi revertida pelo código — Gate 2.`,
    ];
    return;
  }

  // Gate 3 — específico de mercados de 1º tempo: o recorte mais granular
  // (mando + 1T, ou 1T geral combinado em modo copa, igual a Regra 11 já
  // manda priorizar) precisa de pelo menos AMOSTRA_MINIMA_RECORTE jogos com
  // dado de 1º tempo disponível. Sem isso, mesmo um percentual de 100%
  // citado pela IA é estatisticamente frágil demais pra sustentar aprovação
  // sozinho — só aceita se houver confirmação por dado de TEMPORADA INTEIRA
  // (estatisticas_time_a/b), que é exatamente o cross-check que a Regra 12
  // pede antes de confiar num recorte pequeno.
  if (MERCADOS_1T.has(mercado)) {
    const modoCopa = dadosReais.modo_copa;
    const recorteA = modoCopa ? formaA?.primeiro_tempo : formaA?.como_mandante?.primeiro_tempo;
    const recorteB = modoCopa ? formaB?.primeiro_tempo : formaB?.como_visitante?.primeiro_tempo;
    const amostra1tA = recorteA?.jogos_considerados ?? null;
    const amostra1tB = recorteB?.jogos_considerados ?? null;

    const temCrossCheck =
      dadosReais.estatisticas_time_a?.pct_gols_marcados_1t_temporada != null &&
      dadosReais.estatisticas_time_b?.pct_gols_sofridos_1t_temporada != null;

    const amostraFragil =
      amostra1tA == null || amostra1tB == null ||
      amostra1tA <= AMOSTRA_MINIMA_RECORTE || amostra1tB <= AMOSTRA_MINIMA_RECORTE;

    if (amostraFragil && !temCrossCheck) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Dado de 1º tempo com amostra pequena ou ausente no recorte usado (Time A: ${amostra1tA ?? 'sem dado'} jogos, Time B: ${amostra1tB ?? 'sem dado'} jogos) e sem confirmação por dado de temporada inteira. Aprovação da IA foi revertida pelo código — Regra 12 (Gate 3).`,
      ];
      return;
    }
  }

  // Gate 4 — amostra do recorte mando/visitante (GERAL, não só 1º tempo).
  // A Regra 8 do prompt manda priorizar "como_mandante" do Time A e
  // "como_visitante" do Time B sobre a média geral, pra TODO mercado (não só
  // os de 1T) — mas nada em código garantia amostra mínima nesse recorte
  // específico. Foi exatamente essa lacuna que aprovou o sinal de "+1.5
  // Gols" Athletico PR U20 x Bragantino U20: "40% sem marcar como mandante"
  // vinha de uma amostra de 5 jogos, e o score tratou isso como sinal forte
  // de risco sem desconto de confiança nenhum em código. Só se aplica fora
  // de modo_copa: em modo_copa a própria Regra 11 já manda ignorar o recorte
  // de mando (sede neutra) e usar a forma geral combinada — não faz sentido
  // aplicar piso de amostra num recorte que a regra manda nem usar.
  const DIVERGENCIA_MAXIMA_TAXA = 0.20; // 20 pontos percentuais

  // Taxa genérica de qualquer campo de contagem sobre uma amostra — usada
  // pra "jogos_sem_marcar_gol" (Gates 4, 9, 10, 11) e "jogos_sem_sofrer_gol"
  // (Gates 10, 11, 12). Retorna null se não der pra calcular (bloco ausente,
  // amostra ausente/zero, ou campo de contagem ausente).
  function taxaCampo(bloco, campoContagem, campoAmostra) {
    const amostra = bloco?.[campoAmostra];
    const contagem = bloco?.[campoContagem];
    if (bloco == null || amostra == null || amostra === 0 || contagem == null) return null;
    return contagem / amostra;
  }
  // Mantido como wrapper — Gates 4 e 9 já chamam taxaSemMarcar(bloco, campoAmostra)
  // diretamente, sem precisar saber do campoContagem genérico.
  function taxaSemMarcar(bloco, campoAmostra) {
    return taxaCampo(bloco, 'jogos_sem_marcar_gol', campoAmostra);
  }

  if (!dadosReais.modo_copa) {
    const mandanteA = formaA?.como_mandante;
    const visitanteB = formaB?.como_visitante;
    const amostraMandanteA = mandanteA?.jogos_considerados ?? null;
    const amostraVisitanteB = visitanteB?.jogos_considerados ?? null;

    // Cross-check: estatisticas_time_a/b vêm de /teams/statistics (temporada
    // inteira presa à liga atual), com amostra tipicamente maior que os ~5
    // jogos de mando dentro de forma_recente (que busca só os últimos 10
    // jogos em qualquer competição). Não basta essa segunda fonte EXISTIR
    // com amostra boa — ela precisa CONCORDAR em direção com o recorte
    // pequeno, senão "confirmar" é só maquiagem: foi exatamente esse buraco
    // que deixaria passar o caso Athletico PR se a API tivesse trazido
    // stats de temporada do Bragantino como visitante também (o dado de
    // temporada do Athletico como mandante, 10% sem marcar, CONTRADIZ os
    // 40% da amostra recente de 5 jogos — divergência de 30pp, não uma
    // confirmação).
    const statsMandanteA = dadosReais.estatisticas_time_a?.como_mandante;
    const statsVisitanteB = dadosReais.estatisticas_time_b?.como_visitante;
    const amostraSeasonMandanteOk = (statsMandanteA?.jogos_disputados ?? 0) > AMOSTRA_MINIMA_RECORTE;
    const amostraSeasonVisitanteOk = (statsVisitanteB?.jogos_disputados ?? 0) > AMOSTRA_MINIMA_RECORTE;

    const taxaRecenteA = taxaSemMarcar(mandanteA, 'jogos_considerados');
    const taxaSeasonA = taxaSemMarcar(statsMandanteA, 'jogos_disputados');
    const taxaRecenteB = taxaSemMarcar(visitanteB, 'jogos_considerados');
    const taxaSeasonB = taxaSemMarcar(statsVisitanteB, 'jogos_disputados');

    const concordaA = taxaSeasonA != null && taxaRecenteA != null &&
      Math.abs(taxaSeasonA - taxaRecenteA) <= DIVERGENCIA_MAXIMA_TAXA;
    const concordaB = taxaSeasonB != null && taxaRecenteB != null &&
      Math.abs(taxaSeasonB - taxaRecenteB) <= DIVERGENCIA_MAXIMA_TAXA;

    const temCrossCheckMando =
      amostraSeasonMandanteOk && amostraSeasonVisitanteOk && concordaA && concordaB;

    const amostraMandoFragil =
      amostraMandanteA == null || amostraVisitanteB == null ||
      amostraMandanteA <= AMOSTRA_MINIMA_RECORTE || amostraVisitanteB <= AMOSTRA_MINIMA_RECORTE;

    if (amostraMandoFragil && !temCrossCheckMando) {
      const divergenciaTexto = (taxaSeasonA != null && taxaRecenteA != null && !concordaA)
        ? ` [divergência Time A: ${(taxaRecenteA * 100).toFixed(0)}% recente vs ${(taxaSeasonA * 100).toFixed(0)}% temporada]`
        : (taxaSeasonB != null && taxaRecenteB != null && !concordaB)
        ? ` [divergência Time B: ${(taxaRecenteB * 100).toFixed(0)}% recente vs ${(taxaSeasonB * 100).toFixed(0)}% temporada]`
        : '';
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Recorte mando/visitante com amostra pequena (Time A como mandante: ${amostraMandanteA ?? 'sem dado'} jogos, Time B como visitante: ${amostraVisitanteB ?? 'sem dado'} jogos) e sem confirmação confiável por dado de temporada inteira (/teams/statistics)${divergenciaTexto}. Percentuais desse recorte não sustentam aprovação sozinhos. Aprovação da IA foi revertida pelo código — Gate 4.`,
      ];
    }
  }

  // Helper reutilizado pelos Gates 9-12 — mesma exigência de convergência
  // que o Gate 4 já aplica, generalizada. Caso real que motivou isso: Gais
  // x Elfsborg (+0.5 Gols), onde o Gate 10 reprovou empilhando dois sinais
  // de amostra pequena (Elfsborg 25% sem marcar como visitante em 4 jogos;
  // Gais 60% sem sofrer como mandante em 5 jogos) sem nunca checar se
  // algum dos dois convergia com a temporada inteira — o Gate 4, alguns
  // gates acima, JÁ fazia essa checagem pro seu próprio critério, mas os
  // Gates 9-12 foram escritos depois com uma exigência mais fraca (só
  // olhavam o limiar do recorte, não pediam confirmação cruzada).
  //
  // Regra: um sinal de risco baseado em recorte pequeno (mando/visitante)
  // só é aceito nos Gates 9-12 se:
  // (a) não existir dado de temporada nesse mesmo recorte com amostra
  //     suficiente (> AMOSTRA_MINIMA_RECORTE) pra CONTRADIZER — nesse caso,
  //     não tem como saber se diverge, então o sinal do recorte segue
  //     valendo sozinho; OU
  // (b) existir dado de temporada com amostra suficiente E ele CONCORDAR
  //     (diferença <= DIVERGENCIA_MAXIMA_TAXA, 20pp) com o recorte recente.
  // Se a temporada existir, tiver amostra suficiente, E divergir — o sinal
  // do recorte pequeno é descartado (retorna false), mesmo que bata o
  // limiar do gate. Não é "ausência de confirmação penaliza"; é
  // "presença de CONTRADIÇÃO invalida".
  function recorteConfiavel(taxaRecorte, statsBloco, campoContagem, campoAmostraSeason) {
    if (taxaRecorte == null) return false;
    const amostraSeason = statsBloco?.[campoAmostraSeason] ?? 0;
    if (amostraSeason <= AMOSTRA_MINIMA_RECORTE) return true; // sem 2ª fonte suficiente pra contradizer
    const taxaSeason = taxaCampo(statsBloco, campoContagem, campoAmostraSeason);
    if (taxaSeason == null) return true;
    return Math.abs(taxaSeason - taxaRecorte) <= DIVERGENCIA_MAXIMA_TAXA;
  }

  // Gate 5 — amostra específica de escanteios, só pro mercado +8.5
  // Escanteios. Cobertura de escanteio na API-Football é mais pobre que
  // cobertura de gol (depende de endpoint separado por partida, ver
  // mediaEscanteios), então o campo pode vir com poucos jogos válidos mesmo
  // quando a amostra geral (Gate 1) está ok — o Gate 1 mede jogos_considerados
  // de gols, não de escanteios especificamente.
  if (mercado === '+8.5 Escanteios') {
    const escA = formaA?.escanteios?.jogos_considerados ?? null;
    const escB = formaB?.escanteios?.jogos_considerados ?? null;
    // Antes usava <= AMOSTRA_MINIMA_RECORTE (6), o que deixava passar com 7
    // jogos enquanto o texto do critério exige 8 — desalinhamento de
    // fronteira apontado na auditoria. Agora usa o mesmo piso do texto.
    if (escA == null || escB == null || escA < AMOSTRA_MINIMA_GERAL || escB < AMOSTRA_MINIMA_GERAL) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Amostra de escanteios insuficiente (mínimo ${AMOSTRA_MINIMA_GERAL} jogos com dado de escanteio disponível — Time A: ${escA ?? 'sem dado'}, Time B: ${escB ?? 'sem dado'}). Aprovação da IA foi revertida pelo código — Gate 5.`,
      ];
    }
  }

  // Gate 7 — de-vig de odds reais. NÃO BLOQUEANTE desde [data desta edição]:
  // por instrução explícita do Edson, a odd que vem da API-Football não é a
  // odd real com que a operação trabalha (é só referência/exibição) — não
  // deve interferir na aprovação/reprovação de nenhum sinal. Mantido como
  // alerta informativo (mesmo padrão do Gate 6, correlação de exposição):
  // ainda calcula a divergência e avisa no alerta, útil como contexto pro
  // trader, mas NUNCA mexe em result.aprovado ou result.score.
  //
  // Só roda quando "probabilidade_devigada" veio calculada (ver
  // buscarOddsReais em footballData.js — exige odd do complemento cotada,
  // nem toda casa lista os dois lados). Cobre só os 5 mercados de duas
  // pontas puras (Over/Under, BTTS); Dupla Chance e Lay Empate ficam de
  // fora por ora — Double Chance é mercado de 3 saídas sobrepostas, de-vig
  // correto exigiria o mercado Match Winner (1X2) à parte (ver Gate 8).
  const DIVERGENCIA_ODDS_MAXIMA = 15; // pontos percentuais — só usado pro texto do alerta agora, não reprova mais
  const probDevigada = dadosReais.odds_mercado_real?.probabilidade_devigada;
  if (probDevigada != null) {
    const divergencia = min - probDevigada;
    if (divergencia > DIVERGENCIA_ODDS_MAXIMA) {
      result.alertas = [
        ...(result.alertas || []),
        `[Informativo — não bloqueante] O mercado real de apostas precifica esse resultado em ${probDevigada}% de probabilidade (odd de-vigada, margem da casa removida), abaixo do mínimo de confiança exigido pra esse mercado (${min}%) — divergência de ${divergencia.toFixed(1)}pp. Isso NÃO afeta a aprovação (odd é só referência, não a odd real de operação) — Gate 7.`,
      ];
    }
  }

  // Gate 8 — de-vig via Match Winner (1X2), cobre Dupla Chance e Lay
  // Empate (o Gate 7 deixa esses dois de fora — ver comentário em
  // buscarOddsMatchWinner no footballData.js, Double Chance é mercado de
  // 3 saídas sobrepostas e não de-viga com o cálculo simples de 2 pontas).
  // Pra Dupla Chance, precisa saber qual lado a IA aprovou (lado_aprovado)
  // pra somar a probabilidade certa — por isso só roda AQUI, depois da IA
  // já ter respondido, nunca antes.
  //
  // Também NÃO BLOQUEANTE — mesmo motivo do Gate 7 (instrução explícita do
  // Edson).
  if (dadosReais.odds_1x2_devigada) {
    const { prob_devigada_home, prob_devigada_draw, prob_devigada_away } = dadosReais.odds_1x2_devigada;
    let probRelevante = null;
    if (mercado === 'Lay Empate') {
      probRelevante = 100 - prob_devigada_draw; // P(NÃO empate)
    } else if (mercado === 'Dupla Chance' && result.lado_aprovado === '1X') {
      probRelevante = prob_devigada_home + prob_devigada_draw;
    } else if (mercado === 'Dupla Chance' && result.lado_aprovado === 'X2') {
      probRelevante = prob_devigada_draw + prob_devigada_away;
    }
    if (probRelevante != null) {
      const divergencia = min - probRelevante;
      if (divergencia > DIVERGENCIA_ODDS_MAXIMA) {
        result.alertas = [
          ...(result.alertas || []),
          `[Informativo — não bloqueante] O mercado real (via Match Winner 1X2, de-vigado) precifica esse resultado em ${probRelevante.toFixed(1)}% de probabilidade, abaixo do mínimo de confiança exigido pra esse mercado (${min}%) — divergência de ${divergencia.toFixed(1)}pp. Isso NÃO afeta a aprovação (odd é só referência, não a odd real de operação) — Gate 8.`,
        ];
      }
    }
  }

  // Gate 9 — risco assimétrico de "time sem marcar" pro mercado +1.5 Gols.
  // O texto do critério em CRITERIOS_MERCADO['+1.5 Gols'] pedia (antes desta
  // correção) que AMBOS os times tivessem taxa alta de "jogos_sem_marcar_gol"
  // antes de reduzir o score — mas pra um mercado de total >= 2 gols, basta
  // UM dos dois lados falhar em marcar pra abrir caminho a um resultado de
  // 0 ou 1 gol total (0x0, 1x0, 0x1). Foi exatamente esse buraco que
  // aprovou o sinal Leiknir x Grotta: só o Leiknir tinha taxa alta (40% em
  // 10 jogos), o Grotta tinha 0%, e a IA tratou o 0% do Grotta como
  // "mitigador" do risco do Leiknir no texto do alerta — raciocínio que não
  // se sustenta, porque Grotta marcar não impede o placar de fechar 1x0 ou
  // 0x1. O texto do prompt já foi corrigido acima, mas seguindo o mesmo
  // racional de todos os outros gates desta função (instrução de texto
  // sozinha não garante comportamento — ver comentário no topo do arquivo),
  // este gate reforça em código, sem depender da IA aplicar a instrução
  // certo toda vez.
  //
  // Checa DUAS fontes: a taxa GERAL (forma_recente_time_a/b, sem separar
  // mando) E a taxa do recorte específico mando/visitante (Time A como
  // mandante, Time B como visitante — que é o mando REAL desse jogo). A
  // versão original deste gate só olhava a geral, com a justificativa de
  // que "o recorte já tem amostra mínima garantida pelo Gate 4" — mas
  // amostra mínima garantida não é o mesmo que RISCO CHECADO: o Gate 4 só
  // valida que o recorte tem jogos suficientes pra existir, não que a taxa
  // dele foi conferida contra o limiar de risco. Foi exatamente esse
  // buraco que deixou passar IR Reykjavik x Afturelding: taxa GERAL do
  // Afturelding era 10% (limpa), mas como VISITANTE especificamente (o
  // mando real do jogo) era 25% (1 em 4) — exatamente no limiar de risco,
  // e a taxa geral não capturou isso porque dilui o recorte relevante
  // dentro de uma amostra maior e mista (casa+fora).
  //
  // Amostra mínima pra essa checagem de recorte é 4 (não os 6 de
  // AMOSTRA_MINIMA_RECORTE) — escolha deliberada, não arbitrária: o caso
  // real que motivou essa correção tinha exatamente n=4. Usar o piso de 6
  // teria deixado passar o mesmo caso de novo. É um valor de partida, não
  // calibrado com dado real — ajustar depois pelo protocolo de calibração
  // de sempre, se a experiência mostrar que n=4 gera falso-positivo demais.
  //
  // Além do piso de amostra, exige convergência com a temporada inteira
  // (helper recorteConfiavel, mesma exigência do Gate 4) antes de aceitar
  // o risco do recorte sozinho — sem isso, dois sinais de amostra pequena
  // discordando entre si (recorte recente vs temporada) podiam empilhar e
  // reprovar sem nenhuma checagem cruzada. Foi exatamente esse buraco que
  // pegou o sinal Gais x Elfsborg no mercado +0.5 Gols (Gate 10, mesma
  // lógica) — corrigido aqui em conjunto.
  //
  // Ignorado em modo_copa: mando de campo pode não refletir vantagem real
  // em sede neutra (mesma exceção já aplicada em todo o resto do arquivo).
  if (mercado === '+1.5 Gols') {
    const LIMIAR_SEM_MARCAR = 0.25; // mesmo threshold já definido no critério do mercado
    const AMOSTRA_MINIMA_GATE_RECORTE = 4; // ver comentário acima — deliberadamente menor que AMOSTRA_MINIMA_RECORTE
    // Contagem mínima de eventos no recorte pequeno — correção da auditoria:
    // com n=4 e limiar de 25%, UM único jogo sem marcar já disparava o
    // risco. Só que a taxa populacional de "ficar sem marcar" de um time
    // mediano é ~25-30% — 1 branco em 4 jogos acontece com ~68% de chance
    // pra um time perfeitamente normal. Flagrar isso não é detectar risco,
    // é flagrar ruído. Exigir >= 2 eventos no recorte pequeno (50% em n=4)
    // separa padrão real de variância de amostra. A taxa GERAL (n=10)
    // continua no limiar de 25% (que ali já significa 3+ brancos).
    const CONTAGEM_MINIMA_RISCO_RECORTE = 2;

    const taxaSemMarcarA = taxaSemMarcar(formaA, 'jogos_considerados');
    const taxaSemMarcarB = taxaSemMarcar(formaB, 'jogos_considerados');
    const timeARisco = taxaSemMarcarA != null && taxaSemMarcarA >= LIMIAR_SEM_MARCAR;
    const timeBRisco = taxaSemMarcarB != null && taxaSemMarcarB >= LIMIAR_SEM_MARCAR;

    let timeARiscoRecorte = false, timeBRiscoRecorte = false, taxaMandanteA = null, taxaVisitanteB = null;
    if (!dadosReais.modo_copa) {
      const mandanteA = formaA?.como_mandante;
      const visitanteB = formaB?.como_visitante;
      taxaMandanteA = taxaCampo(mandanteA, 'jogos_sem_marcar_gol', 'jogos_considerados');
      taxaVisitanteB = taxaCampo(visitanteB, 'jogos_sem_marcar_gol', 'jogos_considerados');
      const amostraMandanteA = mandanteA?.jogos_considerados;
      const amostraVisitanteB = visitanteB?.jogos_considerados;
      const confiavelA = recorteConfiavel(taxaMandanteA, dadosReais.estatisticas_time_a?.como_mandante, 'jogos_sem_marcar_gol', 'jogos_disputados');
      const confiavelB = recorteConfiavel(taxaVisitanteB, dadosReais.estatisticas_time_b?.como_visitante, 'jogos_sem_marcar_gol', 'jogos_disputados');
      timeARiscoRecorte = taxaMandanteA != null && amostraMandanteA >= AMOSTRA_MINIMA_GATE_RECORTE &&
        (mandanteA?.jogos_sem_marcar_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
        taxaMandanteA >= LIMIAR_SEM_MARCAR && confiavelA;
      timeBRiscoRecorte = taxaVisitanteB != null && amostraVisitanteB >= AMOSTRA_MINIMA_GATE_RECORTE &&
        (visitanteB?.jogos_sem_marcar_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
        taxaVisitanteB >= LIMIAR_SEM_MARCAR && confiavelB;
    }

    if (timeARisco || timeBRisco || timeARiscoRecorte || timeBRiscoRecorte) {
      const partes = [];
      if (timeARisco) partes.push(`Time A sem marcar em ${(taxaSemMarcarA * 100).toFixed(0)}% dos jogos recentes (geral)`);
      if (timeBRisco) partes.push(`Time B sem marcar em ${(taxaSemMarcarB * 100).toFixed(0)}% dos jogos recentes (geral)`);
      if (timeARiscoRecorte) partes.push(`Time A sem marcar em ${(taxaMandanteA * 100).toFixed(0)}% dos jogos como mandante (confirmado pela temporada)`);
      if (timeBRiscoRecorte) partes.push(`Time B sem marcar em ${(taxaVisitanteB * 100).toFixed(0)}% dos jogos como visitante (confirmado pela temporada)`);
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Risco assimétrico de jogo com poucos gols: ${partes.join(' e ')} — suficiente pra ameaçar o Over 1.5 mesmo sem o outro time também ter taxa alta de jogos sem marcar (basta um lado falhar em marcar pra abrir caminho a 0x0, 1x0 ou 0x1). Aprovação da IA foi revertida pelo código — Gate 9.`,
      ];
    }
  }

  // Gate 10 — perfil de risco de 0x0 pro mercado +0.5 Gols. O critério do
  // mercado (CRITERIOS_MERCADO['+0.5 Gols']) já pede o texto certo: reprovar
  // se, em QUALQUER uma das duas direções, um time tiver ataque fraco
  // (jogos_sem_marcar_gol alto) contra um adversário de defesa sólida
  // (jogos_sem_sofrer_gol alto do outro lado) — essa combinação específica é
  // o perfil estatístico de jogo que termina 0x0. A lógica do texto já
  // estava certa (é um "casal" de condições ligado por OR entre as duas
  // direções, não um erro de AMBOS como o do Gate 9) — mas, como todo outro
  // gate desta função, texto sozinho não garante que a IA aplica em toda
  // chamada. Reforça em código pra fechar essa brecha antes que ela vire
  // red, igual foi feito pro +1.5 Gols.
  //
  // Mesma extensão aplicada ao Gate 9: checa também o recorte mando/
  // visitante específico (Time A como mandante, Time B como visitante),
  // não só a taxa geral — pelo mesmo motivo (taxa geral dilui um recorte
  // de risco real dentro de uma amostra maior e mista). Ignorado em
  // modo_copa. Amostra mínima 4 pro recorte, mesma justificativa do Gate 9.
  //
  // Também exige convergência com a temporada inteira (recorteConfiavel)
  // pra CADA UMA das duas taxas que compõem o "casal" de risco — não
  // basta uma bater o limiar, ela precisa não ser contradita pela
  // temporada. Caso real que expôs essa falta: Gais x Elfsborg. O Gate 10
  // reprovou empilhando Elfsborg (25% sem marcar como visitante, n=4) com
  // Gais (60% sem sofrer como mandante, n=5) — dois sinais isolados de
  // amostra pequena, SEM checar se algum deles divergia da temporada
  // inteira. O Gate 4 (mais acima nesse arquivo) já fazia essa checagem
  // pro próprio critério dele; os Gates 9-12 não faziam a mesma exigência.
  if (mercado === '+0.5 Gols') {
    const LIMIAR_0_5 = 0.25; // mesmo threshold já definido no critério do mercado
    const AMOSTRA_MINIMA_GATE_RECORTE = 4; // ver comentário no Gate 9
    const CONTAGEM_MINIMA_RISCO_RECORTE = 2; // ver comentário no Gate 9 — 1 evento em n=4 é ruído, não padrão

    const semMarcarA = taxaCampo(formaA, 'jogos_sem_marcar_gol', 'jogos_considerados');
    const semMarcarB = taxaCampo(formaB, 'jogos_sem_marcar_gol', 'jogos_considerados');
    const semSofrerA = taxaCampo(formaA, 'jogos_sem_sofrer_gol', 'jogos_considerados');
    const semSofrerB = taxaCampo(formaB, 'jogos_sem_sofrer_gol', 'jogos_considerados');

    // Direção 1 (geral): Time A ataca mal E Time B defende bem -> A tende a ficar sem marcar.
    const riscoA = semMarcarA != null && semSofrerB != null &&
      semMarcarA >= LIMIAR_0_5 && semSofrerB >= LIMIAR_0_5;
    // Direção 2 (geral): Time B ataca mal E Time A defende bem -> B tende a ficar sem marcar.
    const riscoB = semMarcarB != null && semSofrerA != null &&
      semMarcarB >= LIMIAR_0_5 && semSofrerA >= LIMIAR_0_5;

    // Direções equivalentes, agora no recorte de mando real do jogo.
    let riscoARecorte = false, riscoBRecorte = false;
    let semMarcarMandanteA = null, semSofrerVisitanteB = null, semMarcarVisitanteB = null, semSofrerMandanteA = null;
    if (!dadosReais.modo_copa) {
      const mandanteA = formaA?.como_mandante;
      const visitanteB = formaB?.como_visitante;
      semMarcarMandanteA = taxaCampo(mandanteA, 'jogos_sem_marcar_gol', 'jogos_considerados');
      semSofrerMandanteA = taxaCampo(mandanteA, 'jogos_sem_sofrer_gol', 'jogos_considerados');
      semMarcarVisitanteB = taxaCampo(visitanteB, 'jogos_sem_marcar_gol', 'jogos_considerados');
      semSofrerVisitanteB = taxaCampo(visitanteB, 'jogos_sem_sofrer_gol', 'jogos_considerados');
      const amostraMandanteA = mandanteA?.jogos_considerados;
      const amostraVisitanteB = visitanteB?.jogos_considerados;
      const amostraOk = amostraMandanteA >= AMOSTRA_MINIMA_GATE_RECORTE && amostraVisitanteB >= AMOSTRA_MINIMA_GATE_RECORTE;

      const statsMandanteA = dadosReais.estatisticas_time_a?.como_mandante;
      const statsVisitanteB = dadosReais.estatisticas_time_b?.como_visitante;
      const confiavelSemMarcarMandanteA = recorteConfiavel(semMarcarMandanteA, statsMandanteA, 'jogos_sem_marcar_gol', 'jogos_disputados');
      const confiavelSemSofrerMandanteA = recorteConfiavel(semSofrerMandanteA, statsMandanteA, 'jogos_sem_sofrer_gol', 'jogos_disputados');
      const confiavelSemMarcarVisitanteB = recorteConfiavel(semMarcarVisitanteB, statsVisitanteB, 'jogos_sem_marcar_gol', 'jogos_disputados');
      const confiavelSemSofrerVisitanteB = recorteConfiavel(semSofrerVisitanteB, statsVisitanteB, 'jogos_sem_sofrer_gol', 'jogos_disputados');

      riscoARecorte = amostraOk && semMarcarMandanteA != null && semSofrerVisitanteB != null &&
        semMarcarMandanteA >= LIMIAR_0_5 && semSofrerVisitanteB >= LIMIAR_0_5 &&
        (mandanteA?.jogos_sem_marcar_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
        (visitanteB?.jogos_sem_sofrer_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
        confiavelSemMarcarMandanteA && confiavelSemSofrerVisitanteB;
      riscoBRecorte = amostraOk && semMarcarVisitanteB != null && semSofrerMandanteA != null &&
        semMarcarVisitanteB >= LIMIAR_0_5 && semSofrerMandanteA >= LIMIAR_0_5 &&
        (visitanteB?.jogos_sem_marcar_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
        (mandanteA?.jogos_sem_sofrer_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
        confiavelSemMarcarVisitanteB && confiavelSemSofrerMandanteA;
    }

    if (riscoA || riscoB || riscoARecorte || riscoBRecorte) {
      const partes = [];
      if (riscoA) partes.push(`Time A sem marcar em ${(semMarcarA * 100).toFixed(0)}% (geral) contra Time B sem sofrer em ${(semSofrerB * 100).toFixed(0)}% (geral)`);
      if (riscoB) partes.push(`Time B sem marcar em ${(semMarcarB * 100).toFixed(0)}% (geral) contra Time A sem sofrer em ${(semSofrerA * 100).toFixed(0)}% (geral)`);
      if (riscoARecorte) partes.push(`Time A sem marcar em ${(semMarcarMandanteA * 100).toFixed(0)}% como mandante contra Time B sem sofrer em ${(semSofrerVisitanteB * 100).toFixed(0)}% como visitante (ambos confirmados pela temporada)`);
      if (riscoBRecorte) partes.push(`Time B sem marcar em ${(semMarcarVisitanteB * 100).toFixed(0)}% como visitante contra Time A sem sofrer em ${(semSofrerMandanteA * 100).toFixed(0)}% como mandante (ambos confirmados pela temporada)`);
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Perfil de risco de 0x0: ${partes.join('; ')} — combinação que o próprio critério do mercado já manda reduzir/reprovar. Aprovação da IA foi revertida pelo código — Gate 10.`,
      ];
    }
  }

  // Gate 11 — condição mínima obrigatória pro mercado BTTS Não. O critério
  // exige que exista PELO MENOS UM dos quatro sinais possíveis (ataque fraco
  // de A ou B, ou defesa sólida de A ou B) antes de aprovar — sem nenhum
  // deles, "não existe motivo estatístico real pra um dos lados ficar a
  // zero" (texto do próprio critério). Mesmo racional dos outros gates:
  // essa é uma condição NECESSÁRIA (não suficiente sozinha) que precisa ser
  // garantida em código, não só pedida em texto.
  //
  // Também aceita o recorte mando/visitante (Time A mandante, Time B
  // visitante) como fonte válida de sinal, não só a taxa geral — mesmo
  // racional do Gate 9/10: a taxa geral mistura jogos em casa e fora, e
  // pode diluir um sinal real que só aparece no recorte específico desse
  // jogo. Sem essa extensão, o gate reprovaria à toa um caso onde o sinal
  // de verdade está lá, só que escondido dentro de uma média maior e mista
  // — errar pro lado de reprovar aprovação legítima é tão ruim quanto
  // errar pro lado de aprovar risco real. Amostra mínima 4 pro recorte,
  // mesma justificativa do Gate 9. Ignorado em modo_copa.
  //
  // Exige convergência com a temporada (recorteConfiavel) antes de aceitar
  // o sinal do recorte como base válida — mesmo aqui, onde o recorte está
  // sendo usado pra JUSTIFICAR aprovação (não pra reprovar): um sinal
  // pequeno contradito pela temporada não deveria "salvar" uma aprovação
  // com a mesma força que um sinal confirmado salvaria. Consistência com
  // os Gates 9/10.
  if (mercado === 'BTTS Não') {
    const LIMIAR_BTTS = 0.30; // mesmo threshold já definido no critério do mercado
    const AMOSTRA_MINIMA_GATE_RECORTE = 4; // ver comentário no Gate 9
    const CONTAGEM_MINIMA_RISCO_RECORTE = 2; // ver comentário no Gate 9 — vale também quando o recorte JUSTIFICA aprovação: 1 clean sheet em 4 jogos não estabelece "defesa sólida"

    const semMarcarA = taxaCampo(formaA, 'jogos_sem_marcar_gol', 'jogos_considerados');
    const semMarcarB = taxaCampo(formaB, 'jogos_sem_marcar_gol', 'jogos_considerados');
    const semSofrerA = taxaCampo(formaA, 'jogos_sem_sofrer_gol', 'jogos_considerados');
    const semSofrerB = taxaCampo(formaB, 'jogos_sem_sofrer_gol', 'jogos_considerados');

    let temSinalRecorte = false;
    if (!dadosReais.modo_copa) {
      const mandanteA = formaA?.como_mandante;
      const visitanteB = formaB?.como_visitante;
      const amostraMandanteA = mandanteA?.jogos_considerados;
      const amostraVisitanteB = visitanteB?.jogos_considerados;
      const semMarcarMandanteA = taxaCampo(mandanteA, 'jogos_sem_marcar_gol', 'jogos_considerados');
      const semMarcarVisitanteB = taxaCampo(visitanteB, 'jogos_sem_marcar_gol', 'jogos_considerados');
      const semSofrerMandanteA = taxaCampo(mandanteA, 'jogos_sem_sofrer_gol', 'jogos_considerados');
      const semSofrerVisitanteB = taxaCampo(visitanteB, 'jogos_sem_sofrer_gol', 'jogos_considerados');

      const statsMandanteA = dadosReais.estatisticas_time_a?.como_mandante;
      const statsVisitanteB = dadosReais.estatisticas_time_b?.como_visitante;

      temSinalRecorte =
        (amostraMandanteA >= AMOSTRA_MINIMA_GATE_RECORTE && semMarcarMandanteA != null && semMarcarMandanteA >= LIMIAR_BTTS &&
          (mandanteA?.jogos_sem_marcar_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
          recorteConfiavel(semMarcarMandanteA, statsMandanteA, 'jogos_sem_marcar_gol', 'jogos_disputados')) ||
        (amostraVisitanteB >= AMOSTRA_MINIMA_GATE_RECORTE && semMarcarVisitanteB != null && semMarcarVisitanteB >= LIMIAR_BTTS &&
          (visitanteB?.jogos_sem_marcar_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
          recorteConfiavel(semMarcarVisitanteB, statsVisitanteB, 'jogos_sem_marcar_gol', 'jogos_disputados')) ||
        (amostraMandanteA >= AMOSTRA_MINIMA_GATE_RECORTE && semSofrerMandanteA != null && semSofrerMandanteA >= LIMIAR_BTTS &&
          (mandanteA?.jogos_sem_sofrer_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
          recorteConfiavel(semSofrerMandanteA, statsMandanteA, 'jogos_sem_sofrer_gol', 'jogos_disputados')) ||
        (amostraVisitanteB >= AMOSTRA_MINIMA_GATE_RECORTE && semSofrerVisitanteB != null && semSofrerVisitanteB >= LIMIAR_BTTS &&
          (visitanteB?.jogos_sem_sofrer_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
          recorteConfiavel(semSofrerVisitanteB, statsVisitanteB, 'jogos_sem_sofrer_gol', 'jogos_disputados'));
    }

    const temSinal =
      (semMarcarA != null && semMarcarA >= LIMIAR_BTTS) ||
      (semMarcarB != null && semMarcarB >= LIMIAR_BTTS) ||
      (semSofrerA != null && semSofrerA >= LIMIAR_BTTS) ||
      (semSofrerB != null && semSofrerB >= LIMIAR_BTTS) ||
      temSinalRecorte;

    if (!temSinal) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Nenhum dos dois times mostra sinal estatístico mínimo de possível 0x0 lado a lado (ataque fraco >= ${LIMIAR_BTTS * 100}% ou defesa sólida >= ${LIMIAR_BTTS * 100}%, em nenhum dos quatro cruzamentos, geral ou por recorte de mando/visitante). Sem esse sinal, não há base estatística real pra aprovar BTTS Não, segundo o próprio critério do mercado. Aprovação da IA foi revertida pelo código — Gate 11.`,
      ];
    }
  }

  // Gate 12 — condição mínima obrigatória pro mercado Under 3.5 Gols. O
  // critério exige que PELO MENOS UM dos dois times tenha taxa de "jogos
  // sem sofrer gol" >= 25% — capacidade defensiva real demonstrada em pelo
  // menos um lado, não só médias de gols marcados baixas (que podem ser
  // fruto de ataques fracos, não de defesas boas, e não sustentam Under
  // sozinhas com a mesma força). Mesma lógica dos outros gates: condição
  // necessária, garantida em código.
  //
  // Mesma extensão do Gate 11: também aceita o recorte mando/visitante
  // como fonte válida de sinal (defesa sólida do Time A como mandante ou
  // do Time B como visitante), não só a taxa geral — exigindo convergência
  // com a temporada (recorteConfiavel), mesma consistência.
  if (mercado === 'Under 3.5 Gols') {
    const LIMIAR_U35 = 0.25; // mesmo threshold já definido no critério do mercado
    const AMOSTRA_MINIMA_GATE_RECORTE = 4; // ver comentário no Gate 9
    const CONTAGEM_MINIMA_RISCO_RECORTE = 2; // ver comentário no Gate 9/11

    const semSofrerA = taxaCampo(formaA, 'jogos_sem_sofrer_gol', 'jogos_considerados');
    const semSofrerB = taxaCampo(formaB, 'jogos_sem_sofrer_gol', 'jogos_considerados');

    let temDefesaSolidaRecorte = false;
    if (!dadosReais.modo_copa) {
      const mandanteA = formaA?.como_mandante;
      const visitanteB = formaB?.como_visitante;
      const amostraMandanteA = mandanteA?.jogos_considerados;
      const amostraVisitanteB = visitanteB?.jogos_considerados;
      const semSofrerMandanteA = taxaCampo(mandanteA, 'jogos_sem_sofrer_gol', 'jogos_considerados');
      const semSofrerVisitanteB = taxaCampo(visitanteB, 'jogos_sem_sofrer_gol', 'jogos_considerados');

      const statsMandanteA = dadosReais.estatisticas_time_a?.como_mandante;
      const statsVisitanteB = dadosReais.estatisticas_time_b?.como_visitante;

      temDefesaSolidaRecorte =
        (amostraMandanteA >= AMOSTRA_MINIMA_GATE_RECORTE && semSofrerMandanteA != null && semSofrerMandanteA >= LIMIAR_U35 &&
          (mandanteA?.jogos_sem_sofrer_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
          recorteConfiavel(semSofrerMandanteA, statsMandanteA, 'jogos_sem_sofrer_gol', 'jogos_disputados')) ||
        (amostraVisitanteB >= AMOSTRA_MINIMA_GATE_RECORTE && semSofrerVisitanteB != null && semSofrerVisitanteB >= LIMIAR_U35 &&
          (visitanteB?.jogos_sem_sofrer_gol ?? 0) >= CONTAGEM_MINIMA_RISCO_RECORTE &&
          recorteConfiavel(semSofrerVisitanteB, statsVisitanteB, 'jogos_sem_sofrer_gol', 'jogos_disputados'));
    }

    const temDefesaSolida =
      (semSofrerA != null && semSofrerA >= LIMIAR_U35) ||
      (semSofrerB != null && semSofrerB >= LIMIAR_U35) ||
      temDefesaSolidaRecorte;

    if (!temDefesaSolida) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Nenhum dos dois times tem taxa de jogos sem sofrer gol >= ${LIMIAR_U35 * 100}% (geral ou por recorte de mando/visitante) — sem capacidade defensiva real demonstrada em pelo menos um dos lados, não há base estatística pra confiar em Under 3.5 Gols. Aprovação da IA foi revertida pelo código — Gate 12.`,
      ];
    }
  }

  // ── Gates 13-17: mesma lógica dos Gates 9-12, agora fechando os 3
  // mercados que tinham ZERO enforcement determinístico no critério
  // central (Lay 2x2, Dupla Chance, Lay Empate), mais o mascaramento de
  // média combinada em Escanteios. Até aqui, esses 3 mercados dependiam
  // 100% da IA aplicar o texto certo — a mesma classe de risco que já
  // gerou o red do Gate 9, só que ainda sem ter caído o caso que expõe.

  // Gate 13 — precedente de placar exato 2-2 no H2H pro mercado Lay 2x2.
  // O critério já pede pra reprovar "mesmo com bom perfil geral" quando
  // isso ocorre — reconfere em código porque é um dado objetivo (placar
  // exato, já vem pronto em "confrontos_diretos"), não uma questão de
  // julgamento que devesse ficar só com a IA.
  if (mercado === 'Lay 2x2') {
    const h2h = dadosReais.confrontos_diretos || [];
    const precedente2x2 = h2h.find(j => {
      if (j.dias_atras == null || j.dias_atras >= 730) return false;
      const partes = String(j.placar || '').split('-').map(s => parseInt(s, 10));
      return partes.length === 2 && Number.isFinite(partes[0]) && Number.isFinite(partes[1]) &&
        partes[0] === 2 && partes[1] === 2;
    });
    if (precedente2x2) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Precedente direto de 2-2 no H2H recente (${precedente2x2.dias_atras} dias atrás: ${precedente2x2.casa} ${precedente2x2.placar} ${precedente2x2.fora}) — o próprio critério do mercado manda reduzir bastante o score nesse caso, mesmo com bom perfil geral. Aprovação da IA foi revertida pelo código — Gate 13.`,
      ];
    }
  }

  // Gate 14 — contagem de derrotas do favorito no H2H pro mercado Dupla
  // Chance. O critério exige no máximo 1 derrota do favorito nos
  // confrontos diretos disponíveis; 2+ é "sinal de zebra recorrente" e
  // deve reprovar. Reconfere em código porque envolve cruzar 3 campos
  // (placar, mesmo_mando_atual, lado_aprovado) — exatamente o tipo de
  // aritmética que é fácil a IA errar silenciosamente numa resposta livre.
  if (mercado === 'Dupla Chance') {
    const favorito = result.lado_aprovado === '1X' ? 'A' : (result.lado_aprovado === 'X2' ? 'B' : null);
    if (favorito) {
      const h2h = dadosReais.confrontos_diretos || [];
      let derrotas = 0;
      const detalhes = [];
      for (const j of h2h) {
        // Filtro de recência adicionado na auditoria: os Gates 13 e 18-22 já
        // filtravam por dias_atras < 730, e a Regra 9 manda tratar H2H de 2+
        // anos como pouco confiável — mas este gate contava derrota de 4-5
        // anos atrás (elenco/técnico completamente diferentes) com o mesmo
        // peso de uma do mês passado. Consistência com o resto do sistema.
        if (j.dias_atras == null || j.dias_atras >= 730) continue;
        const partes = String(j.placar || '').split('-').map(s => parseInt(s, 10));
        if (partes.length !== 2 || !Number.isFinite(partes[0]) || !Number.isFinite(partes[1])) continue;
        const [golsCasa, golsFora] = partes;
        const timeCasa = j.mesmo_mando_atual ? 'A' : 'B';
        const timeFora = j.mesmo_mando_atual ? 'B' : 'A';
        const vencedor = golsCasa > golsFora ? timeCasa : (golsCasa < golsFora ? timeFora : null);
        if (vencedor && vencedor !== favorito) {
          derrotas++;
          detalhes.push(`${j.casa} ${j.placar} ${j.fora}`);
        }
      }
      if (derrotas >= 2) {
        result.aprovado = false;
        result.score = Math.min(result.score, min - 1);
        result.alertas = [
          ...(result.alertas || []),
          `[Enforcement automático] Favorito (Time ${favorito}, lado aprovado "${result.lado_aprovado}") tem ${derrotas} derrota(s) nos confrontos diretos dos últimos 2 anos — ${detalhes.join('; ')}. Sinal de zebra recorrente que o próprio critério do mercado manda reduzir fortemente. Aprovação da IA foi revertida pelo código — Gate 14.`,
        ];
      }
    }
  }

  // Gate 15 — soma das médias de gols marcados pro mercado Lay Empate. O
  // critério exige soma >= 2.4; reconfere em código pra não depender da
  // IA fazer a soma certo (mesmo princípio do Gate 9 pro +1.5 Gols, que
  // também tem exigência de soma mínima).
  if (mercado === 'Lay Empate') {
    const mediaA = formaA?.media_gols_marcados ?? null;
    const mediaB = formaB?.media_gols_marcados ?? null;
    if (mediaA != null && mediaB != null) {
      const soma = mediaA + mediaB;
      if (soma < 2.4) {
        result.aprovado = false;
        result.score = Math.min(result.score, min - 1);
        result.alertas = [
          ...(result.alertas || []),
          `[Enforcement automático] Soma das médias de gols marcados (${soma.toFixed(2)}) abaixo do mínimo exigido pelo critério do mercado (2.4). Aprovação da IA foi revertida pelo código — Gate 15.`,
        ];
      }
    }

    // Gate 16 — contagem de empates no H2H, mesmo mercado (Lay Empate). O
    // critério permite no máximo 2 empates nos confrontos diretos
    // disponíveis; 3+ é sinal forte de tendência ao empate NESSE confronto
    // específico e deve reprovar, mesmo com boa soma de gols.
    const h2h = dadosReais.confrontos_diretos || [];
    let empates = 0;
    for (const j of h2h) {
      // Mesmo filtro de recência do Gate 14 (ver comentário lá) — empate de
      // 4-5 anos atrás não caracteriza "tendência ao empate" desse confronto
      // hoje, com elencos diferentes.
      if (j.dias_atras == null || j.dias_atras >= 730) continue;
      const partes = String(j.placar || '').split('-').map(s => parseInt(s, 10));
      if (partes.length === 2 && Number.isFinite(partes[0]) && Number.isFinite(partes[1]) && partes[0] === partes[1]) {
        empates++;
      }
    }
    if (empates >= 3) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] ${empates} empates nos confrontos diretos dos últimos 2 anos — sinal forte de tendência ao empate nesse confronto específico, acima do máximo permitido pelo critério do mercado (2). Aprovação da IA foi revertida pelo código — Gate 16.`,
      ];
    }
  }

  // Gate 17 — volume de escanteios: média combinada mínima E piso
  // individual por time, pro mercado +8.5 Escanteios. O piso individual
  // fecha o mascaramento de média combinada (um time fraco puxado pra cima
  // só pelo número do adversário — mesmo tipo de mascaramento que o Gate 9
  // corrigiu pra gols). Usa dado que JÁ existe (cada time tem seu
  // "escanteios.media_escanteios" próprio em forma_recente_time_a/b) — não
  // precisa de nenhuma chamada de API nova. Valores atuais recalibrados na
  // auditoria de julho/2026 (ver comentário dentro do bloco); ajustar de
  // novo quando houver amostra resolvida suficiente, pelo protocolo de
  // calibração de sempre.
  if (mercado === '+8.5 Escanteios') {
    // Thresholds recalibrados na auditoria de julho/2026: escanteios têm
    // desvio-padrão típico de ~3.5/jogo, então média combinada 9.5 implica
    // só ~61% de P(>=9) — pouco mais que cara ou coroa, num mercado com
    // mínimo declarado de 85. Média combinada ~11.5-12 é o necessário pra
    // ~80-84%. O piso individual (antes 7.5) sobe na mesma proporção. O
    // veto pela COMBINADA também virou determinístico — antes só existia no
    // texto do prompt, o único dos thresholds numéricos objetivos desse
    // mercado sem reconferência em código.
    const LIMIAR_INDIVIDUAL_ESCANTEIOS = 9.0;
    const LIMIAR_COMBINADO_ESCANTEIOS = 11.5;
    const mediaEscA = formaA?.escanteios?.media_escanteios ?? null;
    const mediaEscB = formaB?.escanteios?.media_escanteios ?? null;
    const mediaCombinada = (mediaEscA != null && mediaEscB != null)
      ? +((mediaEscA + mediaEscB) / 2).toFixed(2)
      : null;

    const riscoA = mediaEscA != null && mediaEscA < LIMIAR_INDIVIDUAL_ESCANTEIOS;
    const riscoB = mediaEscB != null && mediaEscB < LIMIAR_INDIVIDUAL_ESCANTEIOS;
    const riscoCombinado = mediaCombinada != null && mediaCombinada < LIMIAR_COMBINADO_ESCANTEIOS;

    if (riscoA || riscoB || riscoCombinado) {
      const partes = [];
      if (riscoCombinado) partes.push(`média combinada de ${mediaCombinada} escanteios/jogo (mínimo ${LIMIAR_COMBINADO_ESCANTEIOS})`);
      if (riscoA) partes.push(`Time A com média própria de ${mediaEscA} escanteios/jogo (piso individual ${LIMIAR_INDIVIDUAL_ESCANTEIOS})`);
      if (riscoB) partes.push(`Time B com média própria de ${mediaEscB} escanteios/jogo (piso individual ${LIMIAR_INDIVIDUAL_ESCANTEIOS})`);
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Volume de escanteios insuficiente pra sustentar Over 8.5 com a confiança exigida: ${partes.join('; ')}. Com o desvio-padrão típico de escanteios (~3.5/jogo), média combinada abaixo de ${LIMIAR_COMBINADO_ESCANTEIOS} não sustenta ${min}% de probabilidade. Aprovação da IA foi revertida pelo código — Gate 17.`,
      ];
    }
  }

  // Gate 18 — precedente de H2H mais recente/relevante contradizendo
  // diretamente o critério central, pros mercados de 1º tempo. Caso real
  // que motivou isso: Vancouver FC x York United, mercado -2.5 Gols 1T. O
  // histórico geral (10 jogos, 100% de taxa de 1T baixo) sustentou a
  // aprovação, mas o confronto direto MAIS RECENTE com o MESMO MANDO do
  // jogo analisado (Vancouver em casa, 285 dias atrás) terminou 2-1 no 1T
  // — 3 gols, quebrando direto o critério. A própria IA identificou isso
  // no texto do alerta ("É o dado H2H mais relevante e deve ser pesado com
  // atenção") e aprovou mesmo assim, porque no fim das contas é ela quem
  // pondera holisticamente entre "10 jogos dizendo uma coisa" e "1 H2H
  // dizendo outra" — e nesse caso ponderou errado. Esse gate não deixa
  // isso na mão do julgamento holístico: se o H2H mais recente E mais
  // relevante (mesmo mando, dentro de 730 dias) contradiz o critério
  // central do mercado, reprova, ponto — sem "mas o geral diz outra
  // coisa" pesando contra.
  //
  // "confrontos_diretos" já vem ordenado do mais recente pro mais antigo
  // (ver h2hResumido em footballData.js), então o primeiro item que bate
  // mesmo_mando_atual + tem placar_1t + está dentro de 730 dias É o mais
  // recente/relevante por definição — não precisa reordenar.
  // REESTRUTURADO na auditoria de julho/2026: a força de evidência de UM
  // precedente de H2H depende da taxa base do evento contraditório. Um 1T
  // com 3+ gols acontece em ~10% dos jogos — ver um no H2H recente é
  // evidência genuína (mantém veto com n=1). Já um 1T 0x0 acontece em
  // ~25-30% dos jogos — um único precedente é evidência fraca, e vetar por
  // ele é descartar sinal legítimo por um evento comum. Pra esse caso, o
  // veto agora exige 2 contradições entre os até 3 H2H recentes (mesma
  // lógica dos Gates 19/21/22 abaixo).
  if (mercado === '-2.5 Gols 1T') {
    const h2h = dadosReais.confrontos_diretos || [];
    const maisRecenteMesmoMando = h2h.find(j =>
      j.mesmo_mando_atual === true &&
      j.placar_1t &&
      j.dias_atras != null && j.dias_atras < 730
    );

    if (maisRecenteMesmoMando) {
      const partes = String(maisRecenteMesmoMando.placar_1t).split('-').map(s => parseInt(s, 10));
      if (partes.length === 2 && Number.isFinite(partes[0]) && Number.isFinite(partes[1])) {
        const totalGols1T = partes[0] + partes[1];
        if (totalGols1T >= 3) {
          result.aprovado = false;
          result.score = Math.min(result.score, min - 1);
          result.alertas = [
            ...(result.alertas || []),
            `[Enforcement automático] O confronto direto mais recente com o mesmo mando de campo (${maisRecenteMesmoMando.dias_atras} dias atrás: ${maisRecenteMesmoMando.casa} ${maisRecenteMesmoMando.placar_1t} ${maisRecenteMesmoMando.fora} no 1T) contradiz diretamente o critério do mercado — precisa de no máximo 2 gols no 1T, mas teve ${totalGols1T}. 1T com 3+ gols é um evento raro (~10% dos jogos), então esse precedente específico sozinho já é motivo de reprovação. Aprovação da IA foi revertida pelo código — Gate 18.`,
          ];
        }
      }
    }
  }

  if (mercado === '+0.5 Gols 1T') {
    const c = contradicoesH2HRecentes(dadosReais, true, p => p.total === 0);
    if (c.contradicoes >= 2) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] ${c.contradicoes} dos ${c.considerados} confrontos diretos recentes (últimos 2 anos) tiveram 1º tempo 0x0 (${c.exemplos.join('; ')}) — padrão recorrente contradizendo o critério do mercado, não caso isolado. Aprovação da IA foi revertida pelo código — Gate 18.`,
      ];
    }
  }

  // ── Gates 19-22: veto por padrão recorrente no H2H recente. REESTRUTURADO
  // na auditoria de julho/2026: a versão anterior vetava com base num ÚNICO
  // H2H (o mais recente de mesmo mando), calibrada a partir de UM red
  // (Vancouver x York) — exatamente a classe de "aprender com caso isolado"
  // que o resto do sistema (recorteConfiavel, pisos de amostra) existe pra
  // evitar. O problema é a taxa base dos eventos contraditórios:
  //   - jogo com 0-1 gol total: ~25% dos jogos (Gate 19)
  //   - jogo com 4+ gols: ~22% dos jogos (Gate 21)
  //   - ambos marcando (BTTS sim): ~50% dos jogos (Gate 22!)
  // Com taxa base de 50%, o Gate 22 antigo reprovava por cara ou coroa:
  // metade dos sinais legítimos de BTTS Não com H2H recente de mesmo mando
  // era vetada por um evento que acontece em metade dos jogos de futebol.
  // A regra nova: só veta quando >= 2 dos até 3 H2H recentes (dias_atras
  // < 730, QUALQUER mando — exigir 2 já dá a robustez que o filtro de
  // mando tentava dar com n=1, e usar qualquer mando aumenta a amostra)
  // contradizem o critério central. Um precedente isolado deixa de vetar;
  // um PADRÃO recorrente continua vetando. Eventos raros (2-2 no Gate 13,
  // 0x0 no Gate 20, 3+ gols de 1T no Gate 18) mantêm o veto com n=1 —
  // nesses, um único precedente É evidência estatística real.
  //
  // Funções auxiliares únicas, reaproveitadas nos gates — evitam duplicar
  // a mesma extração/parse de placar várias vezes.
  function h2hMaisRecenteMesmoMando(dadosReais) {
    const h2h = dadosReais.confrontos_diretos || [];
    return h2h.find(j =>
      j.mesmo_mando_atual === true &&
      j.placar &&
      j.dias_atras != null && j.dias_atras < 730
    );
  }
  function totalGolsPlacar(placar) {
    const partes = String(placar || '').split('-').map(s => parseInt(s, 10));
    if (partes.length !== 2 || !Number.isFinite(partes[0]) || !Number.isFinite(partes[1])) return null;
    return { golsCasa: partes[0], golsFora: partes[1], total: partes[0] + partes[1] };
  }
  // Conta quantos dos até 3 H2H recentes (< 730 dias, qualquer mando)
  // contradizem o critério, segundo o teste passado. usa1T = true lê
  // placar_1t em vez do placar final. "confrontos_diretos" já vem ordenado
  // do mais recente pro mais antigo (ver h2hResumido em footballData.js).
  function contradicoesH2HRecentes(dadosReais, usa1T, testaContradicao, maxJogos = 3) {
    const h2h = dadosReais.confrontos_diretos || [];
    const recentes = h2h
      .filter(j => j.dias_atras != null && j.dias_atras < 730 && (usa1T ? j.placar_1t : j.placar))
      .slice(0, maxJogos);
    let contradicoes = 0;
    const exemplos = [];
    for (const j of recentes) {
      const p = totalGolsPlacar(usa1T ? j.placar_1t : j.placar);
      if (!p) continue;
      if (testaContradicao(p)) {
        contradicoes++;
        exemplos.push(`${j.casa} ${usa1T ? j.placar_1t + ' (1T)' : j.placar} ${j.fora}, ${j.dias_atras} dias atrás`);
      }
    }
    return { contradicoes, considerados: recentes.length, exemplos };
  }

  // Gate 19 — +1.5 Gols: padrão recorrente de jogos com menos de 2 gols no
  // H2H recente (ver racional do bloco acima — evento com taxa base ~25%,
  // um precedente isolado não veta mais; 2 de 3 vetam).
  if (mercado === '+1.5 Gols') {
    const c = contradicoesH2HRecentes(dadosReais, false, p => p.total < 2);
    if (c.contradicoes >= 2) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] ${c.contradicoes} dos ${c.considerados} confrontos diretos recentes (últimos 2 anos) terminaram com menos de 2 gols (${c.exemplos.join('; ')}) — padrão recorrente contradizendo o critério do mercado, não caso isolado. Aprovação da IA foi revertida pelo código — Gate 19.`,
      ];
    }
  }

  // Gate 20 — +0.5 Gols: H2H mais recente/mesmo mando com 0x0 contradiz
  // diretamente o mercado (precisa >= 1 gol).
  if (mercado === '+0.5 Gols') {
    const precedente = h2hMaisRecenteMesmoMando(dadosReais);
    if (precedente) {
      const p = totalGolsPlacar(precedente.placar);
      if (p && p.total === 0) {
        result.aprovado = false;
        result.score = Math.min(result.score, min - 1);
        result.alertas = [
          ...(result.alertas || []),
          `[Enforcement automático] O confronto direto mais recente com o mesmo mando de campo (${precedente.dias_atras} dias atrás: ${precedente.casa} ${precedente.placar} ${precedente.fora}) terminou 0x0 — contradiz diretamente o critério do mercado (precisa de pelo menos 1 gol). Aprovação da IA foi revertida pelo código — Gate 20.`,
        ];
      }
    }
  }

  // Gate 21 — Under 3.5 Gols: padrão recorrente de jogos com 4+ gols no H2H
  // recente (taxa base ~22% — mesma migração de n=1 pra 2-de-3 do Gate 19).
  if (mercado === 'Under 3.5 Gols') {
    const c = contradicoesH2HRecentes(dadosReais, false, p => p.total >= 4);
    if (c.contradicoes >= 2) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] ${c.contradicoes} dos ${c.considerados} confrontos diretos recentes (últimos 2 anos) terminaram com 4+ gols (${c.exemplos.join('; ')}) — padrão recorrente contradizendo o critério do mercado, não caso isolado. Aprovação da IA foi revertida pelo código — Gate 21.`,
      ];
    }
  }

  // Gate 22 — BTTS Não: padrão recorrente de "ambos marcam" no H2H recente.
  // Esse era o pior caso da versão n=1: BTTS SIM acontece em ~50% dos jogos
  // de futebol, então vetar por UM precedente era literalmente reprovar por
  // cara ou coroa. Agora exige 2 de 3 — só o padrão recorrente veta.
  if (mercado === 'BTTS Não') {
    const c = contradicoesH2HRecentes(dadosReais, false, p => p.golsCasa >= 1 && p.golsFora >= 1);
    if (c.contradicoes >= 2) {
      result.aprovado = false;
      result.score = Math.min(result.score, min - 1);
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] ${c.contradicoes} dos ${c.considerados} confrontos diretos recentes (últimos 2 anos) tiveram os dois times marcando (${c.exemplos.join('; ')}) — padrão recorrente de BTTS SIM nesse confronto específico, não caso isolado. Aprovação da IA foi revertida pelo código — Gate 22.`,
      ];
    }
  }

  // ── Gates 24-25: enforcement determinístico das somas de médias de gols
  // pros mercados +1.5 Gols e Under 3.5 Gols. Inconsistência criada pela
  // própria rodada de recalibração de julho/2026: os thresholds novos
  // (soma >= 3.0 e soma <= 2.1) foram atualizados no TEXTO do critério, mas
  // só o Lay Empate tinha a soma reconferida em código (Gate 15) — os
  // outros dois dependiam da IA aplicar o número certo toda vez, exatamente
  // a classe de risco que motivou todos os outros gates deste arquivo
  // (instrução de texto sozinha não garante comportamento). Mesma fonte de
  // dado do Gate 15 (forma_recente geral), mesmo padrão de veto.

  // Gate 24 — +1.5 Gols: soma das médias de gols marcados >= 3.0.
  if (mercado === '+1.5 Gols') {
    const mediaA = formaA?.media_gols_marcados ?? null;
    const mediaB = formaB?.media_gols_marcados ?? null;
    if (mediaA != null && mediaB != null) {
      const soma = mediaA + mediaB;
      if (soma < 3.0) {
        result.aprovado = false;
        result.score = Math.min(result.score, min - 1);
        result.alertas = [
          ...(result.alertas || []),
          `[Enforcement automático] Soma das médias de gols marcados (${soma.toFixed(2)}) abaixo do mínimo exigido pelo critério do mercado (3.0) — sob Poisson, soma abaixo disso não sustenta os ${min}% de confiança exigidos pra Over 1.5. Aprovação da IA foi revertida pelo código — Gate 24.`,
        ];
      }
    }
  }

  // Gate 25 — Under 3.5 Gols: soma das médias de gols marcados <= 2.1.
  if (mercado === 'Under 3.5 Gols') {
    const mediaA = formaA?.media_gols_marcados ?? null;
    const mediaB = formaB?.media_gols_marcados ?? null;
    if (mediaA != null && mediaB != null) {
      const soma = mediaA + mediaB;
      if (soma > 2.1) {
        result.aprovado = false;
        result.score = Math.min(result.score, min - 1);
        result.alertas = [
          ...(result.alertas || []),
          `[Enforcement automático] Soma das médias de gols marcados (${soma.toFixed(2)}) acima do máximo permitido pelo critério do mercado (2.1) — sob Poisson, soma acima disso não sustenta os ${min}% de confiança exigidos pra Under 3.5. Aprovação da IA foi revertida pelo código — Gate 25.`,
        ];
      }
    }
  }

  // Gate 23 — baseline Poisson (INFORMATIVO, não bloqueante). Compara a
  // probabilidade estimada pelo modelo determinístico (ver
  // lib/poissonBaseline.js) com o mínimo de confiança do mercado. Quando o
  // baseline fica 10pp+ abaixo do mínimo num sinal APROVADO, anexa alerta —
  // não reverte nada por ora: está em fase de coleta. O baseline vai junto
  // no dados_reais_snapshot de toda análise; depois de 15+ resolvidos
  // (protocolo de calibração de sempre), compara-se baseline vs resultado
  // real pra decidir se ele vira gate bloqueante e com qual margem.
  const baseline = dadosReais.baseline_poisson;
  if (result.aprovado && baseline) {
    let probBaseline = baseline.probabilidade_estimada ?? null;
    if (mercado === 'Dupla Chance') {
      probBaseline = result.lado_aprovado === '1X'
        ? (baseline.prob_1x ?? null)
        : (result.lado_aprovado === 'X2' ? (baseline.prob_x2 ?? null) : null);
    }
    if (probBaseline != null && (min - probBaseline) > 10) {
      result.alertas = [
        ...(result.alertas || []),
        `[Informativo — não bloqueante] O baseline estatístico (Poisson sobre as médias de ataque/defesa dos dois times, fonte: ${baseline.fonte}) estima ${probBaseline}% de probabilidade pra esse mercado — ${(min - probBaseline).toFixed(1)}pp abaixo do mínimo de confiança exigido (${min}%). Isso NÃO afeta a aprovação por ora (em fase de calibração), mas é um sinal de que os dados médios sustentam menos confiança do que o score declara — Gate 23.`,
      ];
    }
  }
}

// Gate 6 — correlação de exposição: mais de um sinal APROVADO no mesmo dia
// (UTC) pro mesmo usuário, no mesmo confronto — comparado por ID de time
// resolvido na API-Football, não por texto (evita falso-negativo por
// variação de grafia: "Flamengo" e "Flamengo RJ" resolvem pro mesmo
// id_time_a). NÃO-bloqueante por design: dois sinais aprovados no mesmo
// jogo (ex: +0.5 Gols e Dupla Chance no mesmo confronto) podem ser
// estatisticamente válidos cada um isoladamente — o problema não é a
// validade do sinal, é que ambos dependem do MESMO evento acontecer do
// jeito esperado, então o stake combinado nos dois não é duas apostas
// independentes, é uma exposição só, maior do que parece. Por isso vira
// alerta explícito no resultado, nunca reprovação automática — quem
// decide o dimensionamento é você, isso só garante que você VEJA a
// correlação antes de decidir.
//
// Limitações conhecidas, aceitas de propósito (mesmo padrão de disclosure
// já usado nos outros gates):
// - Corte por dia UTC, não BRT — pode partir uma mesma sessão de apostas
//   (à noite, horário de Brasília) em duas datas UTC diferentes. Se isso
//   incomodar na prática, é uma troca de 1 linha (comparar em horário de
//   Brasília em vez de UTC), mas não fiz por padrão pra não inventar
//   requisito que você não pediu.
// - Não é atômico: duas análises quase simultâneas do mesmo confronto
//   podem não se enxergarem (ambas leem antes de qualquer insert
//   terminar). Mitigado — roda o mais tarde possível, em paralelo com a
//   chamada à IA, não no início da requisição — mas não eliminado.
async function verificarExposicaoCorrelacionada(userId, idTimeA, idTimeB) {
  if (idTimeA == null || idTimeB == null) return null; // sem ID resolvido, não dá pra comparar com segurança
  try {
    const db = getSupabaseAdmin();
    const hojeUTC = new Date().toISOString().slice(0, 10);
    const { data, error } = await db.from('analises_historico')
      .select('mercado, id_time_a, id_time_b')
      .eq('user_id', userId)
      .eq('aprovado', true)
      .gte('analisado_em', `${hojeUTC}T00:00:00.000Z`)
      .lt('analisado_em', `${hojeUTC}T23:59:59.999Z`);
    if (error || !data) return null;
    const mesmoConfronto = data.filter(d =>
      (d.id_time_a === idTimeA && d.id_time_b === idTimeB) ||
      (d.id_time_a === idTimeB && d.id_time_b === idTimeA)
    );
    return mesmoConfronto.length > 0 ? mesmoConfronto.map(d => d.mercado) : null;
  } catch (e) {
    logErro('exposicao_correlacionada', { idTimeA, idTimeB }, e);
    return null;
  }
}

// Loga toda análise real (não-demo, sem erro) numa tabela própria,
// independente do usuário ter pegado, passado, ou nem decidido nada ainda —
// é o dado que falta pra calibrar o sistema com o universo completo de
// sinais, não só com os que foram escolhidos pra apostar.
async function registrarHistoricoAnalise(userId, jogo, mercado, result, min, dadosReais) {
  const db = getSupabaseAdmin();
  const { error } = await db.from('analises_historico').insert({
    user_id: userId,
    evento: result.evento || jogo,
    competicao: result.competicao || null,
    mercado,
    score: result.score,
    min_score: min,
    aprovado: !!result.aprovado,
    criterios_ok: result.criterios_atendidos || [],
    criterios_no: result.criterios_nao_atendidos || [],
    alertas: result.alertas || [],
    // Necessários pro cron de resolução automática (ver
    // /api/cron/resolver-resultados) conseguir, dias depois, buscar o
    // placar real desse jogo específico sem depender de marcação manual.
    fixture_id: dadosReais?.fixture_id || null,
    data_jogo: dadosReais?.data_jogo || null,
    time_a: dadosReais?.time_a || null,
    time_b: dadosReais?.time_b || null,
    // IDs resolvidos dos times — ver Gate 6 (verificarExposicaoCorrelacionada).
    // Precisa rodar supabase/migration_gate6.sql antes disso funcionar.
    id_time_a: dadosReais?.id_time_a ?? null,
    id_time_b: dadosReais?.id_time_b ?? null,
    // Só relevante pra "Dupla Chance" — ver Regra 13 do system prompt.
    // Sem isso, "Dupla Chance" nunca pode ser resolvida automaticamente.
    lado_aprovado: result.lado_aprovado || null,
    // Sinais de qualidade de dado (Gate 0/Gate 2) — persistidos pra permitir
    // calibrar depois se esses sinais de fato preveem red, e se o Gate 2
    // está prevenindo a recorrência dos reds em ligas de baixa cobertura
    // que motivaram sua criação. Ver result._sinaisQualidade em
    // aplicarEnforcementDeterministico.
    match_exato_a: result._sinaisQualidade?.match_exato_a ?? null,
    match_exato_b: result._sinaisQualidade?.match_exato_b ?? null,
    odd_real_ausente: result._sinaisQualidade?.odd_real_ausente ?? null,
    crosscheck_temporada_ausente: result._sinaisQualidade?.crosscheck_temporada_ausente ?? null,
    h2h_fraco: result._sinaisQualidade?.h2h_fraco ?? null,
    sinais_fracos_count: result._sinaisQualidade?.sinais_fracos_count ?? null,
    // Snapshot do dado bruto usado nessa análise — ver comentário na
    // migration_dados_reais_snapshot.sql / schema.sql. dadosReais aqui já
    // é o objeto enxuto (sem _jogos_recentes_brutos, removido em
    // footballData.js antes de chegar aqui), o mesmo que foi pro prompt da
    // IA — não uma cópia maior/diferente.
    dados_reais_snapshot: dadosReais || null,
  });
  if (error) throw error;
}

function demoResult(jogo, mercado, motivo) {
  const min = MERCADOS[mercado]?.min || 82;
  const score = min + Math.floor(Math.random() * 15);
  const motivoFinal = motivo || 'Configure ANTHROPIC_API_KEY para análise real';
  return {
    evento: jogo,
    competicao: 'Modo Demo',
    score,
    aprovado: score >= min,
    odds_estimada: '1.20',
    probabilidade_real: 72 + Math.floor(Math.random() * 18),
    criterios_atendidos: ['H2H favorável', 'Forma recente positiva'],
    criterios_nao_atendidos: [],
    alertas: [motivoFinal],
    insight: `Análise em modo demonstração. ${motivoFinal}.`,
    resumo: `Resultado simulado, não use pra decisão real. Motivo: ${motivoFinal}.`,
    _minScore: min,
    _demo: true,
  };
}

function montarSystemPrompt() {
  return `Você é um analista estatístico de apostas esportivas, rigoroso e conservador. Siga estas regras de forma inegociável:

1. Use SOMENTE os dados fornecidos no bloco "DADOS" abaixo. Nunca invente médias, placares de confrontos diretos, ou estatísticas que não estejam explicitamente presentes nos dados.
2. Se um campo de dados estiver nulo, ausente, ou marcado como indisponível, trate-o como informação que você NÃO TEM — não preencha com suposição genérica.
3. Quanto menos dados reais disponíveis, menor deve ser o "score" e o "probabilidade_real", e isso deve ser explicado em "alertas". Análise sem dados suficientes deve tender a "aprovado": false.
4. Os campos "criterios_atendidos" e "criterios_nao_atendidos" devem citar números concretos vindos dos dados (ex: "média de 1.8 gols marcados em 10 jogos"), nunca frases vagas como "boa forma" sem número de apoio.
5. Se os dados estiverem totalmente indisponíveis, diga isso claramente no "insight" e no "resumo", e ainda assim responda apenas com o JSON pedido.
6. Se a mensagem do usuário incluir um bloco "CRITÉRIOS ESPECÍFICOS DESTE MERCADO", esses critérios têm prioridade sobre seu julgamento genérico. Eles definem exatamente o que torna esse mercado estatisticamente confiável — verifique cada condição explicitamente contra os dados e cite no "criterios_atendidos"/"criterios_nao_atendidos" quais delas foram ou não satisfeitas, com o número real que comprova. Se uma condição obrigatória desses critérios não for satisfeita, o score deve cair abaixo do mínimo, independentemente de outros sinais favoráveis.
7. Os dados trazem duas fontes de estatística por time: "estatisticas_time_a/b" (presa à competição/temporada do próximo jogo do time) e "forma_recente_time_a/b" (últimos jogos do time em qualquer competição). Se "estatisticas_time_a/b" tiver amostra pequena (jogos_disputados <= 2) ou estiver nula, use "forma_recente_time_a/b" como base principal da análise — ela tem mais jogos de apoio e reflete melhor o nível atual do time. Cite explicitamente qual das duas fontes você usou e por quê.
8. Convenção do confronto: no formato "Time A vs Time B", Time A é o mandante (joga em casa) e Time B é o visitante nesse jogo específico. "forma_recente_time_a/b" traz subcampos "como_mandante" e "como_visitante" — priorize "como_mandante" do Time A e "como_visitante" do Time B sobre a média geral misturada, pois mando de campo é um efeito real no futebol. "estatisticas_time_a/b" (quando disponível) TAMBÉM traz seus próprios "como_mandante"/"como_visitante" — é uma segunda fonte, presa à temporada atual, mas com amostra geralmente maior. Use as duas como cross-check: se ambas apontam na mesma direção, isso reforça a confiança; se divergem bastante, mencione isso no "insight" em vez de ignorar a discrepância. Quando o recorte de mando de "forma_recente" tiver amostra pequena (poucos jogos em casa ou fora nos últimos 10), dê peso extra ao de "estatisticas_time_a/b" se a amostra dele for maior. Em "confrontos_diretos", dê mais peso aos jogos com "mesmo_mando_atual": true (mesmo mando de campo do confronto atual) do que aos com mando invertido. Se "ultimos_5" divergir muito de "ultimos_10"/geral (ex: time que vinha bem mas piorou nos últimos 5, ou vice-versa), trate isso como mudança de momento e mencione explicitamente no "insight" — não ignore a tendência recente em favor só da média.
9. Em "confrontos_diretos", cada item já vem com "dias_atras" calculado. Pese MUITO mais os confrontos com menos de ~365 dias do que os mais antigos — times mudam de elenco, técnico e nível de um ano pro outro, então um 5-0 de 3 anos atrás não diz quase nada sobre o jogo de hoje. Se a maioria dos confrontos diretos disponíveis tiver mais de 2 anos (730 dias), trate o H2H como pouco confiável e diga isso no "insight", em vez de usá-lo com o mesmo peso de um H2H recente.
10. Se "odds_mercado_real" estiver presente, é a odd cotada por casas de apostas (via API-Football, média entre casas) pra esse confronto — ela JÁ é exibida separadamente pro trader na interface, como referência informativa, fora do que você escreve. Por instrução explícita do Edson: a odd NÃO deve aparecer em NENHUMA parte da sua análise — não em "criterios_atendidos", não em "criterios_nao_atendidos", não em "alertas", não no "insight", não no "resumo". Não julgue se a odd está "cara", "comprimida", "com valor" ou "com risco/retorno desfavorável" — não é seu papel avaliar isso, e não deve influenciar o "score" nem a decisão de "aprovado" em nenhuma medida, nem mesmo como comentário à parte. Aprovação e score dependem SÓ dos critérios estatísticos do mercado (forma, H2H, amostra). Ignore completamente o campo "odds_mercado_real" na hora de escrever sua resposta — ele existe nos dados só pra uso de outra parte do sistema, não pra você comentar. Preencha "odds_estimada" normalmente com sua própria estimativa de odd justa a partir da sua "probabilidade_real" (isso é independente e não é sobre o mercado real).
11. Se "modo_copa" for true, esse confronto é de uma competição de copa/mata-mata (Copa do Mundo, Libertadores, Champions, Copa do Brasil, etc.), e isso muda o que conta como "dado insuficiente":
    - "confrontos_diretos_indisponivel": true em modo copa é NORMAL — times de chaves/grupos/confederações diferentes raramente ou nunca se enfrentaram antes. NÃO reduza o score só por isso, como faria numa liga doméstica. Só penalize H2H ausente se outras fontes de dado TAMBÉM estiverem fracas.
    - "estatisticas_time_a/b" com amostra pequena (poucos jogos NESSA edição específica do torneio) também é normal, principalmente em fases iniciais. Em modo copa, prefira SEMPRE "forma_recente_time_a/b" como base principal, com confiança normal — não trate a ausência de estatística "presa ao torneio" como um problema a mais.
    - Mando de campo é menos confiável em modo copa, especialmente torneios internacionais de seleções em sede neutra (nem A nem B jogam "em casa" de fato). Dê menos peso a "como_mandante"/"como_visitante" e mais à forma geral combinada, a menos que fique claro pelos dados que um dos times é o anfitrião do torneio.
    - Resumindo: em modo copa, julgue principalmente pela "forma_recente" geral de cada time e pelo "ultimos_5" — não reprove automaticamente só porque H2H e estatísticas do torneio estão vazios, isso é esperado nesse contexto.
12. CUIDADO COM PERCENTUAL CALCULADO EM AMOSTRA PEQUENA: vários campos vêm como percentual (ex: "pct_jogos_1t_total_baixo", "pct_jogos_1t_sem_gols", taxas de "jogos_sem_marcar_gol"/"jogos_sem_sofrer_gol"). Esses percentuais SEMPRE vêm acompanhados de "jogos_considerados" (ou equivalente) — confira esse número antes de confiar no percentual. Um "100%" calculado em 4 ou 5 jogos NÃO tem a mesma força estatística que um "100%" calculado em 15-20 jogos, mesmo sendo o mesmo número — com amostra pequena, a taxa real pode estar bem mais baixa e você ainda não viu o jogo que quebra o padrão. Quando um percentual alto (>= 85%) que está sustentando a aprovação vier de uma amostra de 6 jogos ou menos (e especialmente de recortes como "como_mandante"/"como_visitante"/"ultimos_5", que são subconjuntos pequenos por natureza), aplique um desconto de confiança: ou exija confirmação de outra fonte (H2H, a métrica geral mais ampla) apontando na mesma direção, ou reduza o score abaixo do mínimo do mercado mesmo que o percentual isolado pareça forte. Isso não significa reprovar automaticamente toda amostra pequena — significa não tratar "100% em 4 jogos" com o mesmo peso de "100% em 15 jogos".
13. Se o mercado for "Dupla Chance", você precisa identificar explicitamente qual lado está sendo aprovado e preencher o campo "lado_aprovado" com "1X" (Time A, o mandante, não perde — vence ou empata) ou "X2" (Time B, o visitante, não perde). Isso não é opcional: é o que permite, dias depois, checar o placar real e saber se a aprovação bateu ou não. Pra qualquer mercado que não seja "Dupla Chance", "lado_aprovado" deve ser sempre null.
14. Se a mensagem do usuário incluir um bloco "CONTEXTO DE CALIBRAÇÃO HISTÓRICA", esse é o desempenho real e medido desse mercado especificamente (taxa de acerto de sinais aprovados e já resolvidos, com limite inferior de confiança estatística). Use isso SÓ como ajuste de confiança geral, nunca como critério de aprovação: se o limite inferior estiver bem abaixo do esperado pra esse mercado, seja mais conservador no score mesmo que os critérios individuais pareçam bons, e mencione isso no "insight". NUNCA use uma taxa histórica boa pra justificar aprovar um sinal que não atende aos critérios estatísticos do jogo atual — o histórico informa o quanto confiar no sistema como um todo, não substitui a análise do confronto específico. Se esse bloco não estiver presente, é porque ainda não há amostra suficiente desse mercado pra esse cálculo — não trate a ausência como sinal bom ou ruim.
15. "forma_recente_time_a/b" pode trazer um subcampo "descanso" com "dias_desde_ultimo_jogo", "jogos_ultimos_7_dias" e "jogos_ultimos_14_dias" — calendário do time até a data do confronto analisado. NÃO existe uma direção fixa de "calendário apertado = pior": times grandes costumam rotacionar elenco pra preservar titulares em jogos de calendário cheio (o resultado principal não necessariamente piora); times sem profundidade de elenco sentem mais o desgaste. Use como CONTEXTO pra explicar performance inconsistente quando fizer sentido (ex: "media_gols_marcados" caiu nos "ultimos_5" e o time vinha de 3 jogos em 7 dias — desgaste é uma explicação plausível), não como regra numérica de desconto automático de score. "dias_desde_ultimo_jogo" muito alto (15+) pode indicar falta de ritmo competitivo, principalmente após pausas de seleção — também mencione se relevante. Se "descanso" vier null ou ausente, é porque não havia jogos recentes suficientes com data pra calcular — trate como ausência de dado, não como sinal de calendário tranquilo.
16. Os dados podem trazer um campo "baseline_poisson" — uma estimativa determinística, calculada em código, da probabilidade desse mercado a partir das médias de ataque e defesa dos DOIS times combinadas (modelo de Poisson; pra escanteios, aproximação normal). O campo "fonte" indica de qual recorte as médias vieram. Use isso como ÂNCORA DE SANIDADE da sua "probabilidade_real": se a sua estimativa divergir 15pp ou mais do baseline, isso exige justificativa explícita no "insight" apontando qual dado concreto sustenta a divergência (H2H recente forte, mudança de momento clara em "ultimos_5", contexto que médias não capturam) — sem justificativa concreta, aproxime sua estimativa do baseline em vez de confiar no seu palpite. Pra "Dupla Chance", o baseline traz "prob_1x" e "prob_x2" — use o do lado que você está aprovando. Limitações conhecidas do modelo (reconheça, mas não use como desculpa genérica pra ignorá-lo): assume independência entre os gols dos dois times e não sabe de lesões, desfalques ou motivação. O baseline NÃO é critério de aprovação nem de reprovação automática — é referência de calibração. Se o campo não estiver presente, siga a análise normal sem mencioná-lo.

Responda SOMENTE com JSON válido, sem markdown, sem texto fora do JSON.`;
}

export async function POST(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  // Capturados aqui fora, antes do try, porque request.clone() falha com
  // "unusable" se chamado depois que o body já foi lido — então o fallback
  // de erro não pode depender de reconstruir a request lá no catch.
  let jogo, mercado;

  try {
    ({ jogo, mercado } = await request.json());
    if (!jogo || !mercado || typeof jogo !== 'string' || typeof mercado !== 'string')
      return NextResponse.json({ error: 'Jogo e mercado obrigatórios (texto).' }, { status: 400 });
    if (!MERCADOS[mercado])
      return NextResponse.json({ error: 'Mercado inválido.' }, { status: 400 });

    // Cache: mesmo jogo+mercado analisado há menos de 2h devolve na hora,
    // sem gastar chamada de API-Football nem de IA de novo.
    const cacheado = await lerCache(jogo, mercado);
    if (cacheado) return NextResponse.json({ ...cacheado, _cache: true });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json(demoResult(jogo, mercado));

    const min = MERCADOS[mercado].min;
    // Em paralelo: dado real do jogo (API-Football) e contexto de
    // calibração histórica desse mercado (Supabase) — são independentes,
    // não faz sentido esperar um pro outro começar.
    const [dadosReais, contextoCalibracao] = await Promise.all([
      getFootballData(jogo, { mercado }),
      buscarContextoCalibracao(session.userId, mercado),
    ]);

    // Baseline Poisson — calculado em código a partir dos dados que já
    // vieram (zero API extra). Anexado a dadosReais ANTES da montagem do
    // prompt e do snapshot, de propósito: assim ele (a) entra no bloco DADOS
    // que a IA vê (Regra 16 do system prompt explica como usar), (b) é salvo
    // automaticamente em dados_reais_snapshot pra calibração futura, e (c)
    // fica disponível pro Gate 23 (alerta informativo de divergência). Fase
    // atual: NÃO-bloqueante — nunca mexe em aprovado/score.
    if (dadosReais.disponivel) {
      dadosReais.baseline_poisson = calcularBaselinePoisson(mercado, dadosReais);
    }

    // jogos_recentes_time_a/b são só pro preview de estatísticas da grade do
    // dia — não fazem sentido no prompt da IA (ela já tem os números
    // agregados em forma_recente_time_a/b) e só inflariam o tamanho da
    // chamada sem ajudar a análise. _debug_raw é diagnóstico temporário
    // (auditoria jul/2026) — vai pro dados_reais_snapshot (Supabase) via
    // dadosReais original abaixo, mas não deve ir pro prompt da IA.
    const { jogos_recentes_time_a, jogos_recentes_time_b, _debug_raw, ...dadosParaPrompt } = dadosReais;
    const blocoDados = dadosReais.disponivel
      ? `DADOS:\n${JSON.stringify(dadosParaPrompt)}`
      : `DADOS: indisponíveis. Motivo: ${dadosReais.motivo}`;

    const blocoCalibracao = contextoCalibracao
      ? `\n\nCONTEXTO DE CALIBRAÇÃO HISTÓRICA — mercado "${mercado}" (n=${contextoCalibracao.total} sinais aprovados e resolvidos): taxa de acerto bruta ${contextoCalibracao.taxa_acerto_bruta}%, limite inferior de confiança (Wilson 95%) ${contextoCalibracao.wilson_lower_bound}%. Ver Regra 14.`
      : '';

    const blocoCriterios = CRITERIOS_MERCADO[mercado]
      ? `\n\n${CRITERIOS_MERCADO[mercado]}`
      : '';

    // Gate 6 roda em paralelo com a chamada à IA — mesmo racional do
    // contexto de calibração: é uma leitura independente no Supabase, não
    // faz sentido esperar a IA responder pra só depois começar essa query.
    const promiseExposicao = dadosReais.disponivel
      ? verificarExposicaoCorrelacionada(session.userId, dadosReais.id_time_a, dadosReais.id_time_b)
      : Promise.resolve(null);

    const [res, exposicaoCorrelacionada] = await Promise.all([
      fetchComRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          // temperature: 0 — análise de score/aprovação precisa ser
          // determinística pro mesmo dado de entrada. Sem isso, o mesmo jogo
          // com os mesmos dados podia gerar scores diferentes em execuções
          // diferentes (ex: reanálise após cache expirar), o que quebra
          // qualquer tentativa de calibração — você estaria medindo ruído do
          // sampling da IA junto com o sinal real do critério.
          temperature: 0,
          system: montarSystemPrompt(),
          messages: [{
            role: 'user',
            content: `Analise "${jogo}" para o mercado "${mercado}". Score mínimo para aprovar: ${min}/100.
${blocoCriterios}
${blocoCalibracao}

${blocoDados}

Responda SOMENTE JSON válido sem markdown, neste formato exato:
{"evento":"nome formatado","competicao":"liga ou null","score":0-100,"aprovado":bool,"odds_estimada":"1.XX","probabilidade_real":0-100,"criterios_atendidos":["..."],"criterios_nao_atendidos":["..."],"alertas":[],"insight":"frase curta explicando o score, citando dado real se houver","resumo":"2-3 frases operacionais para o trader","lado_aprovado":"1X ou X2 (APENAS se mercado for Dupla Chance, indicando qual lado você aprovou — Time A não perde = 1X, Time B não perde = X2); para qualquer outro mercado, sempre null"}`
          }]
        }),
      }, { tentativas: 1, timeoutMs: 50000 }),
      promiseExposicao,
    ]);

    if (!res.ok) {
      logErro('anthropic_call', { jogo, mercado, status: res.status }, await res.text().catch(() => 'sem corpo'));
      return NextResponse.json(demoResult(jogo, mercado, `A IA não respondeu corretamente (status ${res.status}). Tente novamente em alguns minutos.`));
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.replace(/```json|```/g, '').trim();
    if (!text) return NextResponse.json(demoResult(jogo, mercado, 'A IA não retornou conteúdo válido. Tente novamente.'));

    const result = JSON.parse(text);
    result._minScore = min;
    result._dadosReaisUsados = dadosReais.disponivel;
    result._oddsReais = dadosReais.odds_mercado_real || null;
    result._contextoCalibracao = contextoCalibracao;
    result._baselinePoisson = dadosReais.baseline_poisson || null;

    // Reverte a aprovação na marra se o dado real não sustenta, mesmo que a
    // IA tenha aprovado — não depende mais só da IA "lembrar" da Regra 12.
    if (dadosReais.disponivel) {
      aplicarEnforcementDeterministico(mercado, dadosReais, result, min);
    }

    // Gate 6 — não reverte aprovação (ver racional na função), só anexa
    // alerta quando o sinal segue aprovado E existe correlação real.
    if (result.aprovado && exposicaoCorrelacionada?.length) {
      result.alertas = [
        ...(result.alertas || []),
        `[Enforcement automático] Exposição correlacionada: já existe ${exposicaoCorrelacionada.length} sinal(is) aprovado(s) hoje pra esse MESMO confronto (mercado(s): ${exposicaoCorrelacionada.join(', ')}). Isso não invalida esse sinal — só significa que o stake combinado nos dois depende do mesmo evento, não são exposições independentes. Considere isso no dimensionamento — Gate 6.`,
      ];
    }

    // Log automático de TODA análise real (aprovada ou reprovada) — é o que
    // permite, mais pra frente, saber se sinal REJEITADO também teria batido,
    // em vez de só medir o que o usuário escolheu apostar. Roda em paralelo
    // sem travar a resposta: se o insert falhar, a análise ainda volta
    // normal pro usuário — perder esse log não pode quebrar a feature
    // principal.
    // SÓ loga quando havia dado real disponível (dadosReais.disponivel).
    // Quando a API-Football não acha os times, a IA reprova por instrução
    // da Regra 3 (sem dado = reprova), não por critério estatístico — isso
    // não ensina nada sobre calibração de score, só suja a Auditoria com
    // sinal sem nenhuma previsão de verdade por trás.
    if (dadosReais.disponivel) {
      registrarHistoricoAnalise(session.userId, jogo, mercado, result, min, dadosReais)
        .catch(e => logErro('analises_historico_insert', { jogo, mercado }, e));
    }

    // Só cacheia análise real (nunca modo demo, nunca erro).
    await salvarCache(jogo, mercado, result);

    return NextResponse.json(result);

  } catch (e) {
    logErro('analyze', { jogo, mercado }, e);
    const motivo = e?.name === 'TimeoutError' || /abort/i.test(e?.message || '')
      ? 'A análise demorou demais e foi interrompida (timeout). A IA pode estar sobrecarregada — tente novamente.'
      : 'Erro inesperado ao processar a análise. Tente novamente.';
    return NextResponse.json(demoResult(jogo || 'Jogo', mercado || 'Lay 2x2', motivo));
  }
}
