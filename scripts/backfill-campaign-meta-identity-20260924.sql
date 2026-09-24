-- WABA-57 / PEU-347. Evidência: caches nos backups de 2026-09-16 11:27 e
-- 12:05 (Oracle), payloads enviados e vínculo da lista do evento.
-- Executar com API parada, após backup novo. Primeiro -v execute=false;
-- somente depois da revisão do dry-run usar -v execute=true. Não altera
-- templateCacheId, flowCacheId, mensagens ou respostas.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  expected jsonb := '{
    "4597fdc6-d0cb-4516-b819-01afbedca003": {"templateCacheId":"01770e26-7be2-483b-af1b-81c225231c2c","messages":6},
    "c0285b21-aa6d-477a-a134-6ba02341eaf9": {"templateCacheId":"b4e1b7d2-81d9-4a9b-b92c-f1498f8add98","messages":6},
    "bccfa872-7087-4720-8058-07c01f43f3d0": {"templateCacheId":"b4e1b7d2-81d9-4a9b-b92c-f1498f8add98","messages":175}
  }'::jsonb;
  state jsonb;
  campaigns jsonb;
  item jsonb;
  match record;
  total_count integer;
  matching_count integer;
BEGIN
  SELECT state_json::jsonb INTO state FROM app_state WHERE id = 1 FOR UPDATE;
  IF state IS NULL THEN RAISE EXCEPTION 'app_state ausente'; END IF;

  FOR match IN SELECT key, value FROM jsonb_each(expected) LOOP
    SELECT campaign INTO item FROM jsonb_array_elements(state->'campaigns') AS campaign
    WHERE campaign->>'id' = match.key;
    IF item IS NULL OR item->>'integrationId' <> 'fe150844-e7b0-4d69-b21b-84e1b588ff12'
       OR item->>'listId' <> '5590cd92-21bb-4145-bcb7-728ffb96f6d6'
       OR item->>'mode' <> 'template_flow'
       OR item->>'templateCacheId' <> match.value->>'templateCacheId'
       OR COALESCE(item->>'flowCacheId', '') <> ''
       OR COALESCE(item->>'metaTemplateId', '1087934300386840') <> '1087934300386840'
       OR COALESCE(item->>'metaFlowId', '1669892138034806') <> '1669892138034806'
    THEN RAISE EXCEPTION 'identidade histórica divergente para %', match.key; END IF;

    SELECT COUNT(*), COUNT(*) FILTER (
      WHERE record_json->'payload'->'template'->>'name' = '001_convencao_visita_casa_cooperativa'
    ) INTO total_count, matching_count
    FROM campaign_messages WHERE campaign_id = match.key;
    IF total_count <> (match.value->>'messages')::integer OR matching_count <> total_count
    THEN RAISE EXCEPTION 'payloads enviados divergentes para %', match.key; END IF;
  END LOOP;

  SELECT jsonb_agg(
    CASE WHEN expected ? (campaign->>'id') THEN
      campaign || jsonb_build_object('metaTemplateId', '1087934300386840', 'metaFlowId', '1669892138034806')
    ELSE campaign END ORDER BY ord
  ) INTO campaigns
  FROM jsonb_array_elements(state->'campaigns') WITH ORDINALITY AS entries(campaign, ord);

  UPDATE app_state SET state_json = jsonb_set(state, '{campaigns}', campaigns)::text,
    updated_at = NOW() WHERE id = 1;
  INSERT INTO audit_logs (id, created_at, record_json)
  SELECT 'waba57-meta-identity-' || campaign_id, NOW(), jsonb_build_object(
    'id', 'waba57-meta-identity-' || campaign_id,
    'actorUserId', NULL,
    'action', 'campaign.meta_identity.backfilled',
    'entityType', 'campaign',
    'entityId', campaign_id,
    'metadata', jsonb_build_object(
      'source', 'backups 20260916-112714 and 20260916-120529; sent template payload verified',
      'metaTemplateId', '1087934300386840', 'metaFlowId', '1669892138034806'
    ),
    'createdAt', NOW()::text
  ) FROM jsonb_object_keys(expected) AS campaign_id
  ON CONFLICT (id) DO NOTHING;
  RAISE NOTICE '3 campanhas verificadas; IDs Meta preenchidos somente no app_state';
END $$;

SELECT campaign->>'id' AS campaign_id, campaign->>'metaTemplateId' AS template_meta_id,
       campaign->>'metaFlowId' AS flow_meta_id
FROM app_state, jsonb_array_elements(state_json::jsonb->'campaigns') AS campaign
WHERE campaign->>'id' IN (
  '4597fdc6-d0cb-4516-b819-01afbedca003',
  'c0285b21-aa6d-477a-a134-6ba02341eaf9',
  'bccfa872-7087-4720-8058-07c01f43f3d0'
) ORDER BY campaign_id;

\if :execute
COMMIT;
\else
ROLLBACK;
\endif
