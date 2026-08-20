-- Diagnostic: why does "Direct" have so few sessions but disproportionate
-- revenue/engagement time? Run this for one day (2026-08-14) and eyeball it.

SELECT
  event_name,
  COUNT(*) AS event_count,
  COUNT(DISTINCT (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id')) AS distinct_session_ids,
  COUNTIF((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') IS NULL) AS events_missing_session_id,
  SUM(ecommerce.purchase_revenue) AS total_purchase_revenue
FROM `commanding-air-450109-p0.analytics_287404213.events_20260814`
WHERE
  COALESCE(
    session_traffic_source_last_click.manual_campaign.medium,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'medium')
  ) IS NULL
  AND COALESCE(
    session_traffic_source_last_click.manual_campaign.source,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'source')
  ) IS NULL
GROUP BY event_name
ORDER BY event_count DESC;
