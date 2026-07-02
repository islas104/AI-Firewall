/**
 * AI Firewall dashboard. Served as an external file so the CSP can stay
 * strict (script-src 'self', no inline script). All row actions use event
 * delegation + data attributes — no inline handlers.
 */
const usd = (n) => '$' + Number(n).toFixed(4);
const adminKey = () => localStorage.getItem('adminKey') || '';
const authHeaders = () => (adminKey() ? { 'X-Admin-Key': adminKey() } : {});

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...opts.headers },
  });
  if (res.status === 401) {
    const key = prompt('Admin key required (X-Admin-Key):');
    if (key) {
      localStorage.setItem('adminKey', key);
      return api(path, opts);
    }
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function statusOf(a) {
  if (a.exceeded) return ['HALTED', 'halted'];
  if (a.spentUsd / a.limitUsd > 0.8) return ['NEAR LIMIT', 'warn'];
  return ['ACTIVE', 'ok'];
}

const BAR_COLORS = { halted: 'var(--danger)', warn: 'var(--warn)', ok: 'var(--ok)' };

function render(data) {
  document.getElementById('upstream').textContent = data.upstream.toUpperCase();
  document.getElementById('day').textContent = data.day + ' UTC';
  const agents = data.agents;
  const total = agents.reduce((s, a) => s + a.spentUsd, 0);
  const halted = agents.filter((a) => a.exceeded).length;
  document.getElementById('stat-agents').textContent = agents.length;
  document.getElementById('stat-spend').textContent = usd(total);
  document.getElementById('stat-limit').textContent = usd(data.globalLimitUsd);
  const haltedEl = document.getElementById('stat-halted');
  haltedEl.textContent = halted;
  haltedEl.className = 'value ' + (halted ? 'danger' : 'ok');

  document.getElementById('empty').hidden = agents.length > 0;
  const rows = agents.map((a) => {
    const frac = Math.min(1, a.limitUsd ? a.spentUsd / a.limitUsd : 1);
    const [label, cls] = statusOf(a);
    const id = esc(a.agentId);
    return `<tr>
      <td class="agent-id">${id}</td>
      <td><span class="pill ${cls}">${label}</span></td>
      <td class="num">${usd(a.spentUsd)}</td>
      <td><div class="bar"><i style="transform:scaleX(${frac});background:${BAR_COLORS[cls]}"></i></div></td>
      <td class="num dim">${usd(a.limitUsd)}${a.customLimit ? ' *' : ''}</td>
      <td class="num dim">${a.pendingUsd ? usd(a.pendingUsd) : '—'}</td>
      <td>
        <button data-action="limit" data-agent="${id}">limit</button>
        <button data-action="reset" data-agent="${id}" class="danger">reset</button>
      </td>
    </tr>`;
  });
  document.getElementById('rows').innerHTML = rows.join('');
}

async function setLimit(id) {
  const v = prompt(`New daily limit (USD) for ${id} — empty to clear override:`);
  if (v === null) return;
  await api(`/admin/agents/${encodeURIComponent(id)}/limit`, {
    method: 'PUT',
    body: JSON.stringify({ limitUsd: v.trim() === '' ? null : Number(v) }),
  });
  tick();
}

async function resetSpend(id) {
  if (!confirm(`Reset today's spend for ${id}? This un-trips the kill-switch.`)) return;
  await api(`/admin/agents/${encodeURIComponent(id)}/spend`, { method: 'DELETE' });
  tick();
}

// Event delegation for row actions — CSP-safe, survives re-renders.
document.getElementById('rows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, agent } = btn.dataset;
  if (action === 'limit') setLimit(agent);
  if (action === 'reset') resetSpend(agent);
});

async function tick() {
  const err = document.getElementById('error');
  try {
    render(await api('/admin/agents'));
    err.style.display = 'none';
  } catch (e) {
    err.textContent = 'Failed to reach proxy: ' + e.message;
    err.style.display = 'block';
  }
}

tick();
setInterval(tick, 2000);
