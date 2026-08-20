-- We know 20% of events on 2026-08-14 have no manual_campaign medium/source.
-- That 20% should mostly be genuine organic/direct/referral traffic - but our
-- "Direct" channel is only picking up a handful of sessions. This pulls the
-- full session_traffic_source_last_click struct (as JSON, so we can see every
-- sub-field at once) for a sample of those events, to find where the real
-- organic/direct/referral source data actually lives in this property's schema.

SELECT
  event_name,
  TO_JSON_STRING(session_traffic_source_last_click) AS last_click_struct,
  TO_JSON_STRING(traffic_source) AS first_touch_struct,
  TO_JSON_STRING(collected_traffic_source) AS collected_struct
FROM `commanding-air-450109-p0.analytics_287404213.events_20260814`
WHERE session_traffic_source_last_click.manual_campaign.medium IS NULL
  AND session_traffic_source_last_click.manual_campaign.source IS NULL
  AND event_name = 'session_start'
LIMIT 15;
