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
  getAccessToken().then(() => loadEverything()).catch((e) => {
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
  channelDaily: [],   // rows across all comparison years
  manualRevenue: [],
  onlineMetric: 'revenue',
  charts: {}
};

const today = new Date();
const todayFYWeek = fyWeekOf(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));

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
  // Pre-fill the manual entry rows for quick capture of that week.
  document.getElementById('revenueActualInput').dataset.week = w;
  document.getElementById('revenueEntryRow').scrollIntoView({ behavior: 'smooth', block: 'center' });
  const existing = state.manualRevenue.find((r) => r.financial_year === state.selectedFY && r.week_number === w);
  document.getElementById('revenueActualInput').value = existing?.actual ?? '';
  document.getElementById('revenueTargetInput').value = existing?.target ?? '';
}

function renderKPIs() {
  const fy = state.selectedFY;
  const priorFY = fy - 1;
  const wk = state.selectedFY === todayFYWeek.financial_year ? todayFYWeek.week_number : 52;

  const curWeekRows = state.channelDaily.filter((r) => r.financial_year === fy && r.week_number === wk);
  const priorWeekRows = state.channelDaily.filter((r) => r.financial_year === priorFY && r.week_number === wk);

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

  const businessRow = state.manualRevenue.find((r) => r.financial_year === fy && r.week_number === wk);
  const businessActual = businessRow?.actual;
  const businessTarget = businessRow?.target;
  const businessDelta = businessActual != null && businessTarget ? (businessActual - businessTarget) / businessTarget : null;

  const kpis = [
    { label: `Business revenue · wk ${wk}`, value: businessActual != null ? fmtGBP(businessActual) : 'Not entered',
      delta: businessDelta != null ? { text: `${businessDelta > 0 ? '+' : ''}${fmtPct(businessDelta)} vs target`, cls: businessDelta >= 0 ? 'up' : 'down' } : { text: businessTarget ? `Target ${fmtGBP(businessTarget)}` : '—', cls: 'flat' } },
    { label: 'Online revenue', value: fmtGBP(curRevenue), delta: fmtDelta(pctDelta(curRevenue, priorRevenue)) },
    { label: 'Sessions', value: Math.round(curSessions).toLocaleString('en-GB'), delta: fmtDelta(pctDelta(curSessions, priorSessions)) },
    { label: 'Transactions', value: Math.round(curTx).toLocaleString('en-GB'), delta: fmtDelta(pctDelta(curTx, priorTx)) },
    { label: 'CVR', value: fmtPct(curCVR, 2), delta: fmtDelta(pctDelta(curCVR, priorCVR)) },
    { label: 'AOV', value: fmtGBP(curAOV), delta: fmtDelta(pctDelta(curAOV, priorAOV)) },
    { label: 'Item views', value: Math.round(curItemViews).toLocaleString('en-GB'), delta: fmtDelta(pctDelta(curItemViews, priorItemViews)) }
  ];

  const row = document.getElementById('kpiRow');
  row.innerHTML = kpis.map((k) => `
    <div class="kpi">
      <div class="label">${k.label}</div>
      <div class="value">${k.value}</div>
      <div class="delta ${k.delta.cls}">${k.delta.text}</div>
    </div>
  `).join('');
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
      borderColor: isCurrent ? '#a9772f' : `hsl(${30 + idx * 40}, 20%, 55%)`,
      borderWidth: isCurrent ? 3 : 1.5,
      pointRadius: 0,
      tension: 0.25,
      spanGaps: true
    };
  });

  const targetValues = labels.map((w) => {
    const row = state.manualRevenue.find((r) => r.financial_year === state.selectedFY && r.week_number === w);
    return row ? row.target : null;
  });
  datasets.push({
    label: `FY${state.selectedFY} target`,
    data: targetValues,
    borderColor: '#21201c',
    borderDash: [4, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    spanGaps: true
  });

  if (state.charts.revenue) state.charts.revenue.destroy();
  state.charts.revenue = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: chartOptions('£')
  });
}

function renderOnlineChart() {
  const ctx = document.getElementById('onlineChart');
  const labels = Array.from({ length: 52 }, (_, i) => i + 1);
  const metric = state.onlineMetric;

  const datasets = CONFIG.COMPARISON_YEARS.map((fy, idx) => {
    const weekly = weeklyTotalsForFY(state.channelDaily, fy);
    const values = labels.map((w) => {
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
      borderColor: isCurrent ? '#a9772f' : `hsl(${30 + idx * 40}, 20%, 55%)`,
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
    options: chartOptions(prefix, isPct)
  });
}

function chartOptions(prefix = '', isPct = false) {
  return {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { family: 'Inter', size: 11 } } },
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
        grid: { color: '#eee3d3' }
      }
    }
  };
}

function renderChannelTable() {
  const totals = channelTotalsForFY(state.channelDaily, state.selectedFY);
  const rows = Object.entries(totals).sort((a, b) => b[1].revenue - a[1].revenue);
  const tbody = document.getElementById('channelTableBody');
  tbody.innerHTML = rows.map(([channel, t]) => {
    const cvr = t.sessions ? t.transactions / t.sessions : 0;
    const aov = t.transactions ? t.revenue / t.transactions : 0;
    return `<tr>
      <td>${channel}</td>
      <td>${Math.round(t.sessions).toLocaleString('en-GB')}</td>
      <td>${Math.round(t.transactions).toLocaleString('en-GB')}</td>
      <td>${fmtGBP(t.revenue)}</td>
      <td>${fmtPct(cvr, 2)}</td>
      <td>${fmtGBP(aov)}</td>
      <td>${Math.round(t.item_views).toLocaleString('en-GB')}</td>
    </tr>`;
  }).join('');
}

function renderFYSelect() {
  const select = document.getElementById('fySelect');
  select.innerHTML = CONFIG.COMPARISON_YEARS.map((fy) => `<option value="${fy}">FY${fy}</option>`).join('');
  select.value = state.selectedFY;
  select.addEventListener('change', () => {
    state.selectedFY = parseInt(select.value, 10);
    renderAll();
  });
}

function renderAll() {
  renderLedger();
  renderKPIs();
  renderRevenueChart();
  renderOnlineChart();
  renderChannelTable();
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

document.getElementById('saveRevenueBtn').addEventListener('click', async () => {
  const w = parseInt(document.getElementById('revenueActualInput').dataset.week || todayFYWeek.week_number, 10);
  const actual = document.getElementById('revenueActualInput').value;
  const target = document.getElementById('revenueTargetInput').value;
  const status = document.getElementById('revenueSaveStatus');
  status.textContent = 'Saving…';
  try {
    await saveRevenue(state.selectedFY, w, actual === '' ? null : parseFloat(actual), target === '' ? null : parseFloat(target));
    const existingIdx = state.manualRevenue.findIndex((r) => r.financial_year === state.selectedFY && r.week_number === w);
    const updated = { financial_year: state.selectedFY, week_number: w, actual: actual === '' ? null : parseFloat(actual), target: target === '' ? null : parseFloat(target) };
    if (existingIdx >= 0) state.manualRevenue[existingIdx] = { ...state.manualRevenue[existingIdx], ...updated };
    else state.manualRevenue.push(updated);
    status.textContent = 'Saved — remembered for everyone';
    renderKPIs();
    renderRevenueChart();
  } catch (e) {
    console.error(e);
    status.textContent = 'Save failed — check Apps Script URL in config.js';
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function loadEverything() {
  document.getElementById('authStatus').textContent = 'Loading data…';
  const [channelDaily, manual] = await Promise.all([
    fetchChannelDaily(CONFIG.COMPARISON_YEARS),
    fetchManualData()
  ]);
  state.channelDaily = channelDaily;
  state.manualRevenue = manual.revenue || [];
  document.getElementById('authStatus').textContent = 'Signed in';
  document.getElementById('lastRefreshed').textContent = `Last refreshed ${new Date().toLocaleString('en-GB')}`;
  renderAll();
}

window.addEventListener('load', () => {
  renderFYSelect();
  initAuth();
  // Manual entry data doesn't need BigQuery auth - load it immediately so the
  // revenue panel is usable even before signing in for the GA4 side.
  fetchManualData().then((manual) => {
    state.manualRevenue = manual.revenue || [];
    renderRevenueChart();
  }).catch((e) => console.warn('Apps Script not reachable yet', e));
});
