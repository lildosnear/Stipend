'use strict';

/** Format a yocto amount as NEAR: string based, up to 6 decimals, trimmed. */
function fmtNear(yocto) {
  if (yocto === null || yocto === undefined) return 'n/a';
  let digits = String(yocto);
  if (!/^\d+$/.test(digits)) digits = BigInt(Math.round(Number(digits))).toString();
  digits = digits.padStart(25, '0');
  const whole = digits.slice(0, digits.length - 24);
  const frac = digits.slice(digits.length - 24, digits.length - 18).replace(/0+$/, '');
  return (frac ? `${whole}.${frac}` : whole) + ' NEAR';
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showMessage(text, isError) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = isError ? 'message error' : 'message';
  el.hidden = !text;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

function table(headers, rows) {
  if (!rows.length) return '<p class="empty">Nothing here yet.</p>';
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function badge(text, kind) {
  return `<span class="badge ${kind || ''}">${esc(text)}</span>`;
}

function when(ts) {
  return new Date(ts).toLocaleString();
}

// ----- pages -----------------------------------------------------------------

async function loadOverview() {
  const o = await api('/api/overview');
  const paused = Array.isArray(o.paused) ? o.paused : [null, null];
  const pauseBadge = paused[1]
    ? badge('all payments paused', 'bad')
    : paused[0]
      ? badge('exceptions paused', 'warn')
      : badge('active', 'good');
  const cards = [
    ['Owner', esc(o.owner ?? 'n/a')],
    ['Engine balance', esc(fmtNear(o.engineBalance))],
    ['Status', pauseBadge],
    ['Agents', esc(o.agentCount ?? 'n/a')],
    ['Payments', esc(o.paymentCount ?? 'n/a')],
    ['Total in flight', esc(fmtNear(o.totalInFlight))],
  ];
  document.getElementById('overview-cards').innerHTML = cards
    .map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
}

async function loadStipends() {
  const rows = await api('/api/stipends');
  const html = table(
    ['Agent', 'Status', 'Cap per payment', 'Daily budget', 'Spent today', 'Policy v', 'Callers', 'Action'],
    rows.map((a) => {
      const action =
        a.status === 'Revoked'
          ? `<button data-reactivate="${esc(a.agent_id)}">Reactivate</button>`
          : `<button data-revoke="${esc(a.agent_id)}">Revoke</button>`;
      return [
        esc(a.agent_id),
        badge(a.status, a.status === 'Revoked' ? 'bad' : 'good'),
        esc(fmtNear(a.per_payment_cap)),
        esc(fmtNear(a.daily_budget)),
        esc(fmtNear(a.spent_today)),
        esc(a.policy_version),
        esc((a.authorized_callers || []).join(', ')),
        action,
      ];
    }),
  );
  document.getElementById('stipends-table').innerHTML = html;
}

async function loadPayments() {
  const rows = await api('/api/payments');
  const html = table(
    ['Payment', 'Agent', 'Recipient', 'Amount', 'Day', 'Status'],
    rows.map((p) => [
      esc(p.payment_id),
      esc(p.agent),
      esc(p.recipient),
      esc(fmtNear(p.amount)),
      esc(p.day),
      badge(p.status, p.status === 'Succeeded' ? 'good' : p.status === 'Failed' ? 'bad' : 'warn'),
    ]),
  );
  document.getElementById('payments-table').innerHTML = html;
}

async function loadHolds() {
  const rows = await api('/api/holds');
  const html = table(
    ['When', 'Agent', 'Resource', 'Amount', 'Reason', 'Action'],
    rows.map((a, i) => [
      esc(when(a.ts)),
      esc(a.agent),
      esc(a.resource ?? ''),
      esc(fmtNear(a.amount)),
      badge(a.reason || '', 'warn'),
      `<button data-approve="${i}">Approve</button>`,
    ]),
  );
  document.getElementById('holds-table').innerHTML = html;
  return rows;
}

async function loadBlocked() {
  const rows = (await api('/api/attempts')).filter((a) => a.outcome === 'blocked');
  const html = table(
    ['When', 'Payment', 'Agent', 'Recipient', 'Amount', 'Reason', 'Resource'],
    rows.map((a) => [
      esc(when(a.ts)),
      esc(a.payment_id),
      esc(a.agent),
      esc(a.recipient),
      esc(fmtNear(a.amount)),
      badge(a.reason || '', 'bad'),
      esc(a.resource ?? ''),
    ]),
  );
  document.getElementById('blocked-table').innerHTML = html;
}

const loaders = {
  overview: loadOverview,
  stipends: loadStipends,
  payments: loadPayments,
  holds: loadHolds,
  blocked: loadBlocked,
};

let holdsCache = [];

async function load(page) {
  showMessage('');
  try {
    const result = await loaders[page]();
    if (page === 'holds') holdsCache = result || [];
  } catch (e) {
    showMessage(`could not load ${page}: ${e.message}`, true);
  }
}

function showPage(page) {
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach((s) => {
    s.hidden = s.id !== `page-${page}`;
  });
  load(page);
}

// ----- wiring ------------------------------------------------------------------

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-page]');
  if (btn) showPage(btn.dataset.page);
});

document.querySelectorAll('[data-refresh]').forEach((btn) => {
  btn.addEventListener('click', () => load(btn.dataset.refresh));
});

document.getElementById('pause-btn').addEventListener('click', async () => {
  try {
    await api('/api/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    showMessage('all payments paused');
    load('stipends');
  } catch (e) {
    showMessage(`pause failed: ${e.message}`, true);
  }
});

document.getElementById('resume-btn').addEventListener('click', async () => {
  try {
    await api('/api/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: false }),
    });
    showMessage('payments resumed');
    load('stipends');
  } catch (e) {
    showMessage(`resume failed: ${e.message}`, true);
  }
});

document.getElementById('stipends-table').addEventListener('click', async (e) => {
  const revokeBtn = e.target.closest('button[data-revoke]');
  const reactivateBtn = e.target.closest('button[data-reactivate]');
  const agent = revokeBtn?.dataset.revoke || reactivateBtn?.dataset.reactivate;
  if (!agent) return;
  const action = revokeBtn ? 'revoke' : 'reactivate';
  try {
    await api(`/api/agents/${encodeURIComponent(agent)}/${action}`, { method: 'POST' });
    showMessage(`agent ${agent} ${action === 'revoke' ? 'revoked' : 'reactivated'}`);
    load('stipends');
  } catch (err) {
    showMessage(`${action} failed: ${err.message}`, true);
  }
});

document.getElementById('holds-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-approve]');
  if (!btn) return;
  const attempt = holdsCache[Number(btn.dataset.approve)];
  if (!attempt) return;
  btn.disabled = true;
  try {
    const record = await api('/api/holds/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: attempt.agent,
        resource: attempt.resource,
        sellerUrl: attempt.sellerUrl,
        amount: attempt.amount,
      }),
    });
    showMessage(`approved and settled: ${record.status}, ${fmtNear(record.amount)} to ${record.recipient}`);
    load('holds');
  } catch (err) {
    showMessage(`approval failed: ${err.message}`, true);
    btn.disabled = false;
  }
});

async function init() {
  try {
    const health = await api('/health');
    document.getElementById('contract').textContent = health.contract;
    document.getElementById('health').textContent = 'connected';
    document.getElementById('health').classList.add('good');
  } catch {
    document.getElementById('health').textContent = 'unreachable';
    document.getElementById('health').classList.add('bad');
  }
  load('overview');
}

init();
