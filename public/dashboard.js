/**
 * AI Firewall dashboard. External file so the CSP stays strict (script-src
 * 'self', zero inline script). All interactions use event delegation and
 * native <dialog> elements — no prompt()/confirm(), no inline handlers.
 */

/* ---------- utilities ---------- */

const $ = (id) => document.getElementById(id);
const usd = (n) => '$' + Number(n).toFixed(4);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------- api with dialog-based key entry ---------- */

const adminKey = () => localStorage.getItem('adminKey') || '';

function askForKey() {
  return new Promise((resolve) => {
    const dlg = $('dlg-key');
    const input = $('input-key');
    input.value = '';
    dlg.showModal();
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const v = input.value.trim();
      if (dlg.returnValue !== 'cancel' && v) {
        localStorage.setItem('adminKey', v);
        resolve(true);
      } else {
        resolve(false);
      }
    };
    dlg.addEventListener('close', onClose);
  });
}

async function api(path, opts = {}, allowRetry = true) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (adminKey()) headers['X-Admin-Key'] = adminKey();
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem('adminKey');
    if (allowRetry && (await askForKey())) return api(path, opts, false);
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ---------- sparkline: spend velocity (delta per tick) ---------- */

const history = [];
let lastTotal = null;

function pushVelocity(total) {
  if (lastTotal !== null) history.push(Math.max(0, total - lastTotal));
  lastTotal = total;
  if (history.length > 48) history.shift();
}

function drawSpark() {
  const svg = $('spark');
  const W = 180, H = 52, PAD = 2;
  const n = history.length;
  if (!n) { svg.innerHTML = ''; return; }
  const max = Math.max(...history, 1e-9);
  const bw = Math.max(2, (W - PAD * 2) / 48 - 1.5);
  const bars = history.map((v, i) => {
    const h = v > 0 ? Math.max(2, (v / max) * (H - PAD * 2)) : 1.5;
    const x = PAD + i * ((W - PAD * 2) / 48);
    const color = v > 0 ? 'oklch(76% 0.17 155 / 0.9)' : 'oklch(35% 0.02 255)';
    return `<rect x="${x.toFixed(1)}" y="${(H - PAD - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${color}"/>`;
  });
  svg.innerHTML = bars.join('');
}

/* ---------- rendering ---------- */

function statusOf(a) {
  if (a.exceeded) return ['HALTED', 'halted'];
  if (a.limitUsd > 0 && a.spentUsd / a.limitUsd > 0.8) return ['NEAR LIMIT', 'warn'];
  return ['ACTIVE', 'ok'];
}

const BAR_COLORS = { halted: 'var(--danger)', warn: 'var(--warn)', ok: 'var(--ok)' };

const ICON_LIMIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>';
const ICON_RESET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

function renderFleet(fleet) {
  if (!fleet) return;
  const hasCap = fleet.totalLimitUsd > 0;
  const frac = hasCap ? Math.min(1, fleet.totalSpentUsd / fleet.totalLimitUsd) : 0;
  const fill = $('fleet-fill');
  fill.style.transform = `scaleX(${frac})`;
  let color = 'var(--ok)';
  if (fleet.exceeded) color = 'var(--danger)';
  else if (frac > 0.8) color = 'var(--warn)';
  fill.style.background = color;
  $('fleet-spent').textContent = usd(fleet.totalSpentUsd);
  $('fleet-of').textContent = hasCap ? `of ${usd(fleet.totalLimitUsd)} daily cap` : '· no fleet cap set';
  $('fleet-pending').textContent = fleet.totalPendingUsd > 0 ? `(+${usd(fleet.totalPendingUsd)} in-flight)` : '';
  pushVelocity(fleet.totalSpentUsd);
  drawSpark();
}

function renderRow(a) {
  const frac = a.limitUsd > 0 ? Math.min(1, a.spentUsd / a.limitUsd) : 1;
  const [label, cls] = statusOf(a);
  const id = esc(a.agentId);
  const pct = a.limitUsd > 0 ? Math.round((a.spentUsd / a.limitUsd) * 100) : 100;
  return `<tr class="${cls === 'halted' ? 'halted' : ''}">
    <td class="agent-id">${id}</td>
    <td><span class="pill ${cls}">${label}</span></td>
    <td class="num">${usd(a.spentUsd)}</td>
    <td>
      <div class="bar" role="img" aria-label="${pct}% of budget used"><i style="transform:scaleX(${frac});background:${BAR_COLORS[cls]}"></i></div>
    </td>
    <td class="num dim">${usd(a.limitUsd)}${a.customLimit ? '<span class="pct" title="custom limit">override</span>' : ''}</td>
    <td class="num dim">${a.pendingUsd ? usd(a.pendingUsd) : '—'}</td>
    <td class="actions">
      <button class="btn" data-action="limit" data-agent="${id}" aria-label="Set limit for ${id}">${ICON_LIMIT}limit</button>
      <button class="btn danger" data-action="reset" data-agent="${id}" aria-label="Reset spend for ${id}">${ICON_RESET}reset</button>
    </td>
  </tr>`;
}

function render(data) {
  $('upstream').textContent = data.upstream.toUpperCase();
  $('day').textContent = data.day + ' UTC';

  const agents = data.agents;
  const total = agents.reduce((s, a) => s + a.spentUsd, 0);
  const halted = agents.filter((a) => a.exceeded).length;
  const active = agents.length - halted;

  $('stat-agents').textContent = agents.length;
  $('stat-agents-sub').textContent = `${active} active`;
  $('stat-spend').textContent = usd(total);
  $('stat-spend-sub').textContent = 'metered · today';
  $('stat-limit').textContent = usd(data.globalLimitUsd);
  const haltedEl = $('stat-halted');
  haltedEl.textContent = halted;
  haltedEl.className = 'value ' + (halted ? 'danger' : 'ok');
  $('stat-halted-sub').textContent = halted ? 'kill-switch tripped' : 'all clear';
  $('fleet-count').textContent = `${agents.length} agent${agents.length === 1 ? '' : 's'}`;

  renderFleet(data.fleet);

  $('empty').hidden = agents.length > 0;
  $('rows').innerHTML = agents.map(renderRow).join('');
}

/* ---------- actions (event delegation + dialogs) ---------- */

let pendingAgent = null;

$('rows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  pendingAgent = btn.dataset.agent;
  if (btn.dataset.action === 'limit') {
    $('limit-agent').textContent = pendingAgent;
    $('input-limit').value = '';
    $('dlg-limit').showModal();
  } else {
    $('reset-agent').textContent = pendingAgent;
    $('dlg-reset').showModal();
  }
});

// Cancel buttons close their dialog with a sentinel returnValue.
document.querySelectorAll('dialog [data-close]').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('dialog').close('cancel'));
});

$('form-limit').addEventListener('submit', async () => {
  const raw = $('input-limit').value.trim();
  const limitUsd = raw === '' ? null : Number(raw);
  try {
    await api(`/admin/agents/${encodeURIComponent(pendingAgent)}/limit`, {
      method: 'PUT',
      body: JSON.stringify({ limitUsd }),
    });
    toast(limitUsd === null ? `Override cleared for ${pendingAgent}` : `${pendingAgent} limited to ${usd(limitUsd)}/day`);
    tick();
  } catch (err) {
    toast(`Failed to set limit: ${err.message}`, true);
  }
});

$('form-reset').addEventListener('submit', async () => {
  try {
    await api(`/admin/agents/${encodeURIComponent(pendingAgent)}/spend`, { method: 'DELETE' });
    toast(`Spend reset for ${pendingAgent} — kill-switch re-armed`);
    tick();
  } catch (err) {
    toast(`Failed to reset: ${err.message}`, true);
  }
});

/* ---------- polling loop (pauses when the tab is hidden) ---------- */

const REFRESH_MS = 2000;
let timer = null;

async function tick() {
  const err = $('error');
  const conn = $('conn');
  try {
    render(await api('/admin/agents'));
    err.style.display = 'none';
    conn.classList.remove('err');
  } catch (e) {
    if (e.message === 'unauthorized') {
      err.textContent = 'Locked — admin key required. Reload to try again.';
    } else {
      err.textContent = 'Failed to reach proxy: ' + e.message;
    }
    err.style.display = 'block';
    conn.classList.add('err');
  }
}

function startPolling() {
  if (timer) return;
  timer = setInterval(tick, REFRESH_MS);
  $('refresh-label').textContent = 'live · 2s';
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
  $('refresh-label').textContent = 'paused';
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else { tick(); startPolling(); }
});

await tick();
startPolling();
