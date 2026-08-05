#!/usr/bin/env node
// Backfill de precificação (pricing) em campaign_messages a partir dos eventos
// crus do webhook Meta em message_events.
//
// Fonte: message_events.record_json -> payload.entry[].changes[].value.statuses[]
//        cada status pode ter { pricing: { category, billable, pricing_model } }
//        e statuses[].id é o wamid (= campaign_messages.provider_message_id).
//
// Dedup: um pricing por provider_message_id. Quando o mesmo wamid aparece em
//        vários eventos, prioriza billable=true e o evento mais recente.
//
// Idempotente e NAO-destrutivo: o UPDATE só toca linhas cujo pricing ainda está
// NULL (o webhook ao vivo é a fonte corrente e não é sobrescrito). Rodar 2x
// produz o mesmo resultado.
//
// Uso:
//   node scripts/backfill-pricing.mjs                # dry-run (default): só conta e amostra
//   node scripts/backfill-pricing.mjs --limit 100    # dry-run limitado a 100 wamids
//   node scripts/backfill-pricing.mjs --execute      # aplica o UPDATE de verdade
//   node scripts/backfill-pricing.mjs --execute --limit 500
//
// Conexão: usa process.env.POSTGRES_URL; se ausente, lê POSTGRES_URL do .env na
// raiz do repo. Obs.: o host do .env é `postgres` (resolve só dentro do docker).
// Para rodar da VPS, exporte POSTGRES_URL apontando para 127.0.0.1:5432, ou
// rode dentro de um container na rede do compose.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { dryRun: true, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute' || arg === '--no-dry-run') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--limit') {
      args.limit = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number.parseInt(arg.slice('--limit='.length), 10);
    }
  }
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error('--limit deve ser um inteiro positivo');
  }
  return args;
}

function resolvePostgresUrl() {
  if (process.env.POSTGRES_URL) {
    return process.env.POSTGRES_URL;
  }
  const envPath = join(__dirname, '..', '.env');
  const content = readFileSync(envPath, 'utf8');
  const line = content.split(/\r?\n/).find((l) => l.startsWith('POSTGRES_URL='));
  if (!line) {
    throw new Error('POSTGRES_URL não encontrado no ambiente nem no .env');
  }
  return line.slice('POSTGRES_URL='.length).trim().replace(/^["']|["']$/g, '');
}

// CTE compartilhada: extrai pricing de cada status e deduplica por wamid.
const DEDUP_CTE = /* sql */ `
  WITH extracted AS (
    SELECT
      st->>'id' AS wamid,
      NULLIF(st->'pricing'->>'category', '') AS category,
      (st->'pricing'->>'billable')::boolean AS billable,
      NULLIF(st->'pricing'->>'pricing_model', '') AS model,
      me.occurred_at
    FROM message_events me
    CROSS JOIN LATERAL jsonb_array_elements(me.record_json->'payload'->'entry') AS entry
    CROSS JOIN LATERAL jsonb_array_elements(entry->'changes') AS chg
    CROSS JOIN LATERAL jsonb_array_elements(chg->'value'->'statuses') AS st
    WHERE st ? 'pricing'
      AND st->'pricing' IS NOT NULL
      AND st->>'id' IS NOT NULL
  ),
  dedup AS (
    SELECT DISTINCT ON (wamid) wamid, category, billable, model
    FROM extracted
    ORDER BY wamid, billable DESC NULLS LAST, occurred_at DESC
  )
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = resolvePostgresUrl();
  const client = new Client({ connectionString });
  await client.connect();

  const limitClause = args.limit !== null ? `LIMIT ${args.limit}` : '';

  try {
    if (args.dryRun) {
      console.log(`[backfill-pricing] DRY-RUN (nada será escrito)${args.limit ? ` limit=${args.limit}` : ''}`);

      const counts = await client.query(/* sql */ `
        ${DEDUP_CTE},
        scoped AS (SELECT * FROM dedup ${limitClause})
        SELECT
          (SELECT COUNT(*) FROM scoped) AS distinct_wamids,
          (SELECT COUNT(*) FROM scoped d
             JOIN campaign_messages cm ON cm.provider_message_id = d.wamid) AS matches,
          (SELECT COUNT(*) FROM scoped d
             JOIN campaign_messages cm ON cm.provider_message_id = d.wamid
             WHERE cm.pricing_category IS NULL) AS would_update
      `);
      const row = counts.rows[0];
      console.log(`  wamids distintos (após dedup)     : ${row.distinct_wamids}`);
      console.log(`  casam com campaign_messages       : ${row.matches}`);
      console.log(`  seriam atualizados (pricing NULL) : ${row.would_update}`);

      const sample = await client.query(/* sql */ `
        ${DEDUP_CTE},
        scoped AS (SELECT * FROM dedup ${limitClause})
        SELECT d.wamid, d.category, d.billable, d.model,
               (cm.id IS NOT NULL) AS matched,
               cm.pricing_category AS current_pricing_category
        FROM scoped d
        LEFT JOIN campaign_messages cm ON cm.provider_message_id = d.wamid
        ORDER BY matched DESC
        LIMIT 10
      `);
      console.log('  amostra (até 10):');
      for (const s of sample.rows) {
        console.log(
          `    ${s.wamid}  cat=${s.category}  billable=${s.billable}  model=${s.model}  matched=${s.matched}  current=${s.current_pricing_category ?? 'NULL'}`,
        );
      }
      console.log('[backfill-pricing] DRY-RUN concluído. Use --execute para aplicar.');
      return;
    }

    console.log(`[backfill-pricing] EXECUTE${args.limit ? ` limit=${args.limit}` : ''} — aplicando UPDATE...`);
    const result = await client.query(/* sql */ `
      ${DEDUP_CTE},
      scoped AS (SELECT * FROM dedup ${limitClause})
      UPDATE campaign_messages cm
      SET pricing_category = d.category,
          pricing_billable = d.billable,
          pricing_model = d.model
      FROM scoped d
      WHERE cm.provider_message_id = d.wamid
        AND cm.pricing_category IS NULL
    `);
    console.log(`[backfill-pricing] linhas atualizadas: ${result.rowCount}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[backfill-pricing] ERRO:', error.message);
  process.exit(1);
});
