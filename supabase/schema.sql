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
