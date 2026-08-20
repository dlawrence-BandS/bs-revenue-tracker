-- What event_params keys does this property actually send? Run once, eyeball
-- the list for anything that looks like a session identifier (ga_session_id,
-- session_id, sessionId, etc.) or a client/user identifier we could fall
-- back to.

SELECT
  key,
  COUNT(*) AS param_count,
  COUNT(DISTINCT event_name) AS used_by_n_event_types
FROM `commanding-air-450109-p0.analytics_287404213.events_20260814`,
  UNNEST(event_params) AS ep
GROUP BY key
ORDER BY param_count DESC
LIMIT 40;
