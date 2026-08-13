# Dashboard de demonstracao — feature/dashboard-demo

Esta branch adiciona uma versao isolada do dashboard, usada apenas para testes visuais e apresentacao. Nenhum arquivo real do sistema foi alterado.

## Arquivos novos (nao tocam em nada existente)

- `src/app/demo-dashboard/page.js` — pagina de entrada da rota `/demo-dashboard`
- `src/app/demo-dashboard/Dashboard.js` — componente de dashboard com filtros, cards de estatisticas e tabela de historico
- `src/app/api/demo-historico/route.js` — API isolada com dados mock, separada de `src/app/api/analises-historico/route.js`
- `public/demo-dashboard/nova-analise.html` — placeholder do link "Testar nova analise"

## Como acessar depois do deploy desta branch

`https://<seu-dominio-de-preview>/demo-dashboard`

## Como conectar aos dados reais

Abra `src/app/api/demo-historico/route.js` e troque o array `REGISTROS_DEMO` por uma consulta real (Supabase, Postgres etc.), seguindo o mesmo padrao usado em `src/app/api/analises-historico/route.js`. Depois, se quiser promover isso para produção, va em `src/app/demo-dashboard` e mova/renomeie a rota conforme a estrutura final que você quiser no `main`.

## Importante

Esta branch NAO foi mesclada (merge) na `main`. O sistema real continua rodando exatamente como estava antes.
