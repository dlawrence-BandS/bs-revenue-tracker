// bs-revenue-tracker :: configuration
// Fill these in before deploying. See README.md for where each value comes from.

const CONFIG = {
  // Same Google OAuth client used across the rest of your dashboard suite.
  // Add this GitHub Pages URL as an authorised JavaScript origin on the
  // client if you haven't already (Google Cloud Console > Credentials).
  GOOGLE_CLIENT_ID: '46227372300-rk63ag0caqgd7n12gjd0nt7f2qi7llqr.apps.googleusercontent.com',

  BIGQUERY_PROJECT_ID: 'commanding-air-450109-p0',
  BIGQUERY_DATASET: 'analytics_287404213',
  // The one view app.js queries - see bigquery/setup.sql
  BIGQUERY_VIEW: 'vw_channel_daily',

  // Paste the /exec URL from your Apps Script deployment here.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyuUFuT5DQc0nBIILzjoHSq2mYLVam7Xp0PXP_Cj5HbNicgjIRSpGhJdKdZk5GG_4HU/exec',',

  // Years shown in year-over-year comparisons.
  COMPARISON_YEARS: [2023, 2024, 2025, 2026],

  // Current financial year - used as the default view on load.
  CURRENT_FY: 2026,

  // Business events worth marking on the trend charts - things that would
  // otherwise look like an unexplained kink in the line. Add to this as
  // things happen; each needs financial_year, week (1-52), and label.
  // Example pre-filled from what's already in memory - delete or adjust the
  // week number if it's off.
  EVENTS: [
    { financial_year: 2026, week: 14, label: 'Flat £15 dining chair delivery rate' }
  ]
};
