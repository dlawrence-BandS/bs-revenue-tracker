/* bs-revenue-tracker :: app.js
 * Same stack as the rest of the dashboard suite: vanilla JS, Chart.js,
 * Google Identity Services OAuth, tokenInFlight promise coalescing.
 */

// ---------------------------------------------------------------------------
// FY / week helpers — mirrors bigquery/dim_date.csv exactly (nearest Monday
// to 1 April, 52-week years). Only used here for "what week is it today".
// ---------------------------------------------------------------------------
function fyStart(year) {
  const apr1 = new Date(Date.UTC(year, 3, 1));
  const dow = (apr1.getUTCDay() + 6) % 7; // Monday = 0
  const mondayBefore = new Date(apr1);
  mondayBefore.setUTCDate(apr1.getUTCDate() - dow);
  const mondayAfter = new Date(mondayBefore);
  mondayAfter.setUTCDate(mondayBefore.getUTCDate() + 7);
  const distBefore = (apr1 - mondayBefore) / 86400000;
  const distAfter = (mondayAfter - apr1) / 86400000;
  return distBefore <= distAfter ? mondayBefore : mondayAfter;
}

function fyWeekOf(date) {
  let fy = date.getUTCFullYear();
  let start = fyStart(fy);
  if (date < start) {
    fy -= 1;
    start = fyStart(fy);
  } else {
    const next = fyStart(fy + 1);
    if (date >= next) {
      fy += 1;
      start = next;
    }
  }
  const week = Math.floor((date - start) / (7 * 86400000)) + 1;
  return { financial_year: fy, week_number: week };
}

// ---------------------------------------------------------------------------
// Auth — tokenInFlight coalescing so parallel calls don't trigger multiple
// popups.
// ---------------------------------------------------------------------------
let accessToken = null;
let tokenInFlight = null;
let tokenClient = null;

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    callback: '' // set per-request below
  });
}

function getAccessToken() {
  if (accessToken) return Promise.resolve(accessToken);
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      tokenInFlight = null;
      if (resp.error) {
        reject(resp);
        return;
      }
      accessToken = resp.access_token;
      document.getElementById('authStatus').textContent = 'Signed in';
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: '' });
  });
  return tokenInFlight;
}

document.getElementById('signInBtn').addEventListener('click', () => {
  getAccessToken()
    .then(() => loadEverything().catch((e) => {
      console.error('Dashboard failed to load after sign-in', e);
      document.getElementById('authStatus').textContent = 'Signed in — data load failed, see console';
    }))
    .catch((e) => {
      console.error('Auth failed', e);
      document.getElementById('authStatus').textContent = 'Sign-in failed';
    });
});

// ---------------------------------------------------------------------------
// BigQuery
// ---------------------------------------------------------------------------
async function runQuery(sql) {
  const token = await getAccessToken();
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${CONFIG.BIGQUERY_PROJECT_ID}/queries`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30000 })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BigQuery error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const fields = (data.schema && data.schema.fields) || [];
  const rows = (data.rows || []).map((r) => {
    const obj = {};
    r.f.forEach((cell, i) => {
      obj[fields[i].name] = cell.v;
    });
    return obj;
  });
  return rows;
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  return parseFloat(v);
}

async function fetchChannelDaily(fyList) {
  const fys = fyList.join(', ');
  const sql = `
    SELECT date, channel, sessions, revenue, transactions, item_views,
           bounce_rate, avg_session_seconds, financial_year, week_number
    FROM \`${CONFIG.BIGQUERY_PROJECT_ID}.${CONFIG.BIGQUERY_DATASET}.${CONFIG.BIGQUERY_VIEW}\`
    WHERE financial_year IN (${fys})
    ORDER BY date
  `;
  const rows = await runQuery(sql);
  return rows.map((r) => ({
    date: r.date,
    channel: r.channel,
    sessions: num(r.sessions),
    revenue: num(r.revenue),
    transactions: num(r.transactions),
    item_views: num(r.item_views),
    bounce_rate: num(r.bounce_rate),
    avg_session_seconds: num(r.avg_session_seconds),
    financial_year: parseInt(r.financial_year, 10),
    week_number: parseInt(r.week_number, 10)
  }));
}

// ---------------------------------------------------------------------------
// Apps Script backend (manual entries)
// ---------------------------------------------------------------------------
async function fetchManualData() {
  const res = await fetch(`${CONFIG.APPS_SCRIPT_URL}?action=all`);
  if (!res.ok) throw new Error(`Apps Script error ${res.status}`);
  return res.json(); // { revenue: [...], cost: [...] }
}

async function saveRevenue(fy, week, actual, target) {
  await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({
      type: 'revenue',
      financial_year: fy,
      week_number: week,
      actual: actual === '' ? null : actual,
      target: target === '' ? null : target,
      updated_by: 'dashboard'
    })
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  selectedFY: CONFIG.CURRENT_FY,
  entryWeek: null,    // which week's inputs are showing in the entry row; set once todayFYWeek is known
  channelDaily: [],   // rows across all comparison years
  manualRevenue: [],
  onlineMetric: 'revenue',
  channelTrendMetric: 'revenue',
  channelFocus: null,       // set by clicking a channel table row - isolates it in the trend chart
  channelSort: { key: 'revenue', dir: 'desc' },
  kpiCompareMode: 'yoy',     // 'yoy' or 'wow'
  charts: {}
};

const today = new Date();
const todayFYWeek = fyWeekOf(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));
state.entryWeek = state.selectedFY === todayFYWeek.financial_year ? todayFYWeek.week_number : 1;

// The current financial week is still being collected in the background all
// week, but showing it on a trend line makes it look like a sudden drop
// (it's only a few days of data next to 7 full days everywhere else). Trend
// charts hide it until the week is actually finished; the KPI strip still
// shows it deliberately, since that one's meant to show progress mid-week.
function isWeekComplete(fy, week) {
  if (fy < todayFYWeek.financial_year) return true;
  if (fy > todayFYWeek.financial_year) return false;
  return week < todayFYWeek.week_number;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------
function weeklyTotalsForFY(rows, fy) {
  const weeks = {};
  for (let w = 1; w <= 52; w++) weeks[w] = { sessions: 0, revenue: 0, transactions: 0, item_views: 0 };
  rows.filter((r) => r.financial_year === fy).forEach((r) => {
    const w = weeks[r.week_number];
    if (!w) return;
    w.sessions += r.sessions;
    w.revenue += r.revenue;
    w.transactions += r.transactions;
    w.item_views += r.item_views;
  });
  return weeks;
}

function channelTotalsForFY(rows, fy) {
  const totals = {};
  rows.filter((r) => r.financial_year === fy).forEach((r) => {
    if (!totals[r.channel]) totals[r.channel] = { sessions: 0, revenue: 0, transactions: 0, item_views: 0 };
    const t = totals[r.channel];
    t.sessions += r.sessions;
    t.revenue += r.revenue;
    t.transactions += r.transactions;
    t.item_views += r.item_views;
  });
  return totals;
}

// One row per channel per week, for the channel trend chart.
function channelWeeklySeriesForFY(rows, fy) {
  const series = {};
  rows.filter((r) => r.financial_year === fy).forEach((r) => {
    if (!series[r.channel]) series[r.channel] = {};
    if (!series[r.channel][r.week_number]) {
      series[r.channel][r.week_number] = { sessions: 0, revenue: 0, transactions: 0, item_views: 0 };
    }
    const w = series[r.channel][r.week_number];
    w.sessions += r.sessions;
    w.revenue += r.revenue;
    w.transactions += r.transactions;
    w.item_views += r.item_views;
  });
  return series;
}

// Muted qualitative palette that still reads as part of the blue theme -
// data lines need to be distinguishable, which a pure single-hue set can't
// do at 8 channels, so this mixes in gold/teal/plum/slate around the core
// brand blue.
const CHANNEL_COLORS = ['#2f5c8a', '#c98a2b', '#1c7a63', '#7a4fa0', '#b23a3a', '#4c7fb0', '#8c6d46', '#5c6b7a'];

function pctDelta(current, prior) {
  if (!prior) return null;
  return (current - prior) / prior;
}

function fmtGBP(v) {
  return '£' + Math.round(v).toLocaleString('en-GB');
}

function fmtPct(v, digits = 1) {
  return (v * 100).toFixed(digits) + '%';
}

function fmtDelta(v) {
  if (v === null || v === undefined || !isFinite(v)) return { text: '—', cls: 'flat' };
  const cls = v > 0.001 ? 'up' : v < -0.001 ? 'down' : 'flat';
  const sign = v > 0 ? '+' : '';
  return { text: `${sign}${fmtPct(v)} YoY`, cls };
}

// ---------------------------------------------------------------------------
// Chart plugin: draws vertical markers for business events (config-driven)
// so a shift in the line has an obvious cause instead of just looking odd.
// ---------------------------------------------------------------------------
const eventAnnotationPlugin = {
  id: 'eventAnnotations',
  afterDraw(chart) {
    const events = chart.options.plugins?.eventAnnotations?.events || [];
    if (!events.length) return;
    const { ctx, chartArea, scales } = chart;
    events.forEach((ev) => {
      const x = scales.x.getPixelForValue(ev.week);
      if (x < chartArea.left || x > chartArea.right) return;
      ctx.save();
      ctx.strokeStyle = '#5c6b7a';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = '#5c6b7a';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = x > chartArea.right - 90 ? 'right' : 'left';
      const tx = x > chartArea.right - 90 ? x - 4 : x + 4;
      ctx.fillText(ev.label, tx, chartArea.top + 11);
      ctx.restore();
    });
  }
};
Chart.register(eventAnnotationPlugin);

function eventsForFY(fy) {
  return (CONFIG.EVENTS || []).filter((e) => e.financial_year === fy);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderLedger() {
  const ledger = document.getElementById('ledger');
  ledger.innerHTML = '';
  const fyRows = state.channelDaily.filter((r) => r.financial_year === state.selectedFY);
  const weeksWithData = new Set(fyRows.map((r) => r.week_number));
  for (let w = 1; w <= 52; w++) {
    const btn = document.createElement('button');
    btn.className = 'tick';
    if (weeksWithData.has(w)) btn.classList.add('has-data');
    if (state.selectedFY === todayFYWeek.financial_year && w === todayFYWeek.week_number) {
      btn.classList.add('current');
    }
    if (w === state.entryWeek) {
      btn.classList.add('selected');
    }
    const span = document.createElement('span');
    span.className = 'num';
    span.textContent = w;
    btn.appendChild(span);
    btn.title = `Week ${w}`;
    btn.addEventListener('click', () => focusWeek(w));
    ledger.appendChild(btn);
  }
  document.getElementById('ledgerCaption').textContent =
    `FY${state.selectedFY} · ${weeksWithData.size} of 52 weeks with online data`;
}

function focusWeek(w) {
  state.entryWeek = w;
  document.getElementById('entryWeekLabel').textContent = `Editing FY${state.selectedFY} · Week ${w}`;
  const existing = state.manualRevenue.find((r) => r.financial_year === state.selectedFY && r.week_number === w);
  document.getElementById('revenueActualInput').value = existing?.actual ?? '';
  document.getElementById('revenueTargetInput').value = existing?.target ?? '';
  updateURL();
  // Re-render the ledger (so the outlined "selected" tick moves) and the KPI
  // row (which now shows whichever week is selected, not just "today").
  renderLedger();
  renderKPIs();
}

// Trailing N complete weeks of a metric for a given FY, oldest first - used
// to draw the little sparkline in each KPI card.
function trailingWeeklySeries(fy, metricFn, count = 8, endWeek = null) {
  const weekly = weeklyTotalsForFY(state.channelDaily, fy);
  const lastComplete = fy === todayFYWeek.financial_year ? todayFYWeek.week_number - 1 : 52;
  const end = endWeek != null ? Math.min(endWeek, lastComplete) : lastComplete;
  const values = [];
  for (let w = Math.max(1, end - count + 1); w <= end; w++) {
    const d = weekly[w];
    values.push(d ? metricFn(d) : null);
  }
  return values;
}

function sparklineSVG(values) {
  const clean = values.filter((v) => v != null && isFinite(v));
  if (clean.length < 2) return '';
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const w = 120;
  const h = 28;
  const step = w / (values.length - 1);
  let x = 0;
  const points = values.map((v) => {
    const px = x;
    x += step;
    if (v == null) return null;
    const py = h - ((v - min) / range) * h;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).filter(Boolean).join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/>
  </svg>`;
}

// "At this pace, FY finishes at £X" - based on actual weeks entered so far
// this year, projected across the remaining weeks. Needs at least 3 entered
// weeks to be worth showing.
// Typical cumulative share of the year's revenue reached by the end of each
// week, averaged across whichever prior financial years have (near) complete
// data. This is what makes the projection seasonal instead of flat - a
// furniture retailer doesn't sell evenly across 52 weeks, so "average the
// weeks so far and multiply by 52" badly over/under-shoots around big swings
// like garden furniture season or January.
function seasonalCumulativeCurve() {
  const historicalYears = CONFIG.COMPARISON_YEARS.filter((y) => y < todayFYWeek.financial_year);
  const curves = [];
  historicalYears.forEach((fy) => {
    const rows = state.manualRevenue.filter((r) => r.financial_year === fy && r.actual != null);
    if (rows.length < 40) return; // too sparse a year to trust its shape
    const byWeek = {};
    rows.forEach((r) => { byWeek[r.week_number] = r.actual; });
    const total = rows.reduce((a, r) => a + r.actual, 0);
    if (!total) return;
    let running = 0;
    const cum = [0];
    for (let w = 1; w <= 52; w++) {
      running += byWeek[w] || 0;
      cum[w] = running / total;
    }
    curves.push(cum);
  });
  if (!curves.length) return null;
  const avg = [0];
  for (let w = 1; w <= 52; w++) {
    avg[w] = curves.reduce((a, c) => a + c[w], 0) / curves.length;
  }
  return avg; // avg[w] = typical cumulative fraction of the year reached by end of week w
}

function fyProjection(fy) {
  const rows = state.manualRevenue.filter((r) => r.financial_year === fy && r.actual != null);
  if (rows.length < 3) return null;
  const lastWeek = Math.max(...rows.map((r) => r.week_number));
  if (lastWeek >= 52) return null; // year's already complete, nothing to project

  const cumulativeActual = rows
    .filter((r) => r.week_number <= lastWeek)
    .reduce((a, r) => a + r.actual, 0);

  const curve = seasonalCumulativeCurve();
  let projectedTotal;
  let method;
  if (curve && curve[lastWeek] > 0.02) {
    projectedTotal = cumulativeActual / curve[lastWeek];
    method = 'seasonal';
  } else {
    // Not enough historical shape to trust yet (e.g. this tracker is brand
    // new) - fall back to a flat average rather than showing nothing.
    const avgWeekly = cumulativeActual / lastWeek;
    projectedTotal = avgWeekly * 52;
    method = 'flat';
  }

  // A confirmed annual target (config.js) is a firmer number than
  // extrapolating from whichever weekly targets happen to be filled in, so
  // it takes priority when set.
  let annualTarget = CONFIG.ANNUAL_TARGET || null;
  if (!annualTarget) {
    const targetRows = state.manualRevenue.filter((r) => r.financial_year === fy && r.target != null);
    if (targetRows.length >= 26) {
      const avgTarget = targetRows.reduce((a, r) => a + r.target, 0) / targetRows.length;
      annualTarget = avgTarget * 52;
    }
  }

  return { projectedTotal, annualTarget, weeksEntered: rows.length, lastWeek, method, curve };
}

// Blends real weekly targets (where Peter's set one) with an implied split
// of the confirmed annual target for any week that doesn't have one yet -
// so the target line on the chart covers the full 52 weeks instead of
// stopping wherever the manually-entered targets run out.
function weeklyTargetSeries(fy) {
  const curve = seasonalCumulativeCurve();
  const explicit = {};
  state.manualRevenue
    .filter((r) => r.financial_year === fy && r.target != null)
    .forEach((r) => { explicit[r.week_number] = r.target; });

  const series = [];
  for (let w = 1; w <= 52; w++) {
    if (explicit[w] != null) {
      series[w] = explicit[w];
    } else if (curve && CONFIG.ANNUAL_TARGET) {
      series[w] = CONFIG.ANNUAL_TARGET * (curve[w] - curve[w - 1]);
    } else {
      series[w] = null;
    }
  }
  return { series, hasImplied: !!(curve && CONFIG.ANNUAL_TARGET), explicitWeeks: Object.keys(explicit).length };
}

// "You're behind pace, here's where the biggest weeks left are" - ranks the
// remaining weeks by their typical seasonal share of revenue, since closing
// a gap is realistically about the big weeks (garden furniture season,
// pre-Christmas etc), not the quiet ones.
function recoveryFocus(fy) {
  if (!CONFIG.ANNUAL_TARGET) return null;
  const rows = state.manualRevenue.filter((r) => r.financial_year === fy && r.actual != null);
  if (!rows.length) return null;
  const lastWeek = Math.max(...rows.map((r) => r.week_number));
  const curve = seasonalCumulativeCurve();
  if (!curve) return null;

  const cumulativeActual = rows.filter((r) => r.week_number <= lastWeek).reduce((a, r) => a + r.actual, 0);
  const cumulativeTargetToDate = curve[lastWeek] * CONFIG.ANNUAL_TARGET;
  const shortfall = cumulativeTargetToDate - cumulativeActual; // positive = behind

  const remaining = [];
  for (let w = lastWeek + 1; w <= 52; w++) {
    const impliedTarget = CONFIG.ANNUAL_TARGET * (curve[w] - curve[w - 1]);
    const historicalRows = CONFIG.COMPARISON_YEARS
      .filter((y) => y < todayFYWeek.financial_year)
      .map((y) => state.manualRevenue.find((r) => r.financial_year === y && r.week_number === w))
      .filter(Boolean);
    const historicalAvg = historicalRows.length
      ? historicalRows.reduce((a, r) => a + r.actual, 0) / historicalRows.length
      : null;
    remaining.push({ week: w, impliedTarget, historicalAvg });
  }
  remaining.sort((a, b) => b.impliedTarget - a.impliedTarget);
  const opportunityWeeks = remaining.slice(0, 6);
  const quietWeeks = remaining.slice(-6).reverse();

  return {
    lastWeek, cumulativeActual, cumulativeTargetToDate, shortfall,
    pctOfTargetReached: cumulativeActual / CONFIG.ANNUAL_TARGET,
    pctExpectedByNow: curve[lastWeek],
    opportunityWeeks, quietWeeks
  };
}

// Auto-generated read of what's moving - channel winners/losers YoY and
// whether CVR/AOV are helping or hurting, so the numbers on the page turn
// into "here's what to look at" rather than just a wall of figures.
function computeInsights(fy) {
  const priorFY = fy - 1;
  const insights = [];
  const lastWeek = todayFYWeek.financial_year === fy ? todayFYWeek.week_number - 1 : 52;
  if (lastWeek < 1) return insights;

  const curRows = state.channelDaily.filter((r) => r.financial_year === fy && r.week_number <= lastWeek);
  const priorRows = state.channelDaily.filter((r) => r.financial_year === priorFY && r.week_number <= lastWeek);

  const sumByChannel = (rows) => {
    const t = {};
    rows.forEach((r) => {
      if (!t[r.channel]) t[r.channel] = { sessions: 0, revenue: 0, transactions: 0 };
      t[r.channel].sessions += r.sessions;
      t[r.channel].revenue += r.revenue;
      t[r.channel].transactions += r.transactions;
    });
    return t;
  };
  const curTotals = sumByChannel(curRows);
  const priorTotals = sumByChannel(priorRows);

  const movers = Object.keys(curTotals)
    .filter((ch) => priorTotals[ch] && priorTotals[ch].revenue > 1000) // ignore tiny/noisy channels
    .map((ch) => ({
      channel: ch,
      curRevenue: curTotals[ch].revenue,
      priorRevenue: priorTotals[ch].revenue,
      delta: (curTotals[ch].revenue - priorTotals[ch].revenue) / priorTotals[ch].revenue
    }))
    .sort((a, b) => a.delta - b.delta);

  const decliners = movers.filter((m) => m.delta < -0.1).slice(0, 3);
  const growers = movers.filter((m) => m.delta > 0.1).sort((a, b) => b.delta - a.delta).slice(0, 3);

  decliners.forEach((m) => insights.push({
    type: 'watch',
    text: `${m.channel} is down ${fmtPct(Math.abs(m.delta))} YoY to date (${fmtGBP(m.curRevenue)} vs ${fmtGBP(m.priorRevenue)}) — worth a look.`
  }));
  growers.forEach((m) => insights.push({
    type: 'good',
    text: `${m.channel} is up ${fmtPct(m.delta)} YoY to date (${fmtGBP(m.curRevenue)} vs ${fmtGBP(m.priorRevenue)}) — whatever's driving this is working.`
  }));

  const curAll = Object.values(curTotals).reduce((a, t) => ({ sessions: a.sessions + t.sessions, revenue: a.revenue + t.revenue, transactions: a.transactions + t.transactions }), { sessions: 0, revenue: 0, transactions: 0 });
  const priorAll = Object.values(priorTotals).reduce((a, t) => ({ sessions: a.sessions + t.sessions, revenue: a.revenue + t.revenue, transactions: a.transactions + t.transactions }), { sessions: 0, revenue: 0, transactions: 0 });
  const curCVR = curAll.sessions ? curAll.transactions / curAll.sessions : 0;
  const priorCVR = priorAll.sessions ? priorAll.transactions / priorAll.sessions : 0;
  const cvrDelta = pctDelta(curCVR, priorCVR);
  if (cvrDelta != null && cvrDelta < -0.05) {
    insights.push({ type: 'watch', text: `Site-wide CVR is down ${fmtPct(Math.abs(cvrDelta))} YoY to date — sessions may look fine while fewer of them convert.` });
  } else if (cvrDelta != null && cvrDelta > 0.05) {
    insights.push({ type: 'good', text: `Site-wide CVR is up ${fmtPct(cvrDelta)} YoY to date.` });
  }

  const curAOV = curAll.transactions ? curAll.revenue / curAll.transactions : 0;
  const priorAOV = priorAll.transactions ? priorAll.revenue / priorAll.transactions : 0;
  const aovDelta = pctDelta(curAOV, priorAOV);
  if (aovDelta != null && aovDelta < -0.05) {
    insights.push({ type: 'watch', text: `AOV is down ${fmtPct(Math.abs(aovDelta))} YoY to date (${fmtGBP(curAOV)} vs ${fmtGBP(priorAOV)}).` });
  }

  // Concentration risk: how much of revenue sits in the single biggest channel
  const sortedByRevenue = Object.entries(curTotals).sort((a, b) => b[1].revenue - a[1].revenue);
  if (sortedByRevenue.length && curAll.revenue > 0) {
    const topShare = sortedByRevenue[0][1].revenue / curAll.revenue;
    if (topShare > 0.4) {
      insights.push({ type: 'neutral', text: `${sortedByRevenue[0][0]} is ${fmtPct(topShare)} of online revenue to date — a lot riding on one channel.` });
    }
  }

  return insights;
}

function renderKPIs() {
  const fy = state.selectedFY;
  const compareFY = state.kpiCompareMode === 'yoy' ? fy - 1 : fy;
  const wk = state.entryWeek; // whichever week is selected in the ledger above - not necessarily "today"
  const compareWk = state.kpiCompareMode === 'yoy' ? wk : wk - 1;

  const curWeekRows = state.channelDaily.filter((r) => r.financial_year === fy && r.week_number === wk);
  const priorWeekRows = state.channelDaily.filter((r) => r.financial_year === compareFY && r.week_number === compareWk);

  const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);
  const curRevenue = sum(curWeekRows, 'revenue');
  const priorRevenue = sum(priorWeekRows, 'revenue');
  const curSessions = sum(curWeekRows, 'sessions');
  const priorSessions = sum(priorWeekRows, 'sessions');
  const curTx = sum(curWeekRows, 'transactions');
  const priorTx = sum(priorWeekRows, 'transactions');
  const curCVR = curSessions ? curTx / curSessions : 0;
  const priorCVR = priorSessions ? priorTx / priorSessions : 0;
  const curAOV = curTx ? curRevenue / curTx : 0;
  const priorAOV = priorTx ? priorRevenue / priorTx : 0;
  const curItemViews = sum(curWeekRows, 'item_views');
  const priorItemViews = sum(priorWeekRows, 'item_views');

  const compareLabel = state.kpiCompareMode === 'yoy' ? 'YoY' : 'WoW';
  const deltaWithLabel = (v) => {
    const d = fmtDelta(v);
    d.text = d.text === '—' ? d.text : d.text.replace('YoY', compareLabel);
    return d;
  };

  const businessRow = state.manualRevenue.find((r) => r.financial_year === fy && r.week_number === wk);
  const businessActual = businessRow?.actual;
  const businessTarget = businessRow?.target;
  const businessDelta = businessActual != null && businessTarget ? (businessActual - businessTarget) / businessTarget : null;

  const kpis = [
    { label: `Business revenue · wk ${wk}`, value: businessActual != null ? fmtGBP(businessActual) : 'Not entered',
      delta: businessDelta != null ? { text: `${businessDelta > 0 ? '+' : ''}${fmtPct(businessDelta)} vs target`, cls: businessDelta >= 0 ? 'up' : 'down' } : { text: businessTarget ? `Target ${fmtGBP(businessTarget)}` : '—', cls: 'flat' },
      spark: '' },
    { label: `Online revenue · wk ${wk}`, value: fmtGBP(curRevenue), delta: deltaWithLabel(pctDelta(curRevenue, priorRevenue)),
      spark: sparklineSVG(trailingWeeklySeries(fy, (d) => d.revenue, 8, wk)) },
    { label: `Sessions · wk ${wk}`, value: Math.round(curSessions).toLocaleString('en-GB'), delta: deltaWithLabel(pctDelta(curSessions, priorSessions)),
      spark: sparklineSVG(trailingWeeklySeries(fy, (d) => d.sessions, 8, wk)) },
    { label: `Transactions · wk ${wk}`, value: Math.round(curTx).toLocaleString('en-GB'), delta: deltaWithLabel(pctDelta(curTx, priorTx)),
      spark: sparklineSVG(trailingWeeklySeries(fy, (d) => d.transactions, 8, wk)) },
    { label: `CVR · wk ${wk}`, value: fmtPct(curCVR, 2), delta: deltaWithLabel(pctDelta(curCVR, priorCVR)),
      spark: sparklineSVG(trailingWeeklySeries(fy, (d) => (d.sessions ? d.transactions / d.sessions : null), 8, wk)) },
    { label: `AOV · wk ${wk}`, value: fmtGBP(curAOV), delta: deltaWithLabel(pctDelta(curAOV, priorAOV)),
      spark: sparklineSVG(trailingWeeklySeries(fy, (d) => (d.transactions ? d.revenue / d.transactions : null), 8, wk)) },
    { label: `Item views · wk ${wk}`, value: Math.round(curItemViews).toLocaleString('en-GB'), delta: deltaWithLabel(pctDelta(curItemViews, priorItemViews)),
      spark: sparklineSVG(trailingWeeklySeries(fy, (d) => d.item_views, 8, wk)) }
  ];

  const proj = fyProjection(fy);
  if (proj) {
    const vsTarget = proj.annualTarget ? (proj.projectedTotal - proj.annualTarget) / proj.annualTarget : null;
    const methodNote = proj.method === 'flat' ? ' (flat estimate — not enough history for a seasonal one)' : '';
    kpis.push({
      label: `Projected FY total · from ${proj.weeksEntered}wk`,
      value: fmtGBP(proj.projectedTotal),
      delta: vsTarget != null
        ? { text: `${vsTarget > 0 ? '+' : ''}${fmtPct(vsTarget)} vs annualised target`, cls: vsTarget >= 0 ? 'up' : 'down' }
        : { text: `Not enough target data to compare${methodNote}`, cls: 'flat' },
      spark: ''
    });
  }

  const row = document.getElementById('kpiRow');
  row.innerHTML = kpis.map((k) => `
    <div class="kpi">
      <div class="label">${k.label}</div>
      <div class="value">${k.value}</div>
      <div class="delta ${k.delta.cls}">${k.delta.text}</div>
      ${k.spark}
    </div>
  `).join('');
}

function bestWorstWeeks(fy) {
  const rows = state.manualRevenue.filter((r) => r.financial_year === fy && r.actual != null);
  if (!rows.length) return null;
  const best = rows.reduce((a, b) => (b.actual > a.actual ? b : a));
  const worst = rows.reduce((a, b) => (b.actual < a.actual ? b : a));
  return { best, worst };
}

function renderRevenueChart() {
  const ctx = document.getElementById('revenueChart');
  const labels = Array.from({ length: 52 }, (_, i) => i + 1);

  const datasets = CONFIG.COMPARISON_YEARS.map((fy, idx) => {
    const values = labels.map((w) => {
      const row = state.manualRevenue.find((r) => r.financial_year === fy && r.week_number === w);
      return row ? row.actual : null;
    });
    const isCurrent = fy === state.selectedFY;
    return {
      label: `FY${fy} actual`,
      data: values,
      borderColor: isCurrent ? '#c98a2b' : `hsl(${205 + idx * 30}, 35%, 42%)`,
      borderWidth: isCurrent ? 3 : 1.5,
      pointRadius: 0,
      tension: 0.25,
      spanGaps: true
    };
  });

  const targetInfo = weeklyTargetSeries(state.selectedFY);
  const targetValues = labels.map((w) => targetInfo.series[w] ?? null);
  datasets.push({
    label: `FY${state.selectedFY} target`,
    data: targetValues,
    borderColor: '#12213d',
    borderDash: [4, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    spanGaps: true
  });

  const proj = fyProjection(state.selectedFY);
  if (proj && proj.curve) {
    const forecastValues = labels.map(() => null);
    const lastActualRow = state.manualRevenue.find(
      (r) => r.financial_year === state.selectedFY && r.week_number === proj.lastWeek
    );
    // Anchor the dashed forecast line to the last real point so it visibly
    // continues the solid line rather than floating separately.
    forecastValues[proj.lastWeek - 1] = lastActualRow ? lastActualRow.actual : null;
    for (let w = proj.lastWeek + 1; w <= 52; w++) {
      const weeklyShare = proj.curve[w] - proj.curve[w - 1];
      forecastValues[w - 1] = proj.projectedTotal * weeklyShare;
    }
    datasets.push({
      label: `FY${state.selectedFY} forecast`,
      data: forecastValues,
      borderColor: '#c98a2b',
      borderDash: [2, 3],
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.25,
      spanGaps: true
    });
  }

  if (state.charts.revenue) state.charts.revenue.destroy();
  state.charts.revenue = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: chartOptions('£', false, eventsForFY(state.selectedFY))
  });

  const bw = bestWorstWeeks(state.selectedFY);
  const el = document.getElementById('revenueBestWorst');
  if (el) {
    el.textContent = bw
      ? `Best week so far: Wk${bw.best.week_number} · ${fmtGBP(bw.best.actual)}  ·  Softest week: Wk${bw.worst.week_number} · ${fmtGBP(bw.worst.actual)}`
      : '';
  }

  const forecastNote = document.getElementById('revenueForecastNote');
  if (forecastNote) {
    if (proj) {
      forecastNote.textContent = proj.method === 'seasonal'
        ? `Dashed gold from Wk${proj.lastWeek} is a forecast — projects to £${Math.round(proj.projectedTotal).toLocaleString('en-GB')} using the typical week-by-week shape of FY${CONFIG.COMPARISON_YEARS.filter((y) => y < todayFYWeek.financial_year).join('/')}, not a flat average.`
        : `Dashed gold from Wk${proj.lastWeek} is a rough forecast (flat average) — not enough complete prior years yet to base it on seasonal shape.`;
    } else {
      forecastNote.textContent = '';
    }
  }

  const targetNote = document.getElementById('revenueTargetNote');
  if (targetNote) {
    targetNote.textContent = targetInfo.hasImplied
      ? `Dashed black target: Wk1–${targetInfo.explicitWeeks} uses the numbers set for those weeks; the rest splits the £${(CONFIG.ANNUAL_TARGET / 1e6).toFixed(1)}m annual target across the remaining weeks by the same seasonal shape.`
      : (targetInfo.explicitWeeks ? `Dashed black target covers ${targetInfo.explicitWeeks} of 52 weeks — set CONFIG.ANNUAL_TARGET in config.js to fill in the rest.` : '');
  }
}

function renderOnlineChart() {
  const ctx = document.getElementById('onlineChart');
  const labels = Array.from({ length: 52 }, (_, i) => i + 1);
  const metric = state.onlineMetric;

  const datasets = CONFIG.COMPARISON_YEARS.map((fy, idx) => {
    const weekly = weeklyTotalsForFY(state.channelDaily, fy);
    const values = labels.map((w) => {
      if (!isWeekComplete(fy, w)) return null;
      const d = weekly[w];
      if (!d) return null;
      if (metric === 'cvr') return d.sessions ? (d.transactions / d.sessions) : null;
      if (metric === 'aov') return d.transactions ? (d.revenue / d.transactions) : null;
      return d[metric] || null;
    });
    const isCurrent = fy === state.selectedFY;
    return {
      label: `FY${fy}`,
      data: values,
      borderColor: isCurrent ? '#c98a2b' : `hsl(${205 + idx * 30}, 35%, 42%)`,
      borderWidth: isCurrent ? 3 : 1.5,
      pointRadius: 0,
      tension: 0.25,
      spanGaps: true
    };
  });

  const prefix = metric === 'revenue' || metric === 'aov' ? '£' : '';
  const isPct = metric === 'cvr';

  if (state.charts.online) state.charts.online.destroy();
  state.charts.online = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: chartOptions(prefix, isPct, eventsForFY(state.selectedFY))
  });
}

function renderChannelTrendChart() {
  const ctx = document.getElementById('channelTrendChart');
  const labels = Array.from({ length: 52 }, (_, i) => i + 1);
  const metric = state.channelTrendMetric;
  const fy = state.selectedFY;

  const totals = channelTotalsForFY(state.channelDaily, fy);
  const series = channelWeeklySeriesForFY(state.channelDaily, fy);

  const channelsToShow = state.channelFocus
    ? [state.channelFocus]
    : Object.entries(totals).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 8).map(([c]) => c);

  const datasets = channelsToShow.map((channel, idx) => {
    const weekly = series[channel] || {};
    const values = labels.map((w) => {
      if (!isWeekComplete(fy, w)) return null;
      const d = weekly[w];
      if (!d) return null;
      return d[metric] || null;
    });
    return {
      label: channel,
      data: values,
      borderColor: CHANNEL_COLORS[idx % CHANNEL_COLORS.length],
      borderWidth: state.channelFocus ? 3 : 2,
      pointRadius: 0,
      tension: 0.25,
      spanGaps: true
    };
  });

  const prefix = metric === 'revenue' ? '£' : '';

  if (state.charts.channelTrend) state.charts.channelTrend.destroy();
  state.charts.channelTrend = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: chartOptions(prefix, false, eventsForFY(fy))
  });

  const focusNote = document.getElementById('channelTrendFocusNote');
  if (focusNote) {
    focusNote.innerHTML = state.channelFocus
      ? `Showing <strong>${state.channelFocus}</strong> only — <button id="clearChannelFocusBtn" type="button">Show top 8 instead</button>`
      : '';
    const clearBtn = document.getElementById('clearChannelFocusBtn');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      state.channelFocus = null;
      renderChannelTrendChart();
      renderChannelTable();
    });
  }
}

function chartOptions(prefix = '', isPct = false, events = []) {
  return {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { family: 'Inter', size: 11 } } },
      eventAnnotations: { events },
      tooltip: {
        callbacks: {
          label: (item) => {
            let v = item.raw;
            if (v === null) return `${item.dataset.label}: —`;
            if (isPct) v = (v * 100).toFixed(2) + '%';
            else v = prefix + Math.round(v).toLocaleString('en-GB');
            return `${item.dataset.label}: ${v}`;
          }
        }
      }
    },
    scales: {
      x: { title: { display: true, text: 'Financial week' }, grid: { display: false } },
      y: {
        ticks: {
          callback: (v) => isPct ? (v * 100).toFixed(0) + '%' : prefix + v.toLocaleString('en-GB')
        },
        grid: { color: '#e2e9f1' }
      }
    }
  };
}

const CHANNEL_SORT_KEYS = ['channel', 'sessions', 'transactions', 'revenue', 'cvr', 'aov', 'item_views'];

function channelTableRows() {
  const totals = channelTotalsForFY(state.channelDaily, state.selectedFY);
  const rows = Object.entries(totals).map(([channel, t]) => ({
    channel,
    sessions: t.sessions,
    transactions: t.transactions,
    revenue: t.revenue,
    cvr: t.sessions ? t.transactions / t.sessions : 0,
    aov: t.transactions ? t.revenue / t.transactions : 0,
    item_views: t.item_views
  }));
  const { key, dir } = state.channelSort;
  rows.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return dir === 'asc' ? cmp : -cmp;
  });
  return rows;
}

function renderRecoveryFocus() {
  const panel = document.getElementById('recoveryFocusPanel');
  if (!panel) return;
  const rf = recoveryFocus(state.selectedFY);

  if (!rf) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  const behindOrAhead = rf.shortfall > 0 ? 'behind' : 'ahead of';
  const headline = document.getElementById('recoveryHeadline');
  headline.innerHTML = `
    <div class="recovery-stat">
      <div class="label">Pace vs £${(CONFIG.ANNUAL_TARGET / 1e6).toFixed(1)}m target</div>
      <div class="value ${rf.shortfall > 0 ? 'down' : 'up'}">${fmtGBP(Math.abs(rf.shortfall))} ${behindOrAhead}</div>
      <div class="note">${fmtPct(rf.pctOfTargetReached)} of target reached by Wk${rf.lastWeek} · typically ${fmtPct(rf.pctExpectedByNow)} by now</div>
    </div>
  `;

  const oppList = document.getElementById('opportunityWeeksList');
  oppList.innerHTML = rf.opportunityWeeks.map((w) => `
    <li>
      <span class="week-badge">Wk${w.week}</span>
      <span class="week-detail">Implied target ${fmtGBP(w.impliedTarget)}${w.historicalAvg != null ? ` · historically averaged ${fmtGBP(w.historicalAvg)}` : ''}</span>
    </li>
  `).join('');

  const quietList = document.getElementById('quietWeeksList');
  quietList.innerHTML = rf.quietWeeks.map((w) => `Wk${w.week} (${fmtGBP(w.impliedTarget)})`).join(', ');
}

function renderInsights() {
  const panel = document.getElementById('insightsPanel');
  if (!panel) return;
  const insights = computeInsights(state.selectedFY);
  const list = document.getElementById('insightsList');

  if (!insights.length) {
    list.innerHTML = '<li class="insight-neutral">Nothing standing out yet — check back once more of the year has data.</li>';
    return;
  }

  const icon = { watch: '⚠️', good: '✓', neutral: '·' };
  list.innerHTML = insights.map((i) => `
    <li class="insight-${i.type}"><span class="insight-icon">${icon[i.type]}</span> ${i.text}</li>
  `).join('');
}

function renderChannelTable() {
  const rows = channelTableRows();
  const tbody = document.getElementById('channelTableBody');
  tbody.innerHTML = rows.map((r) => `
    <tr class="channel-row${state.channelFocus === r.channel ? ' selected-row' : ''}" data-channel="${r.channel}">
      <td>${r.channel}</td>
      <td>${Math.round(r.sessions).toLocaleString('en-GB')}</td>
      <td>${Math.round(r.transactions).toLocaleString('en-GB')}</td>
      <td>${fmtGBP(r.revenue)}</td>
      <td>${fmtPct(r.cvr, 2)}</td>
      <td>${fmtGBP(r.aov)}</td>
      <td>${Math.round(r.item_views).toLocaleString('en-GB')}</td>
    </tr>
  `).join('');

  // Update sort-direction arrows in the header
  document.querySelectorAll('#channelTable th[data-sort-key]').forEach((th) => {
    const key = th.dataset.sortKey;
    th.classList.toggle('sorted', key === state.channelSort.key);
    th.querySelector('.sort-arrow').textContent =
      key === state.channelSort.key ? (state.channelSort.dir === 'asc' ? '▲' : '▼') : '';
  });

  document.querySelectorAll('#channelTableBody tr.channel-row').forEach((tr) => {
    tr.addEventListener('click', () => {
      const channel = tr.dataset.channel;
      state.channelFocus = state.channelFocus === channel ? null : channel;
      renderChannelTable();
      renderChannelTrendChart();

      // The chart this affects sits above the table, easy to miss the
      // connection - scroll to it and flash it briefly so it's obvious
      // clicking the row actually changed something up there.
      const chartPanel = document.getElementById('channelTrendPanel');
      if (chartPanel) {
        chartPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        chartPanel.classList.remove('flash');
        // eslint-disable-next-line no-unused-expressions
        chartPanel.offsetWidth; // restart the animation if it's already mid-flash
        chartPanel.classList.add('flash');
      }
    });
  });
}

function exportChannelTableCSV() {
  const rows = channelTableRows();
  const header = ['Channel', 'Sessions', 'Transactions', 'Revenue', 'CVR%', 'AOV', 'Item views'];
  const lines = [header.join(',')];
  rows.forEach((r) => {
    lines.push([
      `"${r.channel}"`,
      Math.round(r.sessions),
      Math.round(r.transactions),
      r.revenue.toFixed(2),
      (r.cvr * 100).toFixed(2),
      r.aov.toFixed(2),
      Math.round(r.item_views)
    ].join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `channel-breakdown-FY${state.selectedFY}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function renderFYSelect() {
  const select = document.getElementById('fySelect');
  select.innerHTML = CONFIG.COMPARISON_YEARS.map((fy) => `<option value="${fy}">FY${fy}</option>`).join('');
  select.value = state.selectedFY;
  select.addEventListener('change', () => {
    state.selectedFY = parseInt(select.value, 10);
    state.entryWeek = state.selectedFY === todayFYWeek.financial_year ? todayFYWeek.week_number : 1;
    updateURL();
    renderAll();
  });
}

function renderAll() {
  document.getElementById('entryWeekLabel').textContent = `Editing FY${state.selectedFY} · Week ${state.entryWeek}`;
  const existing = state.manualRevenue.find((r) => r.financial_year === state.selectedFY && r.week_number === state.entryWeek);
  document.getElementById('revenueActualInput').value = existing?.actual ?? '';
  document.getElementById('revenueTargetInput').value = existing?.target ?? '';

  const steps = [renderLedger, renderKPIs, renderRecoveryFocus, renderRevenueChart, renderOnlineChart, renderChannelTrendChart, renderChannelTable, renderInsights];
  steps.forEach((step) => {
    try {
      step();
    } catch (e) {
      console.error(`renderAll: ${step.name} failed`, e);
    }
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.getElementById('onlineMetricToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-metric]');
  if (!btn) return;
  document.querySelectorAll('#onlineMetricToggle button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.onlineMetric = btn.dataset.metric;
  renderOnlineChart();
});

document.getElementById('channelTrendMetricToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-metric]');
  if (!btn) return;
  document.querySelectorAll('#channelTrendMetricToggle button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.channelTrendMetric = btn.dataset.metric;
  renderChannelTrendChart();
});

document.getElementById('kpiCompareToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  document.querySelectorAll('#kpiCompareToggle button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.kpiCompareMode = btn.dataset.mode;
  renderKPIs();
});

document.getElementById('exportChannelCsvBtn').addEventListener('click', exportChannelTableCSV);

document.querySelectorAll('#channelTable th[data-sort-key]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sortKey;
    if (state.channelSort.key === key) {
      state.channelSort.dir = state.channelSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.channelSort = { key, dir: 'desc' };
    }
    renderChannelTable();
  });
});

document.getElementById('copyWeekLinkBtn').addEventListener('click', () => {
  const url = new URL(window.location.href);
  url.searchParams.set('fy', state.selectedFY);
  url.searchParams.set('week', state.entryWeek);
  navigator.clipboard.writeText(url.toString()).then(() => {
    const status = document.getElementById('revenueSaveStatus');
    status.textContent = 'Link copied';
    setTimeout(() => { if (status.textContent === 'Link copied') status.textContent = ''; }, 2000);
  }).catch(() => {
    prompt('Copy this link:', url.toString());
  });
});

document.getElementById('saveRevenueBtn').addEventListener('click', async () => {
  const w = state.entryWeek;
  const actual = document.getElementById('revenueActualInput').value;
  const target = document.getElementById('revenueTargetInput').value;
  const status = document.getElementById('revenueSaveStatus');
  status.textContent = 'Saving…';
  try {
    await saveRevenue(state.selectedFY, w, actual === '' ? null : parseFloat(actual), target === '' ? null : parseFloat(target));
  } catch (e) {
    console.error('Save to Apps Script failed', e);
    status.textContent = 'Save failed — check Apps Script URL in config.js';
    return;
  }
  const existingIdx = state.manualRevenue.findIndex((r) => r.financial_year === state.selectedFY && r.week_number === w);
  const updated = { financial_year: state.selectedFY, week_number: w, actual: actual === '' ? null : parseFloat(actual), target: target === '' ? null : parseFloat(target) };
  if (existingIdx >= 0) state.manualRevenue[existingIdx] = { ...state.manualRevenue[existingIdx], ...updated };
  else state.manualRevenue.push(updated);
  status.textContent = 'Saved — remembered for everyone';
  try {
    renderKPIs();
    renderRevenueChart();
  } catch (e) {
    console.error('Save succeeded but re-render failed', e);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function loadEverything() {
  document.getElementById('authStatus').textContent = 'Loading data…';
  document.body.classList.add('is-loading');
  try {
    const [channelDaily, manual] = await Promise.all([
      fetchChannelDaily(CONFIG.COMPARISON_YEARS),
      fetchManualData()
    ]);
    state.channelDaily = channelDaily;
    state.manualRevenue = manual.revenue || [];
    document.getElementById('authStatus').textContent = 'Signed in';
    document.getElementById('lastRefreshed').textContent = `Last refreshed ${new Date().toLocaleString('en-GB')}`;
    renderAll();
  } finally {
    document.body.classList.remove('is-loading');
  }
}

function updateURL() {
  const url = new URL(window.location.href);
  url.searchParams.set('fy', state.selectedFY);
  url.searchParams.set('week', state.entryWeek);
  history.replaceState(null, '', url.toString());
}

function applyURLParams() {
  const params = new URLSearchParams(window.location.search);
  const fy = parseInt(params.get('fy'), 10);
  const week = parseInt(params.get('week'), 10);
  if (CONFIG.COMPARISON_YEARS.includes(fy)) state.selectedFY = fy;
  if (week >= 1 && week <= 52) state.entryWeek = week;
}

window.addEventListener('load', () => {
  applyURLParams();
  renderFYSelect();
  initAuth();
  // Manual entry data doesn't need BigQuery auth - load it immediately so the
  // revenue panel is usable even before signing in for the GA4 side.
  fetchManualData().then((manual) => {
    state.manualRevenue = manual.revenue || [];
    renderRevenueChart();
  }).catch((e) => console.warn('Apps Script not reachable yet', e));
});
