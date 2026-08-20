-- GA4 computes its own "Default Channel Group" per session and, in newer
-- exports, stores it right here. If this is populated we should use it
-- directly instead of hand-rolling channel logic - it'll exactly match what
-- you see in the GA4 UI and Supermetrics, which is the whole point.

SELECT
  session_traffic_source_last_click.cross_channel_campaign.default_channel_group AS ga4_channel_group,
  session_traffic_source_last_click.cross_channel_campaign.source AS cc_source,
  session_traffic_source_last_click.cross_channel_campaign.medium AS cc_medium,
  COUNT(*) AS event_count
FROM `commanding-air-450109-p0.analytics_287404213.events_20260814`
GROUP BY 1, 2, 3
ORDER BY event_count DESC
LIMIT 30;
