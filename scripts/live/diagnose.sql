-- Why didn't a down website open an incident / notify anyone? Run as the database owner:
--   psql "$DB" -v host=ziptat.in -f scripts/live/diagnose.sql
\echo '== platform switches'
SELECT key, value FROM platform_settings WHERE key IN ('monitoring.http.enabled','monitoring.http.failureThreshold','monitoring.deepscan.enabled') ORDER BY key;
\echo '== website'
SELECT w.id, w.name, w.status, w.canonical_origin FROM websites w WHERE w.canonical_origin ILIKE '%' || :'host' || '%';
\echo '== last 15 HTTP checks (FAILED opens an incident after failureThreshold in a row; INCONCLUSIVE never does)'
SELECT e.queued_at, e.status, r.outcome, e.failure_category, left(e.error_message, 80) AS error
  FROM monitoring_executions e LEFT JOIN execution_results r ON r.execution_id = e.id
  JOIN websites w ON w.id = e.website_id
 WHERE w.canonical_origin ILIKE '%' || :'host' || '%' AND e.tier::text LIKE 'T1%'
 ORDER BY e.queued_at DESC LIMIT 15;
\echo '== incidents'
SELECT i.number, i.status, i.severity, i.source, i.title, i.first_detected_at, i.resolved_at
  FROM incidents i JOIN websites w ON w.id = i.website_id
 WHERE w.canonical_origin ILIKE '%' || :'host' || '%' ORDER BY i.first_detected_at DESC LIMIT 10;
\echo '== notification events waiting for worker-notify (published_at empty = worker-notify is not running)'
SELECT topic, created_at, published_at, attempts FROM outbox_events ORDER BY created_at DESC LIMIT 10;
