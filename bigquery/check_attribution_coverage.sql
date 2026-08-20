-- Sanity check before we rebuild vw_channel_daily: how much of one day's
-- traffic actually gets a real medium/source from session_traffic_source_last_click
-- now that we're not falling back to sparse event-level params?

SELECT
  COUNTIF(session_traffic_source_last_click.manual_campaign.medium IS NOT NULL
       OR session_traffic_source_last_click.manual_campaign.source IS NOT NULL) AS events_with_attribution,
  COUNTIF(session_traffic_source_last_click.manual_campaign.medium IS NULL
      AND session_traffic_source_last_click.manual_campaign.source IS NULL) AS events_with_no_attribution,
  COUNT(*) AS total_events
FROM `commanding-air-450109-p0.analytics_287404213.events_20260814`;
