-- Bounce rate is showing ~99-100% everywhere despite sessions converting -
-- that's not plausible. Checking whether session_engaged is set per-EVENT
-- (meaning early events in a session are '0' even if the session later
-- becomes engaged, which would make my per-event bounce logic wrong) rather
-- than reflecting the session's final engagement state.

SELECT
  user_pseudo_id,
  (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS session_id,
  event_name,
  event_timestamp,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged') AS session_engaged
FROM `commanding-air-450109-p0.analytics_287404213.events_20260814`
WHERE (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') IS NOT NULL
ORDER BY user_pseudo_id, session_id, event_timestamp
LIMIT 40;
