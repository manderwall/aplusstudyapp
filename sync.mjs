// sync.mjs — optional cross-device cloud sync + backup via a user-owned
// Supabase project. All data still lives locally first; this layer pushes a
// single v2 bundle (every exam's progress + overrides) through two
// SECURITY DEFINER RPCs so the public anon key can't read or overwrite other
// people's rows. Imports core (state + DOM/dialog primitives), lib
// (escapeHtml + the migration helpers the pull path re-applies), and storage
// (per-exam load/save). The two app-side bits it needs — the exam-id list and
// a Stats re-render after a pull — are injected via initSync(), so there's no
// circular import back into app.js.

import { state, $, lsSet, pref, setPref, trapFocus, setAppInert } from './core.mjs';
import { escapeHtml, defaultProgress, migrateProgress } from './lib.mjs';
import { loadProgress, loadOverrides, saveProgress, saveOverrides } from './storage.mjs';

// App-provided bits, wired by initSync() at startup.
let _examIds = ['core2'];
let _renderStats = () => {};
export function initSync({ examIds, renderStats } = {}) {
  if (examIds) _examIds = examIds;
  if (renderStats) _renderStats = renderStats;
}

//─── AUTO-SYNC ───────────────────────────────────────────────
export function scheduleAutoSync() {
  if (pref('autosync') !== 'on') return;
  const cfg = getCloudCfg();
  if (!cfg.url || !cfg.key || !cfg.syncKey) return;
  clearTimeout(state._autoSyncTimer);
  state._autoSyncTimer = setTimeout(() => {
    cloudPush().catch(err => console.warn('Auto-sync push failed', err));
  }, 5000);
}

function setCloudStatus(text, isError = false) {
  const el = $('#cloud-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--bad)' : 'var(--text-dim)';
}

function getCloudCfg() {
  return {
    url: (localStorage.getItem('supabase.url') || '').trim().replace(/\/+$/, ''),
    key: (localStorage.getItem('supabase.key') || '').trim(),
    syncKey: (localStorage.getItem('supabase.syncKey') || '').trim(),
  };
}

function saveCloudCfg(url, key, syncKey) {
  lsSet('supabase.url', url);
  lsSet('supabase.key', key);
  lsSet('supabase.syncKey', syncKey);
}

function cloudHeaders(key, extra = {}) {
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Cloud payload v2 bundles every exam's progress + overrides in one row so a
// single push/pull syncs all exams together.
async function gatherAllExamsForCloud() {
  // Read the other exams straight from IDB (decrypted with the session key
  // if the PIN is on), while the active exam lives in state.
  const progress = {};
  const overrides = {};
  for (const id of _examIds) {
    if (id === state.exam) {
      progress[id] = state.progress;
      overrides[id] = state.overrides;
    } else {
      progress[id] = await loadProgress(id);
      overrides[id] = await loadOverrides(id);
    }
  }
  return { progress, overrides };
}

async function cloudPush() {
  const { url, key, syncKey } = getCloudCfg();
  if (!url || !key || !syncKey) throw new Error('Set Supabase URL, anon key, and sync key first');
  const bundle = await gatherAllExamsForCloud();
  // Push through the progress_push RPC (SECURITY DEFINER) rather than
  // writing the table directly. The anon key is public, so direct
  // table writes let anyone overwrite any row; routing through the
  // function means a caller must supply the sync key to touch a row,
  // and the table itself is closed to the anon role. The function
  // stamps updated_at server-side.
  const body = JSON.stringify({
    p_sync_key: syncKey,
    p_data: { version: 2, progress: bundle.progress, overrides: bundle.overrides },
  });
  const res = await fetch(`${url}/rest/v1/rpc/progress_push`, {
    method: 'POST',
    headers: cloudHeaders(key),
    body,
  });
  if (!res.ok) throw new Error(`Push ${res.status}: ${(await res.text()).slice(0, 200)}`);
  lsSet('supabase.lastSync', new Date().toISOString());
}

function normalizeCloudData(data) {
  // v2: { progress: {examId: {id: {...}}}, overrides: {examId: {...}} }
  return { progress: data?.progress || {}, overrides: data?.overrides || {} };
}

async function cloudPull({ merge = true } = {}) {
  const { url, key, syncKey } = getCloudCfg();
  if (!url || !key || !syncKey) throw new Error('Set Supabase URL, anon key, and sync key first');
  // Pull through the progress_pull RPC (SECURITY DEFINER). It returns
  // only the row whose sync_key matches, so the anon key can't be used
  // to read the whole table / harvest other people's keys.
  const res = await fetch(`${url}/rest/v1/rpc/progress_pull`, {
    method: 'POST',
    headers: cloudHeaders(key),
    body: JSON.stringify({ p_sync_key: syncKey }),
  });
  if (!res.ok) throw new Error(`Pull ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`No row found for sync key "${syncKey}"`);
  const { progress: cloudProgressByExam, overrides: cloudOverridesByExam } = normalizeCloudData(rows[0].data || {});

  for (const examId of _examIds) {
    const cloudProgress  = cloudProgressByExam[examId]  || {};
    const cloudOverrides = cloudOverridesByExam[examId] || {};
    const isActive = examId === state.exam;
    const local = isActive
      ? { progress: state.progress,  overrides: state.overrides }
      : { progress: await loadProgress(examId), overrides: await loadOverrides(examId) };

    if (merge) {
      // Per-card last-write-wins using updated_at (falls back to lastSeen)
      for (const [id, cp] of Object.entries(cloudProgress)) {
        const lp = local.progress[id];
        if (!lp) { local.progress[id] = cp; continue; }
        const cTime = cp.updated_at || cp.lastSeen || 0;
        const lTime = lp.updated_at || lp.lastSeen || 0;
        if (cTime > lTime) local.progress[id] = cp;
      }
      // Overrides: prefer the side with more fields (naïve — rare to concurrently edit)
      for (const [id, co] of Object.entries(cloudOverrides)) {
        const lo = local.overrides[id];
        if (!lo || Object.keys(co).length > Object.keys(lo).length) {
          local.overrides[id] = co;
        }
      }
    } else {
      local.progress = cloudProgress;
      local.overrides = cloudOverrides;
    }

    if (isActive) {
      state.progress  = local.progress;
      state.overrides = local.overrides;
      // Re-apply defaults/migrations for cards the cloud didn't cover
      for (const q of state.questions) {
        if (!state.progress[q.id]) state.progress[q.id] = defaultProgress();
        else migrateProgress(state.progress[q.id]);
      }
      await saveProgress();
      await saveOverrides();
    } else {
      // Write the updated row back under the right exam's key
      const savedExam = state.exam;
      state.exam = examId;
      const savedProgress = state.progress, savedOverrides = state.overrides;
      state.progress  = local.progress;
      state.overrides = local.overrides;
      await saveProgress();
      await saveOverrides();
      state.exam = savedExam;
      state.progress  = savedProgress;
      state.overrides = savedOverrides;
    }
  }
  lsSet('supabase.lastSync', new Date().toISOString());
}

//─── SYNC & BACKUP DIALOG (☁️ header icon) ────────────────────
// One-time, copy-paste-able Supabase setup that matches what the app
// actually calls (the progress_push / progress_pull RPCs from the
// security-hardening PR — NOT the old direct-table policies). Lives
// behind its own header icon so cross-device backup is discoverable
// instead of buried at the bottom of Stats. Reuses the help-overlay
// scaffolding + the standard setAppInert + trapFocus a11y pattern.

// The exact SQL a brand-new project needs: the table (closed to anon)
// plus the two SECURITY DEFINER functions the app talks to. Kept here
// as the single source of truth shown in-app; mirrors
// docs/supabase-sync-hardening.sql (which only patches an existing
// table). $$ is a Postgres body delimiter, safe inside a JS template.
const SUPABASE_SETUP_SQL = `-- A+ Study cloud sync — run once in Supabase:
-- Project → SQL Editor → New query → paste → Run.

create table if not exists public.progress (
  sync_key   text primary key,
  data       jsonb not null,
  updated_at timestamptz default now()
);
alter table public.progress enable row level security;
-- No anon policies on purpose: the table is reachable ONLY through the
-- two functions below, and each one requires your sync key.

create or replace function public.progress_pull(p_sync_key text)
returns table (data jsonb, updated_at timestamptz)
language sql security definer set search_path = public as $$
  select p.data, p.updated_at
  from public.progress p
  where p.sync_key = p_sync_key;
$$;

create or replace function public.progress_push(p_sync_key text, p_data jsonb)
returns void
language sql security definer set search_path = public as $$
  insert into public.progress (sync_key, data, updated_at)
  values (p_sync_key, p_data, now())
  on conflict (sync_key) do update
    set data = excluded.data, updated_at = excluded.updated_at;
$$;

grant execute on function public.progress_pull(text)        to anon;
grant execute on function public.progress_push(text, jsonb) to anon;`;

export function syncStatusLine() {
  const { url, key, syncKey } = getCloudCfg();
  const configured = !!(url && key && syncKey);
  const last = localStorage.getItem('supabase.lastSync');
  if (!configured) {
    return { configured, text: 'Not set up yet — this device saves locally only.' };
  }
  return {
    configured,
    text: last
      ? `Connected. Last sync: ${new Date(last).toLocaleString()}`
      : 'Connected — not synced yet. Tap ⬆ Push to back up.',
  };
}

// Toggle the "backup is on" dot on the header sync button. Cheap enough
// to call on init + after any config change.
export function updateSyncBadge() {
  const btn = $('#sync-btn');
  if (!btn) return;
  const { configured } = syncStatusLine();
  btn.classList.toggle('is-configured', configured);
  btn.title = configured
    ? 'Sync & backup — on (tap to manage)'
    : 'Sync & backup (save across devices)';
}

export function showSync() {
  const cfg = getCloudCfg();
  const status = syncStatusLine();
  const html = `
    <div id="sync-overlay" role="dialog" aria-modal="true" aria-labelledby="sync-title">
      <div class="welcome-card help-card">
        <button class="welcome-close" id="sync-close" aria-label="Close sync">✕</button>
        <h2 id="sync-title">☁️ Sync &amp; backup</h2>
        <p class="welcome-intro">Your progress is always saved on <strong>this</strong> device automatically. Cloud sync is optional — turn it on to back up your progress and study across more than one device (e.g. iPad + phone).</p>

        <div class="sync-status ${status.configured ? 'is-on' : 'is-off'}" id="sync-status-banner" role="status">
          <span class="sync-status-dot" aria-hidden="true"></span>
          <span id="sync-status-text">${escapeHtml(status.text)}</span>
        </div>

        <details class="help-section">
          <summary>🤔 Do I even need this?</summary>
          <div class="help-body">
            <p><strong>Only use one device?</strong> You can skip all of this — your progress is already safe on this device and works offline.</p>
            <p><strong>Want a backup, or study on two devices?</strong> Set up the free Supabase backend once (below), then connect each device with the same sync key.</p>
          </div>
        </details>

        <details class="help-section" ${status.configured ? '' : 'open'}>
          <summary>1️⃣ Set up the backend (one time, ~5 min)</summary>
          <div class="help-body">
            <ol>
              <li>Make a free project at <strong>supabase.com</strong> (no card needed).</li>
              <li>Open the project → <strong>SQL Editor</strong> → <strong>New query</strong>.</li>
              <li>Paste the script below and click <strong>Run</strong>. (Sets up the storage table + the two secure functions this app uses.)
                <button type="button" class="copy-sql-btn small-btn" id="sync-copy-sql">📋 Copy the SQL</button>
                <pre id="sync-sql">${escapeHtml(SUPABASE_SETUP_SQL)}</pre>
              </li>
              <li>Open <strong>Project Settings → API</strong> and copy two things: the <em>Project URL</em> and the <em>anon / public key</em>.</li>
            </ol>
          </div>
        </details>

        <details class="help-section" ${status.configured ? 'open' : ''}>
          <summary>2️⃣ Connect this device</summary>
          <div class="help-body">
            <div class="settings-stack sync-form">
              <label class="settings-vrow">
                <span class="settings-vlabel">Project URL</span>
                <input id="cloud-url" type="url" placeholder="https://xxxx.supabase.co" value="${escapeHtml(cfg.url)}">
              </label>
              <label class="settings-vrow">
                <span class="settings-vlabel">Anon / public key</span>
                <input id="cloud-key" type="password" placeholder="eyJ…" value="${escapeHtml(cfg.key)}">
              </label>
              <label class="settings-vrow">
                <span class="settings-vlabel">Sync key — pick any long random string, use the <em>same</em> one on every device (e.g. <code>my-aplus-7Kp2qX</code>)</span>
                <input id="cloud-sync" type="text" placeholder="your-sync-key" value="${escapeHtml(cfg.syncKey)}">
              </label>
              <p class="settings-meta">Your sync key is the only thing protecting your data — use something long and unguessable, and keep it private.</p>
              <div class="sync-actions">
                <button class="small-btn" id="cloud-save">💾 Save</button>
                <button class="small-btn" id="cloud-push">⬆ Push (back up this device)</button>
                <button class="small-btn" id="cloud-pull">⬇ Pull (load onto this device)</button>
              </div>
              <label class="settings-row sync-autosync">
                <span>Auto-sync after each save (every 5s)</span>
                <input type="checkbox" id="sync-autosync" ${pref('autosync')==='on'?'checked':''}>
              </label>
              <p class="settings-meta" id="cloud-status">${escapeHtml(status.text)}</p>
            </div>
          </div>
        </details>

        <details class="help-section">
          <summary>🆘 Sync isn't working?</summary>
          <div class="help-body">
            <ul>
              <li><strong>Push/Pull fails:</strong> re-check the Project URL and anon key (Settings → API). Make sure you ran the full SQL script above.</li>
              <li><strong>"No row found for sync key":</strong> you haven't pushed from any device yet — tap <strong>⬆ Push</strong> on the device that has your progress first.</li>
              <li><strong>Two devices disagree:</strong> Push from the one that's most up-to-date, then Pull on the other.</li>
              <li><strong>First device, fresh install:</strong> Pull <em>replaces</em> local progress with the cloud copy — only Pull onto a device you're okay overwriting.</li>
            </ul>
          </div>
        </details>
      </div>
    </div>
  `;
  $('#sync-overlay')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = $('#sync-overlay');
  const previouslyFocused = document.activeElement;
  setAppInert(true);
  const releaseTrap = trapFocus(overlay);
  const close = () => {
    releaseTrap();
    setAppInert(false);
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
  };
  const onKeydown = (e) => {
    if ($('#sync-overlay') !== overlay) return;
    if (e.key === 'Escape') { close(); return; }
  };
  $('#sync-close').addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);

  const readInputs = () => saveCloudCfg(
    $('#cloud-url').value.trim(),
    $('#cloud-key').value.trim(),
    $('#cloud-sync').value.trim(),
  );
  const refreshBanner = () => {
    const s = syncStatusLine();
    const banner = $('#sync-status-banner');
    if (banner) {
      banner.classList.toggle('is-on', s.configured);
      banner.classList.toggle('is-off', !s.configured);
      $('#sync-status-text').textContent = s.text;
    }
    updateSyncBadge();
  };

  $('#sync-copy-sql').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(SUPABASE_SETUP_SQL);
      btn.textContent = '✓ Copied!';
    } catch {
      window.prompt('Copy this SQL, then run it in the Supabase SQL editor:', SUPABASE_SETUP_SQL);
    }
    setTimeout(() => { btn.textContent = original; }, 1600);
  });
  $('#cloud-save').addEventListener('click', () => {
    readInputs();
    setCloudStatus('Configuration saved.');
    refreshBanner();
  });
  $('#cloud-push').addEventListener('click', async () => {
    setCloudStatus('Pushing…');
    try {
      readInputs();
      await cloudPush();
      setCloudStatus(`Pushed ${new Date().toLocaleTimeString()}`);
    } catch (e) { setCloudStatus(`Push failed: ${e.message}`, true); }
    refreshBanner();
  });
  $('#cloud-pull').addEventListener('click', async () => {
    if (!confirm('Pull will overwrite local progress with the cloud copy. Continue?')) return;
    setCloudStatus('Pulling…');
    try {
      readInputs();
      await cloudPull();
      setCloudStatus(`Pulled ${new Date().toLocaleTimeString()}`);
      if (state.mode === 'stats') _renderStats();
    } catch (e) { setCloudStatus(`Pull failed: ${e.message}`, true); }
    refreshBanner();
  });
  $('#sync-autosync').addEventListener('change', (e) => {
    setPref('autosync', e.target.checked ? 'on' : 'off');
  });
  setTimeout(() => { $('#sync-close')?.focus(); }, 0);
}
