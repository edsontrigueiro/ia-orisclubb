-- Scanner Tips v2 — Supabase Schema
-- Execute no SQL Editor do Supabase

create table if not exists signals (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null,
  evento text not null,
  competicao text,
  mercado text not null,
  score integer,
  criterios_ok jsonb default '[]',
  criterios_no jsonb default '[]',
  insight text,
  resumo text,
  decisao text not null check (decisao in ('pegar','passar')),
  odd numeric(6,2),
  stake numeric(10,2),
  lucro_potencial numeric(10,2),
  resultado text check (resultado in ('green','red')),
  lucro_real numeric(10,2),
  analisado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

alter table signals enable row level security;
create policy "users own signals" on signals for all using (auth.uid() = user_id);
create index if not exists signals_user_idx on signals(user_id, analisado_em desc);
-- Log de TODA análise real (aprovada ou reprovada, escolhida ou não) — é o
-- que alimenta /api/calibracao, o contexto de calibração histórica
-- (Regra 14), o cron de resolução automática, e o Gate 6 (correlação).
create table if not exists analises_historico (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null,
  evento text,
  competicao text,
  mercado text not null,
  score integer,
  min_score integer,
  aprovado boolean not null default false,
  criterios_ok jsonb default '[]',
  criterios_no jsonb default '[]',
  alertas jsonb default '[]',
  fixture_id integer,
  data_jogo timestamptz,
  time_a text,
  time_b text,
  -- Gate 6 (exposição correlacionada) — rodar migration_gate6.sql se essa
  -- tabela já existir sem essas duas colunas.
  id_time_a integer,
  id_time_b integer,
  -- Só preenchido pra mercado "Dupla Chance" (Regra 13) — necessário pro
  -- cron resolver esse mercado especificamente sem ambiguidade.
  lado_aprovado text check (lado_aprovado in ('1X', 'X2')),
  -- Sinais de qualidade de dado usados pelos Gates 0/2 — persistidos pra
  -- permitir calibrar depois se esses sinais de fato preveem red.
  match_exato_a boolean,
  match_exato_b boolean,
  odd_real_ausente boolean,
  crosscheck_temporada_ausente boolean,
  h2h_fraco boolean,
  sinais_fracos_count integer,
  resultado text check (resultado in ('green', 'red')),
  resultado_atualizado_em timestamptz,
  resolvido_automaticamente boolean default false,
  analisado_em timestamptz default now()
);

alter table analises_historico enable row level security;
create index if not exists analises_historico_user_idx on analises_historico(user_id, analisado_em desc);
-- Usado pelo Gate 6 (verificarExposicaoCorrelacionada) e pelo cron.
create index if not exists analises_historico_correlacao_idx on analises_historico(user_id, aprovado, analisado_em);
create index if not exists analises_historico_pendentes_idx on analises_historico(fixture_id) where resultado is null;

-- Cache genérico reutilizado por qualquer rota que precise guardar um
-- resultado por um tempo (análise de jogo, grade de jogos do dia, etc) —
-- ver src/lib/cache.js.
create table if not exists analise_cache (
  chave text primary key,
  payload jsonb,
  created_at timestamptz default now()
);
