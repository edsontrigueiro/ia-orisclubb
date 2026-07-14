// Baseline estatístico determinístico por mercado — modelo de Poisson pra
// gols, aproximação normal pra escanteios. Calculado 100% em código a partir
// dos dados que getFootballData JÁ traz (zero chamada de API extra).
//
// PROPÓSITO: dar uma âncora numérica com princípio estatístico pra cada
// análise, em vez de depender só de thresholds heurísticos e do julgamento
// holístico da IA. A auditoria de julho/2026 mostrou que vários thresholds
// dos critérios implicavam probabilidades reais BEM abaixo do score mínimo
// do mercado (ex: soma de médias 2.6 pro +1.5 Gols implica ~73% sob Poisson,
// contra um mínimo declarado de 83) — e a calibração real já tinha
// confirmado o sintoma no bucket 85-89 do +1.5 Gols.
//
// FASE ATUAL: NÃO-BLOQUEANTE. O baseline é (a) injetado no prompt da IA como
// referência de sanidade (Regra 16 do system prompt), (b) salvo em
// dados_reais_snapshot pra calibração futura, e (c) gera alerta informativo
// (Gate 23) quando diverge muito do mínimo do mercado — mas NUNCA mexe em
// aprovado/score. Só depois de 15+ análises resolvidas comparando baseline
// vs resultado real (protocolo de calibração de sempre) é que se decide
// promover a gate bloqueante.
//
// LIMITAÇÕES CONHECIDAS (documentadas de propósito, não escondidas):
// - Poisson assume independência entre os gols dos dois times; na prática há
//   correlação leve (estado de jogo muda comportamento) e leve sobredispersão
//   — o modelo tende a SUBESTIMAR um pouco empates e placares extremos.
// - Não sabe de lesões, desfalques, motivação, clima — é só forma média.
// - λ é estimado como média simples entre ataque de um lado e defesa do
//   outro, sem ajuste por força de liga.
// Nada disso invalida o uso como ÂNCORA — só como oráculo.

function fatorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonPmf(k, lambda) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / fatorial(k);
}

// P(X <= k) pra X ~ Poisson(lambda)
function poissonCdf(k, lambda) {
  let s = 0;
  for (let i = 0; i <= k; i++) s += poissonPmf(i, lambda);
  return s;
}

// CDF da normal padrão — aproximação de Abramowitz & Stegun (erro < 7.5e-8),
// suficiente de sobra pra este uso. Evita dependência externa.
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

function numerico(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function pct(p) {
  return +(Math.max(0, Math.min(1, p)) * 100).toFixed(1);
}

// λ de gols esperados de cada time nesse confronto: média simples entre o
// ataque de um lado e a defesa do outro. Usa o recorte de mando (Time A como
// mandante, Time B como visitante) quando NÃO é modo copa e o recorte tem
// amostra >= 4; senão cai pra forma geral — mesma hierarquia de preferência
// que o resto do sistema (Regra 8 / Regra 11) já usa.
function estimarLambdas(dadosReais) {
  const formaA = dadosReais.forma_recente_time_a;
  const formaB = dadosReais.forma_recente_time_b;
  if (!formaA || !formaB) return null;

  const AMOSTRA_MINIMA_LAMBDA = 4;
  const usaRecorte = !dadosReais.modo_copa &&
    (formaA.como_mandante?.jogos_considerados ?? 0) >= AMOSTRA_MINIMA_LAMBDA &&
    (formaB.como_visitante?.jogos_considerados ?? 0) >= AMOSTRA_MINIMA_LAMBDA;

  const blocoA = usaRecorte ? formaA.como_mandante : formaA;
  const blocoB = usaRecorte ? formaB.como_visitante : formaB;

  const atkA = numerico(blocoA?.media_gols_marcados);
  const defA = numerico(blocoA?.media_gols_sofridos);
  const atkB = numerico(blocoB?.media_gols_marcados);
  const defB = numerico(blocoB?.media_gols_sofridos);
  if (atkA == null || defA == null || atkB == null || defB == null) return null;

  return {
    lambdaA: (atkA + defB) / 2,
    lambdaB: (atkB + defA) / 2,
    fonte: usaRecorte ? 'recorte_mando_visitante' : 'forma_geral',
  };
}

// λ total de gols no 1º TEMPO. Preferência: dado real de 1T dos mesmos
// recortes (primeiro_tempo dentro de como_mandante/como_visitante, ou geral);
// fallback: ~45% do λ do jogo inteiro (proporção histórica típica de gols
// que saem até o intervalo), marcado explicitamente como aproximação.
function estimarLambda1T(dadosReais, lambdasJogo) {
  const formaA = dadosReais.forma_recente_time_a;
  const formaB = dadosReais.forma_recente_time_b;
  const AMOSTRA_MINIMA_LAMBDA = 4;

  const usaRecorte = !dadosReais.modo_copa &&
    (formaA?.como_mandante?.primeiro_tempo?.jogos_considerados ?? 0) >= AMOSTRA_MINIMA_LAMBDA &&
    (formaB?.como_visitante?.primeiro_tempo?.jogos_considerados ?? 0) >= AMOSTRA_MINIMA_LAMBDA;

  const ptA = usaRecorte ? formaA?.como_mandante?.primeiro_tempo : formaA?.primeiro_tempo;
  const ptB = usaRecorte ? formaB?.como_visitante?.primeiro_tempo : formaB?.primeiro_tempo;

  const amostraOk =
    (ptA?.jogos_considerados ?? 0) >= AMOSTRA_MINIMA_LAMBDA &&
    (ptB?.jogos_considerados ?? 0) >= AMOSTRA_MINIMA_LAMBDA;

  if (amostraOk) {
    const atkA = numerico(ptA?.media_gols_marcados_1t);
    const defA = numerico(ptA?.media_gols_sofridos_1t);
    const atkB = numerico(ptB?.media_gols_marcados_1t);
    const defB = numerico(ptB?.media_gols_sofridos_1t);
    if (atkA != null && defA != null && atkB != null && defB != null) {
      return {
        lambdaTotal1T: (atkA + defB) / 2 + (atkB + defA) / 2,
        fonte: usaRecorte ? 'primeiro_tempo_recorte_mando' : 'primeiro_tempo_geral',
      };
    }
  }

  if (lambdasJogo) {
    return {
      lambdaTotal1T: (lambdasJogo.lambdaA + lambdasJogo.lambdaB) * 0.45,
      fonte: 'aproximacao_45pct_do_jogo_inteiro',
    };
  }
  return null;
}

function baselineEscanteios(dadosReais) {
  const mA = numerico(dadosReais.forma_recente_time_a?.escanteios?.media_escanteios);
  const mB = numerico(dadosReais.forma_recente_time_b?.escanteios?.media_escanteios);
  if (mA == null || mB == null) return null;
  const media = (mA + mB) / 2;
  // Desvio-padrão típico do total de escanteios por jogo (~3.5) — valor de
  // literatura/observação de mercado, não calibrado com dado próprio ainda.
  // É exatamente esse DP que faz média 9.5 valer só ~61% de P(>=9), e média
  // ~11.5-12 ser o necessário pra ~80-85%.
  const DESVIO_PADRAO_ESCANTEIOS = 3.5;
  // Correção de continuidade: P(total >= 9) = P(X > 8.5) na normal.
  const prob = 1 - normalCdf((8.5 - media) / DESVIO_PADRAO_ESCANTEIOS);
  return {
    metodo: 'normal_aproximada',
    fonte: 'media_escanteios_forma_recente',
    media_combinada: +media.toFixed(2),
    desvio_padrao_assumido: DESVIO_PADRAO_ESCANTEIOS,
    probabilidade_estimada: pct(prob),
  };
}

// API pública. Retorna null sempre que não houver dado suficiente — nunca
// inventa estimativa. Pra "Dupla Chance" retorna prob_1x e prob_x2 (o lado
// aprovado só é conhecido DEPOIS da resposta da IA); pros demais mercados
// retorna probabilidade_estimada única.
export function calcularBaselinePoisson(mercado, dadosReais) {
  try {
    if (!dadosReais?.disponivel) return null;

    if (mercado === '+8.5 Escanteios') return baselineEscanteios(dadosReais);

    const lam = estimarLambdas(dadosReais);
    if (!lam) return null;
    const { lambdaA, lambdaB, fonte } = lam;
    const lambdaTotal = lambdaA + lambdaB;
    const base = {
      metodo: 'poisson_independente',
      fonte,
      lambda_time_a: +lambdaA.toFixed(2),
      lambda_time_b: +lambdaB.toFixed(2),
    };

    switch (mercado) {
      case '+0.5 Gols':
        return { ...base, probabilidade_estimada: pct(1 - Math.exp(-lambdaTotal)) };

      case '+1.5 Gols':
        return { ...base, probabilidade_estimada: pct(1 - poissonCdf(1, lambdaTotal)) };

      case 'Under 3.5 Gols':
        return { ...base, probabilidade_estimada: pct(poissonCdf(3, lambdaTotal)) };

      case 'Lay 2x2':
        // P(NÃO terminar exatamente 2-2) = 1 - P(A=2)·P(B=2)
        return { ...base, probabilidade_estimada: pct(1 - poissonPmf(2, lambdaA) * poissonPmf(2, lambdaB)) };

      case 'Lay Empate': {
        let pEmpate = 0;
        for (let k = 0; k <= 10; k++) pEmpate += poissonPmf(k, lambdaA) * poissonPmf(k, lambdaB);
        return { ...base, probabilidade_estimada: pct(1 - pEmpate) };
      }

      case 'BTTS Não':
        // P(pelo menos um lado a zero) = 1 - P(ambos marcam)
        return { ...base, probabilidade_estimada: pct(1 - (1 - Math.exp(-lambdaA)) * (1 - Math.exp(-lambdaB))) };

      case 'Dupla Chance': {
        let p1x = 0, px2 = 0;
        for (let a = 0; a <= 10; a++) {
          for (let b = 0; b <= 10; b++) {
            const p = poissonPmf(a, lambdaA) * poissonPmf(b, lambdaB);
            if (a >= b) p1x += p; // Time A vence ou empata
            if (b >= a) px2 += p; // Time B vence ou empata
          }
        }
        return { ...base, prob_1x: pct(p1x), prob_x2: pct(px2) };
      }

      case '-2.5 Gols 1T':
      case '+0.5 Gols 1T': {
        const lam1t = estimarLambda1T(dadosReais, lam);
        if (!lam1t) return null;
        const l = lam1t.lambdaTotal1T;
        const base1t = { ...base, fonte: lam1t.fonte, lambda_1t_total: +l.toFixed(2) };
        if (mercado === '-2.5 Gols 1T') {
          return { ...base1t, probabilidade_estimada: pct(poissonCdf(2, l)) };
        }
        return { ...base1t, probabilidade_estimada: pct(1 - Math.exp(-l)) };
      }

      default:
        return null;
    }
  } catch {
    // Baseline é "nice to have" — qualquer erro aqui não pode derrubar a
    // análise principal. Sem log estruturado de propósito: o chamador já
    // trata null como "sem baseline", e não há estado a investigar.
    return null;
  }
}
