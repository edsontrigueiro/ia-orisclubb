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
- Só aprove se a soma das médias de gols marcados dos dois times for >= 2.6 — margem de segurança sobre a linha de 1.5.
- Verifique "jogos_sem_marcar_gol" dos dois times: se AMBOS tiverem taxa alta (>= 25% dos jogos recentes sem marcar), isso é sinal de risco real de jogo com 1 gol ou menos, mesmo com média geral ok — reduza o score.
- Em "confrontos_diretos", a média de gols totais por jogo nos H2H recentes (dias_atras < 730) deve reforçar a tendência — se os confrontos diretos específicos tiverem sido de poucos gols, isso pesa contra, mesmo com boas médias gerais de cada time isolado.
- Exija amostra mínima de 8 jogos disputados na temporada/forma recente para AMBOS os times.`,

  '+0.5 Gols': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Over 0.5 Gols (pelo menos 1 gol no jogo, mercado naturalmente muito provável):
- Esse é o mercado mais "automático" da lista — 0x0 é o resultado mais raro entre os possíveis na grande maioria dos contextos. Mesmo assim, REPROVE se houver sinal real de risco: exija que NÃO seja verdade simultaneamente que (a) Time A tenha "jogos_sem_marcar_gol" alto (>= 25%) E (b) Time B tenha "jogos_sem_sofrer_gol" alto (>= 25%) — essa combinação especificamente é o perfil de jogo que termina 0x0.
- Mesma checagem no sentido inverso (Time B sem marcar muito + Time A com defesa muito sólida) — se QUALQUER um dos dois lados desse "casal" de condições for verdade, reduza o score.
- Em "confrontos_diretos", um 0x0 recente (dias_atras < 730) entre esses dois times específicos é sinal de alerta real, mesmo sendo mercado tipicamente seguro — reduza o score se isso ocorrer.
- Exija amostra mínima de 8 jogos disputados na temporada/forma recente para AMBOS os times.`,

  'Dupla Chance': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Dupla Chance (1X ou X2) no favorito:
- Só aprove se houver diferença CLARA de qualidade entre os times nos dados: favorito com média de gols marcados >= 1.8 e média de gols sofridos <= 1.2; adversário com média de gols sofridos >= 1.5. Se as médias forem parecidas entre os dois times, isso é um jogo equilibrado — REPROVE, mesmo que um dos nomes "pareça" favorito.
- Priorize "como_mandante" do Time A e "como_visitante" do Time B (não a média geral) — um time pode ser ótimo em casa e mediano fora, e é justamente o mando de campo que decide esse mercado. EXCEÇÃO: se "modo_copa" for true (torneio internacional, possivelmente em sede neutra), esse mando pode não refletir uma vantagem real de jogar "em casa" — nesse caso baseie-se na forma geral combinada em vez de insistir no recorte mandante/visitante.
- Nos confrontos diretos disponíveis (até 10), o favorito não deve ter mais de 1 derrota — dê peso extra aos confrontos com "mesmo_mando_atual": true. 2+ derrotas no H2H é sinal de zebra recorrente — reduza o score fortemente.
- Exija amostra mínima de 8 jogos disputados na temporada para AMBOS os times. Menos que isso, reduza o score e diga isso explicitamente em "alertas".
- Competições eliminatórias / mata-mata (decisão, copa, playoff) têm motivação anormal e mais risco de zebra — se a "liga" indicada nos dados for desse tipo, reduza o score mesmo com favoritismo claro nas médias.`,

  'Lay Empate': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Lay Empate (o jogo não pode terminar em X):
- Só aprove se a soma das médias de gols marcados dos dois times for >= 2.4. Jogos com tendência ofensiva clara empatam menos.
- Nos confrontos diretos disponíveis (até 10), no máximo 2 podem ter terminado empatados. 3+ empates no H2H é sinal forte de que esse confronto específico tende ao empate — reprove.
- Prefira confrontos com diferença de qualidade clara (favorito x zebra). Jogos historicamente equilibrados entre os mesmos dois times tendem a empate; isso deve reduzir o score mesmo se a soma de gols for alta.
- Exija amostra mínima de 8 jogos disputados na temporada para AMBOS os times.`,

  'Under 3.5 Gols': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Under 3.5 Gols (jogo total com 3 gols ou menos):
- Só aprove se a soma das médias de gols marcados dos dois times for <= 2.6.
- Exija que pelo menos um dos dois times tenha taxa de "jogos sem sofrer gol" (clean sheets / jogos disputados) >= 25%. Isso indica capacidade defensiva real, não só sorte pontual.
- Nos confrontos diretos disponíveis (até 10), a média de gols totais por jogo deve ser <= 3.0. Histórico de jogos com 4+ gols entre esses times específicos é motivo forte para reprovar, mesmo com médias de temporada baixas.
- Exija amostra mínima de 8 jogos disputados na temporada para AMBOS os times.`,

  '-2.5 Gols 1T': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Under 2.5 Gols no PRIMEIRO TEMPO (total de gols dos dois times até o intervalo <= 2):
- Esse mercado é especificamente sobre o 1º TEMPO, não o jogo todo. Use o subcampo "primeiro_tempo" dentro de "forma_recente_time_a/b" — ele já vem calculado a partir do placar real do intervalo de cada jogo, NÃO é estimado a partir da média do jogo inteiro. Se "primeiro_tempo" for null, a API não trouxe placar de intervalo pra esses jogos — isso é ESPERADO e comum em jogos de seleção nacional (amistosos, eliminatórias), onde a cobertura de dado é mais pobre que em ligas de clube europeias; diga isso explicitamente no insight ("cobertura de dado de 1º tempo é tipicamente mais pobre pra jogos de seleção") em vez de tratar como uma falha genérica qualquer. Reduza a confiança mesmo assim, mas tente usar "pct_jogos_1t_total_baixo" quando disponível.
- "primeiro_tempo.pct_jogos_1t_total_baixo" de cada time é a métrica mais direta pra esse mercado: é o % dos jogos recentes desse time em que o total de gols no 1T (somando os dois lados) foi <= 2. Só aprove se os dois times tiverem esse percentual >= 60%.
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
- Use "primeiro_tempo.pct_jogos_1t_sem_gols" de cada time — é o % dos jogos recentes em que o 1T terminou 0x0. Só aprove se os DOIS times tiverem esse percentual <= 25% (ou seja, em pelo menos 75% dos jogos recentes de cada time houve gol antes do intervalo).
- "estatisticas_time_a/b.pct_gols_marcados_1t_temporada"/"pct_gols_sofridos_1t_temporada" são um segundo sinal, com amostra de TEMPORADA INTEIRA (bem maior que os ~10 jogos de "forma_recente"). Se disponível, percentual ALTO aqui (time concentra gols no 1T historicamente) reforça a aprovação; percentual baixo é sinal de alerta mesmo se os últimos jogos pareceram bons.
- PRIORIZE o "primeiro_tempo" DENTRO de "como_mandante" do Time A e "como_visitante" do Time B (não o "primeiro_tempo" geral, que mistura casa e fora) — um time pode demorar a marcar fora mas começar rápido em casa, por exemplo. Use o geral só como reforço/comparação. EXCEÇÃO: se "modo_copa" for true, use o "primeiro_tempo" geral combinado, pelo mesmo motivo já explicado nos outros mercados (mando pode não ser real em sede neutra).
- Se "primeiro_tempo" for null pra qualquer um dos dois times, mesma ressalva do mercado "-2.5 Gols 1T": é comum em jogos de seleção nacional, mas reduz a confiança — diga isso no insight.
- Em "confrontos_diretos", use "placar_1t" quando presente: se a maioria dos H2H recentes (dias_atras < 730) teve 1T 0x0, isso é sinal forte contra esse mercado específico, mesmo com boas médias gerais de cada time.
- Times ofensivos que "começam rápido" (média de gols no 1T próxima ou maior que a média do jogo completo dividida por 2) reforçam esse mercado.
- Exija amostra mínima de 8 jogos com dado de 1º tempo disponível pra AMBOS os times.`,

  '+8.5 Escanteios': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Over 8.5 Escanteios (total de escanteios do jogo, dos dois times somados, mínimo 9):
- Os dados trazem "escanteios" dentro de "forma_recente_time_a/b" — é a média de escanteios TOTAIS (dos dois lados, não só desse time) nos jogos recentes em que esse time jogou. Se "escanteios" for null, ou se "jogos_considerados" dentro dele for bem menor que os 10 jogos buscados, a API não tem esse dado disponível pra boa parte desses jogos — cobertura de escanteio é tipicamente mais pobre que cobertura de gol, e MUITO mais pobre em jogos de seleção nacional (amistosos, eliminatórias) do que em ligas de clube europeias. Isso é uma limitação conhecida da fonte de dado, não uma falha — diga isso explicitamente no insight quando acontecer ("cobertura de escanteios é tipicamente mais pobre em jogos de seleção"), em vez de tratar como erro genérico. Reprove mesmo assim por dado insuficiente, mas com essa explicação específica.
- Calcule a média combinada: (escanteios_time_a + escanteios_time_b) / 2. Só aprove se essa média combinada for >= 9.5 — margem de segurança sobre a linha de 8.5.
- Se "escanteios_h2h" estiver disponível (confrontos diretos específicos entre esses dois times), dê peso MAIOR a ele do que à média geral de cada time separado — é o dado mais específico que existe pra esse confronto. Se "escanteios_h2h.media_escanteios" for visivelmente menor que a média combinada geral, reduza o score.
- Escanteio é um dado mais "ruidoso" que gol (varia mais jogo a jogo) — seja mais conservador aqui do que seria em mercados de gols com números parecidos. Exija amostra mínima de 8 jogos com dado de escanteio disponível pra AMBOS os times. Esse mercado tende a ser mais confiável em ligas de clube do que em jogos de seleção, justamente por causa da cobertura de dado.`,
};
