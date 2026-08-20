-- ============================================================================
-- bs-revenue-tracker :: BigQuery setup
-- Project: commanding-air-450109-p0
-- GA4 export dataset: analytics_287404213
-- Suggested home for new objects: analytics_287404213 (keep everything together)
-- Run these top to bottom in the BigQuery console (or `bq query`).
-- ============================================================================

-- 1) DATE DIMENSION -----------------------------------------------------------
-- Barker & Stonehouse's financial year starts on the Monday nearest 1 April,
-- runs 52 weeks, Mon-Sun. This table is generated in Python and checked
-- against every FY boundary in your existing tracker (all matched exactly),
-- so there's no fiddly SQL date-math to maintain or get wrong later.
--
-- Load bigquery/dim_date.csv (2020-01-01 to 2031-12-31) into this table:
--   bq load --source_format=CSV --skip_leading_rows=1 \
--     commanding-air-450109-p0:analytics_287404213.dim_date \
--     bigquery/dim_date.csv \
--     date:DATE,financial_year:INT64,week_number:INT64,day_name:STRING

CREATE TABLE IF NOT EXISTS `commanding-air-450109-p0.analytics_287404213.dim_date` (
  date DATE,
  financial_year INT64,
  week_number INT64,
  day_name STRING
);

-- 2) HISTORICAL BACKFILL --------------------------------------------------
-- Your Supermetrics-pulled Data tab (2023-04-03 to 2026-08-16) becomes the
-- permanent record for anything before the dashboard went live on BigQuery.
-- Load data/backfill_channel_daily.csv:
--   bq load --source_format=CSV --skip_leading_rows=1 \
--     commanding-air-450109-p0:analytics_287404213.channel_daily_backfill \
--     data/backfill_channel_daily.csv \
--     date:DATE,channel:STRING,sessions:INT64,revenue:FLOAT64,transactions:INT64,bounce_rate:FLOAT64,avg_session_seconds:FLOAT64,financial_year:INT64,week_number:INT64

CREATE TABLE IF NOT EXISTS `commanding-air-450109-p0.analytics_287404213.channel_daily_backfill` (
  date DATE,
  channel STRING,
  sessions INT64,
  revenue FLOAT64,
  transactions INT64,
  bounce_rate FLOAT64,
  avg_session_seconds FLOAT64,
  financial_year INT64,
  week_number INT64
);

-- 3) LIVE CHANNEL GROUPING (from raw GA4 export) -----------------------------
-- Uses GA4's own pre-computed default_channel_group (session_traffic_source
-- _last_click.cross_channel_campaign.default_channel_group) rather than
-- hand-rolled medium/source matching - confirmed against this property's
-- actual data that it's populated and matches the channel names your old
-- Supermetrics export used (Organic Search, Direct, Paid Shopping,
-- Cross-network, Affiliates, etc).
CREATE OR REPLACE TABLE FUNCTION
  `commanding-air-450109-p0.analytics_287404213.channel_daily_live`(start_date DATE, end_date DATE) AS (

  WITH sessions_raw AS (
    SELECT
      PARSE_DATE('%Y%m%d', event_date) AS date,
      CONCAT(
        CAST(user_pseudo_id AS STRING), '-',
        CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS STRING)
      ) AS session_key,
      -- Google's own pre-computed channel grouping - only populated on some
      -- events per session (the ones carrying last-click info), not every
      -- event, so this gets resolved to one value per session below.
      session_traffic_source_last_click.cross_channel_campaign.default_channel_group AS channel_group_raw,
      event_name,
      (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged') AS session_engaged,
      (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'engagement_time_msec') AS engagement_time_msec,
      ecommerce.purchase_revenue AS purchase_revenue,
      ecommerce.transaction_id AS transaction_id
    FROM `commanding-air-450109-p0.analytics_287404213.events_*`
    WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', start_date) AND FORMAT_DATE('%Y%m%d', end_date)
  ),

  -- Collapse to one row per session first. Two reasons:
  -- 1) default_channel_group and session_engaged are only set on some events
  --    within a session, not every one - a session-level MAX picks up the
  --    one real value and ignores the nulls.
  -- 2) session_engaged flips 0 -> 1 partway through a session once it
  --    becomes engaged, so a session is only a genuine bounce if it NEVER
  --    reaches engaged - checking event-by-event wrongly flagged almost
  --    everything as bounced.
  session_level AS (
    SELECT
      date,
      session_key,
      COALESCE(MAX(channel_group_raw), 'Unassigned') AS channel,
      MAX(IF(session_engaged = '1', 1, 0)) AS engaged,
      SUM(engagement_time_msec) AS engagement_time_msec,
      SUM(IF(event_name = 'purchase', purchase_revenue, 0)) AS revenue,
      COUNT(DISTINCT IF(event_name = 'purchase', transaction_id, NULL)) AS transactions,
      COUNTIF(event_name = 'view_item') AS item_views
    FROM sessions_raw
    GROUP BY date, session_key
  )

  SELECT
    date,
    channel,
    COUNT(*) AS sessions,
    SUM(revenue) AS revenue,
    SUM(transactions) AS transactions,
    SUM(item_views) AS item_views,
    SAFE_DIVIDE(COUNTIF(engaged = 0), COUNT(*)) AS bounce_rate,
    SAFE_DIVIDE(SUM(engagement_time_msec) / 1000, COUNT(*)) AS avg_session_seconds
  FROM session_level
  GROUP BY date, channel
);

-- 4) UNIFIED VIEW --------------------------------------------------------
-- Backfill for anything before your GA4 BigQuery export's retention window,
-- live data for the rest. Live always wins where both exist (it's the more
-- accurate source once available). Adjust the 60-day window in app config
-- if your export retains longer/shorter.
CREATE OR REPLACE VIEW `commanding-air-450109-p0.analytics_287404213.vw_channel_daily` AS
WITH live AS (
  SELECT * FROM `commanding-air-450109-p0.analytics_287404213.channel_daily_live`(
    DATE_SUB(CURRENT_DATE('Europe/London'), INTERVAL 70 DAY),
    CURRENT_DATE('Europe/London')
  )
),
backfill AS (
  SELECT date, channel, sessions, revenue, transactions,
         CAST(NULL AS INT64) AS item_views, bounce_rate, avg_session_seconds
  FROM `commanding-air-450109-p0.analytics_287404213.channel_daily_backfill`
  WHERE date < (SELECT MIN(date) FROM live)
)
SELECT b.*, d.financial_year, d.week_number, d.day_name FROM backfill b
JOIN `commanding-air-450109-p0.analytics_287404213.dim_date` d USING (date)
UNION ALL
SELECT l.*, d.financial_year, d.week_number, d.day_name FROM live l
JOIN `commanding-air-450109-p0.analytics_287404213.dim_date` d USING (date);

-- This is the ONLY object app.js queries directly.
-- SELECT * FROM `commanding-air-450109-p0.analytics_287404213.vw_channel_daily`
-- WHERE financial_year = 2026 ORDER BY date;
