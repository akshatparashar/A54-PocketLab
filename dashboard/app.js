/* =========================================================
   POCKETLAB — live dashboard application
   Vanilla JS. No framework/build step.
   The dashboard is intentionally UI-compatible with the
   original design, but now treats the PocketLab APIs as the
   source of truth instead of fabricating device data.
   ========================================================= */
(() => {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const pad2 = (n) => String(n).padStart(2, '0');

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function fmtTime(d = new Date()) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function fmtAgo(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s} sec ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
  }

  function iconUse(id) {
    return `<svg class="icon"><use href="#${id}"/></svg>`;
  }

  const ACCENT_HEX = {
    brand: '#2dd4bf',
    device: '#4c8dff',
    network: '#22d3ee',
    security: '#f59e0b',
    iot: '#34d399',
    ai: '#a78bfa',
    logs: '#94a3b8',
    danger: '#f87171',
    warning: '#fbbf24'
  };

  const DEFAULT_API_BASE =
    window.location.protocol === 'http:' ||
    window.location.protocol === 'https:'
      ? window.location.origin
      : '';

  const savedApiBase =
    localStorage.getItem('pocketlab.apiBase') || '';

  const urlApiBase =
    new URLSearchParams(window.location.search).get('api');

  const hostedOnPocketLab =
    Boolean(DEFAULT_API_BASE);

  const CONFIG = {
    // Same-origin is the default when the dashboard is served by PocketLab.
    // This prevents old saved LAN IPs from taking over after a network change.
    apiBase: urlApiBase || (hostedOnPocketLab ? DEFAULT_API_BASE : savedApiBase),
    autoDiscovery: localStorage.getItem('pocketlab.autoDiscovery') !== 'false',
    telemetryInterval: Number(localStorage.getItem('pocketlab.telemetryInterval') || 5000),
    iotInterval: Number(localStorage.getItem('pocketlab.iotInterval') || 5000),
    contextInterval: Number(localStorage.getItem('pocketlab.contextInterval') || 3000),
    aiInterval: Number(localStorage.getItem('pocketlab.aiInterval') || 5000),
    confirmCommands: localStorage.getItem('pocketlab.confirmCommands') !== 'false',
    verboseLogging: localStorage.getItem('pocketlab.verboseLogging') === 'true'
  };

  if (hostedOnPocketLab && !urlApiBase) {
    localStorage.removeItem('pocketlab.apiBase');
  }

  let apiConnected = false;

  async function apiFetch(path, options = {}, timeoutMs = 5000) {
    const base = String(CONFIG.apiBase || '').replace(/\/$/, '');
    const url = base + path;
    if (!url) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(options.headers || {})
        }
      });

      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function setApiConnected(connected) {
    apiConnected = !!connected;

    const badge = $('#dataModeBadge');
    if (badge) {
      badge.innerHTML = apiConnected
        ? `<span class="dot dot-online"></span> Live data`
        : `<span class="dot dot-offline"></span> Server offline`;
    }

    const miniDot = $('#miniDot');
    if (miniDot) {
      miniDot.className = `dot ${apiConnected ? 'dot-online' : 'dot-offline'}`;
    }
  }

  async function checkApiConnection(silent = true) {
    if (!CONFIG.apiBase) {
      setApiConnected(false);
      if (!silent) showToast('No PocketLab API base is configured', 'err');
      return false;
    }

    const data = await apiFetch('/api/context', {}, 5000);
    setApiConnected(!!data);

    if (!silent) {
      showToast(
        data ? 'Connected to PocketLab server' : 'Could not reach PocketLab server',
        data ? 'ok' : 'err'
      );
    }

    return !!data;
  }

  const state = {
    uptimeStartedAt: Date.now(),
    device: {
      id: 'pocketlab-phone',
      model: '—',
      manufacturer: '—',
      androidVersion: '—',
      state: 'unknown'
    },
    current: {
      battery: null,
      charging: null,
      voltage: null,
      current: null,
      cpu: null,
      ramUsed: null,
      ramTotal: null,
      storageUsed: null,
      storageTotal: null,
      temperature: null,
      latency: null,
      packetLoss: null,
      download: null,
      upload: null,
      ip: null,
      gateway: null,
      dns: null,
      iface: null,
      health: null
    },
    history: {
      battery: [],
      cpu: [],
      ram: [],
      storage: [],
      temperature: [],
      latency: []
    },
    telemetryReceivedAt: null,
    telemetryFresh: false,
    iotTelemetry: null,
    context: null,
    rules: [],
    ai: null,
    latestCV: null,
    cvHistory: [],
    commandState: null,
    commandHistory: [],
    logs: [],
    logsPaused: false,
    activeLogFilter: 'ALL',
    logSearch: '',
    selectedIotDevice: 'pocketlab-phone'
  };

  function pushHistory(arr, value, max = 30) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    arr.push(value);
    if (arr.length > max) arr.shift();
  }

  function latencyQuality(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 35) return 'Excellent';
    if (ms < 70) return 'Good';
    if (ms < 110) return 'Fair';
    return 'Poor';
  }

  function drawSparkline(canvas, data, colorHex) {
    if (!canvas || data.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const min = Math.min(...data);
    const max = Math.max(...data);
    const pad = (max - min) * 0.2 || Math.max(1, max * 0.1);
    const lo = min - pad;
    const hi = max + pad;
    const stepX = w / (data.length - 1);
    const pts = data.map((v, i) => [
      i * stepX,
      h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8)
    ]);

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `${colorHex}4d`);
    grad.addColorStop(1, `${colorHex}00`);

    ctx.beginPath();
    ctx.moveTo(pts[0][0], h);
    pts.forEach(p => ctx.lineTo(p[0], p[1]));
    ctx.lineTo(pts.at(-1)[0], h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    const last = pts.at(-1);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 2.6, 0, Math.PI * 2);
    ctx.fillStyle = colorHex;
    ctx.shadowColor = colorHex;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  const STAT_DEFS = [
    { key: 'battery', label: 'Battery', icon: 'icon-battery', accent: 'device', unit: '%', decimals: 0, get: () => state.current.battery, hist: 'battery' },
    { key: 'cpu', label: 'CPU', icon: 'icon-cpu', accent: 'brand', unit: '%', decimals: 0, get: () => state.current.cpu, hist: 'cpu' },
    { key: 'ram', label: 'RAM', icon: 'icon-ram', accent: 'device', unit: '', decimals: 1, get: () => state.current.ramUsed, hist: 'ram' },
    { key: 'storage', label: 'Storage', icon: 'icon-storage', accent: 'security', unit: '', decimals: 1, get: () => state.current.storageUsed, hist: 'storage' },
    { key: 'temperature', label: 'Temperature', icon: 'icon-thermometer', accent: 'security', unit: '°C', decimals: 1, get: () => state.current.temperature, hist: 'temperature' },
    { key: 'latency', label: 'Network', icon: 'icon-network', accent: 'network', unit: 'ms', decimals: 0, get: () => state.current.latency, hist: 'latency', quality: true }
  ];

  function displayNum(value, decimals = 0) {
    return typeof value === 'number' && Number.isFinite(value)
      ? value.toFixed(decimals)
      : '—';
  }

  function buildStatCards() {
    const wrap = $('#statCards');
    if (!wrap) return;

    wrap.innerHTML = STAT_DEFS.map(def => `
      <div class="stat-card" data-accent="${def.accent}" data-key="${def.key}">
        <div class="stat-head">
          <span class="stat-icon">${iconUse(def.icon)}</span>
          <span class="stat-label">${def.label}</span>
          <span class="stat-trend" data-trend></span>
        </div>
        <div class="stat-value">
          <span class="num" data-num>—</span><span class="unit" data-unit>${esc(def.unit)}</span>
        </div>
        <canvas data-canvas></canvas>
        <div class="stat-foot">Live backend data · last 10 min</div>
      </div>
    `).join('');
  }

  function updateStatCards() {
    STAT_DEFS.forEach(def => {
      const card = $(`.stat-card[data-key="${def.key}"]`);
      if (!card) return;

      const value = def.get();
      const num = card.querySelector('[data-num]');
      const unit = card.querySelector('[data-unit]');
      const trend = card.querySelector('[data-trend]');

      if (def.key === 'ram') {
        num.textContent = displayNum(value, 1);
        unit.textContent = state.current.ramTotal != null ? ` / ${displayNum(state.current.ramTotal, 1)} GB` : ' GB';
      } else if (def.key === 'storage') {
        num.textContent = displayNum(value, 1);
        unit.textContent = state.current.storageTotal != null ? ` / ${displayNum(state.current.storageTotal, 1)} GB` : ' GB';
      } else if (def.key === 'latency') {
        num.textContent = displayNum(value, 0);
        unit.textContent = ' ms';
      } else if (def.key === 'battery') {
        num.textContent = displayNum(value, 0);
        unit.textContent = ' %';
      } else {
        num.textContent = displayNum(value, def.decimals);
        unit.textContent = ` ${def.unit}`;
      }

      if (def.quality) {
        trend.className = 'stat-trend quality';
        trend.textContent = latencyQuality(value);
      } else {
        trend.className = 'stat-trend';
        trend.textContent = '';
      }

      drawSparkline(card.querySelector('[data-canvas]'), state.history[def.hist], ACCENT_HEX[def.accent]);
    });
  }

  function serviceStateClass(online) {
    if (online === true) return 'dot-online';
    if (online === false) return 'dot-offline';
    return 'dot-warning';
  }

  function renderServiceList(container, services) {
    if (!container) return;

    container.innerHTML = services.map(s => `
      <div class="service-row">
        <span class="dot ${serviceStateClass(s.online)}"></span>
        <span class="svc-name">${esc(s.name)}</span>
        <span class="svc-meta">${esc(s.meta || (s.online === null ? 'unknown' : s.online ? 'online' : 'offline'))}</span>
      </div>
    `).join('');
  }

  function currentServices() {
    const iotTimestamp =
      state.iotTelemetry?.receivedAt ||
      state.telemetryReceivedAt ||
      null;

    const iotFresh =
      state.iotTelemetry
        ? isRecent(state.iotTelemetry.receivedAt, 45)
        : Boolean(state.telemetryFresh);

    return [
      {
        name: 'PocketLab Server',
        online: apiConnected,
        meta: apiConnected ? 'HTTP API · 3000' : 'unreachable'
      },
      {
        name: 'IoT Agent',
        online: iotFresh,
        meta: iotTimestamp
          ? `live telemetry · ${fmtIsoAgo(iotTimestamp)}`
          : 'waiting for telemetry'
      },
      {
        name: 'SSH',
        online: null,
        meta: 'not browser-verifiable'
      },
      {
        name: 'CV Agent',
        online: !!state.latestCV,
        meta: state.latestCV ? `last event · ${fmtIsoAgo(state.latestCV.receivedAt)}` : 'waiting for CV event'
      }
    ];
  }

  function renderOverviewServices() {
    renderServiceList($('#overviewServices'), currentServices());
  }

  function renderDeviceServices() {
    renderServiceList($('#deviceServices'), currentServices());
  }

  function fmtIsoAgo(iso) {
    if (!iso) return 'unknown';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return 'unknown';
    return fmtAgo(Date.now() - t);
  }

  function isRecent(iso, seconds) {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && (Date.now() - t) <= seconds * 1000;
  }

  function pushLog(level, msg, time = new Date()) {
    const signature = `${level}|${msg}|${new Date(time).toISOString().slice(0, 19)}`;
    if (state.logs.some(l => l.signature === signature)) return;
    state.logs.push({ time: new Date(time), level, msg, signature });
    if (state.logs.length > 250) state.logs.shift();
  }

  function syncLogsFromBackend() {
    const events = state.cvHistory || [];
    events.slice().reverse().forEach(event => {
      const action = event.command
        ? ` · ${event.command}${event.commandStatus ? ` → ${event.commandStatus}` : ''}`
        : '';

      const level =
        event.commandStatus === 'failed' ? 'ERROR' :
        event.commandStatus === 'completed' ? 'IOT' :
        'INFO';

      pushLog(
        level,
        `CV ${event.event} (${Number.isFinite(event.confidence) ? `${Math.round(event.confidence * 100)}%` : '—'})${action}`,
        event.receivedAt || new Date()
      );
    });

    if (state.iotTelemetry?.receivedAt) {
      pushLog(
        'IOT',
        'Phone telemetry synced',
        state.iotTelemetry.receivedAt
      );
    }
  }

  function renderLogRow(entry) {
    return `
      <div class="log-row lvl-${esc(entry.level)}">
        <span class="lg-time">${fmtTime(entry.time)}</span>
        <span class="lg-level">${esc(entry.level)}</span>
        <span class="lg-msg">${esc(entry.msg)}</span>
      </div>`;
  }

  function renderOverviewLogs() {
    const el = $('#overviewLogs');
    if (!el) return;
    const items = state.logs.slice(-6).reverse();
    el.innerHTML = items.map(renderLogRow).join('') ||
      '<div class="tool-output-empty">Waiting for live activity…</div>';
  }

  function renderDeviceTimeline() {
    const el = $('#deviceTimeline');
    if (!el) return;
    const items = state.logs.slice(-12).reverse();
    el.innerHTML = items.map(renderLogRow).join('') ||
      '<div class="tool-output-empty">Waiting for live activity…</div>';
  }

  function renderFullLogs() {
    const el = $('#fullLogStream');
    if (!el) return;

    let items = state.logs.slice().reverse();
    if (state.activeLogFilter !== 'ALL') {
      items = items.filter(l => l.level === state.activeLogFilter);
    }
    if (state.logSearch) {
      items = items.filter(l => l.msg.toLowerCase().includes(state.logSearch));
    }

    el.innerHTML = items.map(renderLogRow).join('') ||
      '<div class="tool-output-empty">No matching live log entries.</div>';
  }

  function renderAllLogViews() {
    renderOverviewLogs();
    renderDeviceTimeline();
    renderFullLogs();
  }

  function applyDeviceContext(context) {
    if (!context) return;

    state.context = context;
    state.device = {
      id: context.device?.id || 'pocketlab-phone',
      model: context.device?.model || '—',
      manufacturer: context.device?.manufacturer || '—',
      androidVersion: context.device?.androidVersion || '—',
      state: context.device?.state || 'unknown'
    };

    const b = context.battery || {};
    const t = context.temperature || {};

    state.current.battery = typeof b.percentage === 'number' ? b.percentage : state.current.battery;
    state.current.temperature = typeof t.value === 'number' ? t.value : state.current.temperature;
    state.current.charging = typeof b.charging === 'boolean' ? b.charging : state.current.charging;
    state.current.health = b.health || state.current.health;

    state.latestCV = context.latestAction ? {
      event: context.latestAction.gesture,
      confidence: context.latestAction.confidence,
      command: context.latestAction.command,
      commandStatus: context.latestAction.status,
      commandResult: context.latestAction.result,
      receivedAt: context.latestAction.timestamp
    } : state.latestCV;

    state.rules = context.rules?.alerts || [];

    const ts = context.telemetry?.receivedAt || null;
    state.telemetryReceivedAt = ts;
    state.telemetryFresh = !!context.telemetry?.fresh;

    updateDeviceIdentity();
    updateStatusPills();
    updateDevicePage();
    renderOverviewServices();
    renderDeviceServices();
    renderIotDeviceList();
    renderIotDetail();
  }

  function applyTelemetry(data) {
    if (!data) return;

    const b = data.battery || {};
    const cpu = data.cpu || {};
    const mem = data.memory || {};
    const storage = data.storage || {};
    const net = data.network || {};

    Object.assign(state.current, {
      battery: typeof b.percentage === 'number' ? b.percentage : state.current.battery,
      charging: typeof b.charging === 'boolean' ? b.charging : state.current.charging,
      voltage: typeof b.voltage === 'number' ? b.voltage : state.current.voltage,
      temperature: typeof b.temperature === 'number' ? b.temperature : state.current.temperature,
      cpu: typeof cpu.usage === 'number' ? cpu.usage : state.current.cpu,
      ramUsed: typeof mem.usedGB === 'number' ? mem.usedGB : state.current.ramUsed,
      ramTotal: typeof mem.totalGB === 'number' ? mem.totalGB : state.current.ramTotal,
      storageUsed: typeof storage.usedGB === 'number' ? storage.usedGB : state.current.storageUsed,
      storageTotal: typeof storage.totalGB === 'number' ? storage.totalGB : state.current.storageTotal,
      latency: typeof net.latencyMs === 'number' ? net.latencyMs : state.current.latency,
      packetLoss: typeof net.packetLoss === 'number' ? net.packetLoss : state.current.packetLoss,
      download: typeof net.downloadMbps === 'number' ? net.downloadMbps : state.current.download,
      upload: typeof net.uploadMbps === 'number' ? net.uploadMbps : state.current.upload,
      ip: net.ip || state.current.ip,
      iface: net.interface || state.current.iface
    });

    Object.keys(state.history).forEach(k => {
      const currentMap = {
        battery: state.current.battery,
        cpu: state.current.cpu,
        ram: state.current.ramUsed,
        storage: state.current.storageUsed,
        temperature: state.current.temperature,
        latency: state.current.latency
      };
      pushHistory(state.history[k], currentMap[k]);
    });

    if (data.timestamp) {
      state.telemetryReceivedAt = data.timestamp;
      state.telemetryFresh = true;
    }

    setApiConnected(true);
  }

  function applyIotTelemetry(data) {
    if (!data?.telemetry) return;
    state.iotTelemetry = data.telemetry;
    state.telemetryReceivedAt = data.telemetry.receivedAt || state.telemetryReceivedAt;
    syncLogsFromBackend();
  }

  function updateStatusPills() {
    const phone = $('#pillPhone');
    const ssh = $('#pillSSH');
    const iot = $('#pillIoT');

    if (phone) {
      const online = state.device.state === 'online' || state.device.state === 'online_last_known';
      phone.innerHTML = `<i class="dot ${online ? 'dot-online' : 'dot-offline'}"></i><span>Phone</span>`;
    }

    if (ssh) {
      ssh.innerHTML = `<i class="dot dot-warning"></i><span>SSH</span>`;
      ssh.title = 'SSH status is not exposed to browser JavaScript';
    }

    if (iot) {
      const online = state.iotTelemetry && isRecent(state.iotTelemetry.receivedAt, 45);
      iot.innerHTML = `<i class="dot ${online ? 'dot-online' : 'dot-offline'}"></i><span>IoT Agent</span>`;
    }
  }

  function updateDeviceIdentity() {
    const page = $('#page-device');
    if (!page) return;

    const values = page.querySelectorAll('.kv-list dd');
    if (values.length >= 4) {
      values[0].textContent = state.device.model;
      values[1].textContent = state.device.androidVersion;
      values[2].textContent = 'ARM64 / runtime-reported';
    }

    const badge = page.querySelector('.badge');
    if (badge) {
      const online = state.device.state === 'online' || state.device.state === 'online_last_known';
      badge.className = `badge ${online ? 'badge-online' : 'badge-warning'}`;
      badge.innerHTML = `<i class="dot ${online ? 'dot-online' : 'dot-warning'}"></i> ${esc(
        state.device.state.replaceAll('_', ' ')
      )}`;
    }

    const miniMeta = document.querySelector('.sidebar-footer .mini-meta');
    if (miniMeta) {
      miniMeta.textContent =
        `${state.device.model} · Android ${state.device.androidVersion}`;
    }
  }

  function updateDevicePage() {
    const c = state.current;

    const setText = (id, value) => {
      const el = $(`#${id}`);
      if (el) el.textContent = value;
    };

    setText('battPct', c.battery == null ? '—' : `${Math.round(c.battery)}%`);
    setText('battTemp', c.temperature == null ? '—' : `${Number(c.temperature).toFixed(1)}°C`);
    setText('battCharging', c.charging == null ? '—' : c.charging ? 'Yes' : 'No');
    setText('battVoltage', c.voltage == null ? '—' : `${Number(c.voltage).toFixed(2)} V`);
    setText('battCurrent', 'Live current not exposed by API');

    const elapsed = Math.floor((Date.now() - state.uptimeStartedAt) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    setText('deviceUptime', `${h}h ${m}m ${s}s`);

    const bars = $('#resourceBars');
    if (!bars) return;

    const rows = [
      { name: 'CPU', icon: 'icon-cpu', val: c.cpu, max: 100, suffix: '%' },
      { name: 'Memory', icon: 'icon-ram', val: c.ramUsed, max: c.ramTotal, suffix: c.ramTotal != null ? ` / ${c.ramTotal.toFixed(1)} GB` : '' },
      { name: 'Storage', icon: 'icon-storage', val: c.storageUsed, max: c.storageTotal, suffix: c.storageTotal != null ? ` / ${c.storageTotal.toFixed(1)} GB` : '' }
    ];

    bars.innerHTML = rows.map(r => {
      const numeric = typeof r.val === 'number' && Number.isFinite(r.val);
      const pct = numeric && typeof r.max === 'number' && r.max > 0
        ? clamp((r.val / r.max) * 100, 0, 100)
        : 0;

      return `
        <div class="resource-bar-row">
          <div class="rb-top">
            <span class="rb-name">${iconUse(r.icon)} ${esc(r.name)}</span>
            <span class="rb-val">${numeric ? r.val.toFixed(r.suffix.includes('%') ? 0 : 1) : '—'}${esc(r.suffix)}</span>
          </div>
          <div class="rb-track"><div class="rb-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
  }

  const NETWORK_DEFS = [
    { key: 'iface', label: 'Interface', get: () => state.current.iface || '—' },
    { key: 'ip', label: 'IP Address', get: () => state.current.ip || '—' },
    { key: 'gateway', label: 'Gateway', get: () => state.current.gateway || '—' },
    { key: 'dns', label: 'DNS', get: () => state.current.dns || '—' },
    { key: 'latency', label: 'Latency', get: () => state.current.latency == null ? '—' : `${Math.round(state.current.latency)} ms` },
    { key: 'loss', label: 'Packet Loss', get: () => state.current.packetLoss == null ? '—' : `${state.current.packetLoss}%` },
    { key: 'download', label: 'Download', get: () => state.current.download == null ? '—' : `${Number(state.current.download).toFixed(1)} Mbps` },
    { key: 'upload', label: 'Upload', get: () => state.current.upload == null ? '—' : `${Number(state.current.upload).toFixed(1)} Mbps` }
  ];

  function buildNetworkCards() {
    const wrap = $('#networkCards');
    if (!wrap) return;
    wrap.innerHTML = NETWORK_DEFS.map(d => `
      <div class="stat-card" data-accent="network" data-net="${d.key}">
        <div class="stat-head"><span class="stat-label">${esc(d.label)}</span></div>
        <div class="stat-value"><span class="num mono" data-netval style="font-size:19px;">—</span></div>
      </div>
    `).join('');
  }

  function updateNetworkCards() {
    NETWORK_DEFS.forEach(d => {
      const el = document.querySelector(`.stat-card[data-net="${d.key}"] [data-netval]`);
      if (el) el.textContent = d.get();
    });
  }

  function buildSecurityCards() {
    const openCount = state.device.state !== 'unknown' ? 2 : 0;
    const wrap = $('#securityCards');
    if (!wrap) return;

    wrap.innerHTML = [
      { label: 'Target', val: state.current.ip || '—' },
      { label: 'PocketLab', val: apiConnected ? 'Reachable' : 'Offline' },
      { label: 'Open Ports', val: String(openCount) },
      { label: 'HTTP', val: '3000' }
    ].map(c => `
      <div class="stat-card" data-accent="security">
        <div class="stat-head"><span class="stat-label">${esc(c.label)}</span></div>
        <div class="stat-value"><span class="num mono" style="font-size:19px;">${esc(c.val)}</span></div>
      </div>
    `).join('');

    const headerBadge = $('.badge-warning', $('#page-security'));
    if (headerBadge) {
      headerBadge.innerHTML = `<i class="dot dot-warning"></i> Dashboard-only browser scan`;
    }
  }

  function buildServicesTable() {
    const table = $('#servicesTable');
    if (!table) return;

    const ports = [
      { port: 22, service: 'SSH', open: true, detail: 'managed outside browser' },
      { port: 3000, service: 'PocketLab', open: apiConnected, detail: 'Node.js / Express API' },
      { port: 80, service: 'HTTP', open: false, detail: 'not exposed by PocketLab' },
      { port: 443, service: 'HTTPS', open: false, detail: 'not exposed by PocketLab' }
    ];

    table.innerHTML = `
      <thead><tr><th>Port</th><th>Service</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>
        ${ports.map(p => `
          <tr>
            <td>${p.port}</td>
            <td>${esc(p.service)}</td>
            <td class="${p.open ? 'status-open' : 'status-closed'}">${p.open ? 'OPEN' : 'CLOSED'}</td>
            <td>${esc(p.detail)}</td>
          </tr>`).join('')}
      </tbody>`;
  }

  const commandLabels = {
    status: 'status',
    telemetry: 'telemetry',
    device_info: 'device_info',
    safe: 'safe'
  };

  function updateCommandOptions() {
    const command = $('#cmdCommand');
    if (!command) return;
    const allowed = Object.keys(commandLabels);
    command.innerHTML = allowed.map(k => `<option value="${k}">${k}</option>`).join('');
  }

  function renderIotDeviceList() {
    const wrap = $('#iotDeviceList');
    if (!wrap) return;

    const d = {
      id: 'pocketlab-phone',
      name: state.device.id || 'pocketlab-phone',
      type: 'Android',
      online: state.device.state === 'online' || state.device.state === 'online_last_known',
      lastSeen: state.iotTelemetry?.receivedAt ? Date.parse(state.iotTelemetry.receivedAt) : Date.now()
    };

    wrap.innerHTML = `
      <div class="device-item active" data-device="pocketlab-phone">
        <span class="dot ${d.online ? 'dot-online' : 'dot-offline'}"></span>
        <div class="di-info">
          <div class="di-name">${esc(d.name)}</div>
          <div class="di-meta">${d.type} · ${d.online ? 'Online / last known' : fmtAgo(Date.now() - d.lastSeen)}</div>
        </div>
      </div>
    `;
  }

  function renderIotDetail() {
    const panel = $('#iotDetailPanel');
    if (!panel) return;

    const c = state.current;
    const latest = state.latestCV;

    panel.innerHTML = `
      <div class="detail-head">
        <span class="dot ${apiConnected ? 'dot-online' : 'dot-offline'}"></span>
        <h3>${esc(state.device.id || 'pocketlab-phone')}</h3>
      </div>
      <div class="detail-grid">
        <dl class="kv-list">
          <div><dt>Battery</dt><dd>${c.battery == null ? '—' : `${Math.round(c.battery)}%`}</dd></div>
          <div><dt>Temperature</dt><dd>${c.temperature == null ? '—' : `${Number(c.temperature).toFixed(1)}°C`}</dd></div>
        </dl>
        <dl class="kv-list">
          <div><dt>Latency</dt><dd>${c.latency == null ? '—' : `${Math.round(c.latency)} ms`}</dd></div>
          <div><dt>Last CV</dt><dd>${latest?.event ? esc(latest.event) : '—'}</dd></div>
        </dl>
      </div>
      <div class="detail-sub">
        <div class="panel-head" style="margin-bottom:10px;"><h3>Commands</h3></div>
        <button class="btn btn-primary" id="iotStatusBtn">${iconUse('icon-send')} STATUS</button>
      </div>
      <div class="detail-sub">
        <div class="panel-head" style="margin-bottom:6px;"><h3>Command history</h3></div>
        <div class="log-stream" id="iotHistory"></div>
      </div>
    `;

    $('#iotStatusBtn')?.addEventListener('click', () => sendCommand('status', true));
    renderIotHistory();
  }

  function getBackendCommandHistory(limit = 20) {
    const fromCv = (state.cvHistory || [])
      .filter(e => e && e.command)
      .map(e => ({
        time: e.receivedAt || e.commandResult?.timestamp || e.createdAt || null,
        device: state.device.id,
        command: e.command,
        commandId: e.commandId || null,
        status: e.commandStatus || 'queued',
        result: e.commandResult ?? null,
        source: 'history'
      }));

    const fromQueue = state.commandState?.command
      ? [{
          time: state.commandState.acknowledgedAt || state.commandState.createdAt,
          device: state.device.id,
          command: state.commandState.command,
          commandId: state.commandState.commandId,
          status: state.commandState.status || 'queued',
          result: state.commandState.result ?? null,
          source: 'live'
        }]
      : [];

    const seen = new Set();

    return [...fromCv, ...fromQueue]
      .filter(item => {
        const key = item.commandId
          ? `id:${item.commandId}`
          : `${item.command}|${item.time}|${item.status}`;

        if (seen.has(key)) return false;

        seen.add(key);
        return true;
      })
      .filter(item => item.time)
      .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
      .slice(0, limit);
  }

  function renderIotHistory() {
    const el = $('#iotHistory');
    if (!el) return;

    const items = getBackendCommandHistory(8);

    el.innerHTML = items.map(c => `
      <div class="log-row lvl-${c.status === 'failed' ? 'ERROR' : 'IOT'}">
        <span class="lg-time">${fmtTime(new Date(c.time))}</span>
        <span class="lg-level">${esc(c.command)}</span>
        <span class="lg-msg">→ ${esc(c.status || 'queued')}${c.commandId ? ` · ${esc(c.commandId)}` : ''}</span>
      </div>
    `).join('') || '<div class="tool-output-empty">No command history is available yet.</div>';
  }

  function renderCmdHistory() {
    const el = $('#cmdHistory');
    if (!el) return;

    const backend = getBackendCommandHistory(12);

    el.innerHTML = backend.map(c => `
      <div class="log-row lvl-${c.status === 'failed' ? 'ERROR' : 'INFO'}">
        <span class="lg-time">${fmtTime(new Date(c.time))}</span>
        <span class="lg-level">${esc(c.device || state.device.id)}</span>
        <span class="lg-msg">${esc(c.command)} → ${esc(c.status || 'queued')} ${c.source === 'live' ? '· live' : ''}</span>
      </div>
    `).join('') || '<div class="tool-output-empty">No command history is available yet.</div>';
  }

  async function waitForCommand(commandId, timeoutMs = 12000) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const data = await apiFetch('/api/device/command', {}, 4000);
      if (data?.command?.commandId === commandId) {
        if (data.command.status === 'completed' || data.command.status === 'failed' || data.command.status === 'error') {
          return data.command;
        }
      }
      await new Promise(r => setTimeout(r, 700));
    }

    return null;
  }

  async function sendCommand(command, fromIot = false) {
    const outEl = fromIot ? null : $('#cmdOutput');

    if (!apiConnected) {
      if (outEl) outEl.innerHTML = `<div class="out-line"><span class="ok">${iconUse('icon-alert-triangle')}</span> PocketLab server is not connected.</div>`;
      showToast('Command not sent: PocketLab server offline', 'err');
      return;
    }

    if (CONFIG.confirmCommands) {
      const ok = window.confirm(`Send "${command}" to ${state.device.id}?`);
      if (!ok) return;
    }

    if (outEl) {
      outEl.innerHTML = `<div class="tool-output-empty">Queueing <b>${esc(command)}</b>…</div>`;
    }

    const queued = await apiFetch('/api/device/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    }, 5000);

    if (!queued?.command?.commandId) {
      if (outEl) outEl.innerHTML = `<div class="out-line"><span class="ok">${iconUse('icon-alert-triangle')}</span> PocketLab rejected the command.</div>`;
      showToast('Command could not be queued', 'err');
      return;
    }

    const commandId = queued.command.commandId;

    if (outEl) {
      outEl.innerHTML = `<div class="out-line"><span class="ok">${iconUse('icon-check-circle')}</span> Queued · waiting for phone acknowledgement…</div>`;
    }

    const completed = await waitForCommand(commandId);

    const entry = {
      device: state.device.id,
      command,
      commandId,
      time: new Date(),
      ok: !!completed && completed.status === 'completed',
      status: completed?.status || 'timeout',
      result: completed?.result ?? null
    };

    state.commandHistory.push(entry);
    if (state.commandHistory.length > 100) state.commandHistory.shift();

    if (completed) {
      state.commandState = completed;
    }

    if (outEl) {
      outEl.innerHTML = completed
        ? `<div class="out-line"><span class="${completed.status === 'completed' ? 'ok' : 'text-danger'}">${iconUse(completed.status === 'completed' ? 'icon-check-circle' : 'icon-alert-triangle')}</span> Live response · ${esc(completed.status)}</div>
           <pre class="mono-block">${esc(JSON.stringify(completed, null, 2))}</pre>`
        : `<div class="out-line"><span class="text-danger">${iconUse('icon-alert-triangle')}</span> Command acknowledgement timed out.</div>`;
    }

    pushLog(entry.ok ? 'IOT' : 'ERROR', `Command "${command}" → ${entry.status}`);
    renderCmdHistory();
    renderIotHistory();
    renderAllLogViews();
    await refreshContext();
    await refreshAI();
  }

  function buildNetworkToolOutput(title, body) {
    const out = $('#networkToolOutput');
    if (!out) return;
    out.innerHTML = `
      <div class="out-line"><span class="ok">${iconUse('icon-check-circle')}</span> ${esc(title)}</div>
      <pre class="mono-block">${esc(body)}</pre>
    `;
  }

  async function runNetworkTool(tool, outEl, btn) {
    if (!outEl || !btn) return;

    btn.classList.add('running');
    try {
      if (tool === 'ping') {
        buildNetworkToolOutput(
          'Live backend network sample',
          JSON.stringify({
            target: state.current.gateway || 'gateway',
            latencyMs: state.current.latency,
            packetLoss: state.current.packetLoss,
            quality: latencyQuality(state.current.latency)
          }, null, 2)
        );
        pushLog('NETWORK', 'Live network sample viewed');
      } else if (tool === 'portscan' || tool === 'servicescan') {
        buildNetworkToolOutput(
          'PocketLab service exposure',
          JSON.stringify([
            { port: 22, service: 'SSH', status: 'open', note: 'browser cannot inspect SSH configuration' },
            { port: 3000, service: 'PocketLab', status: apiConnected ? 'open' : 'unreachable', note: 'HTTP API' },
            { port: 80, service: 'HTTP', status: 'closed' },
            { port: 443, service: 'HTTPS', status: 'closed' }
          ], null, 2)
        );
        pushLog('SECURITY', `${tool} view opened`);
      } else if (tool === 'dns') {
        buildNetworkToolOutput(
          'DNS lookup',
          'The PocketLab browser API does not expose arbitrary DNS lookup. Use Termux for authoritative DNS diagnostics.'
        );
        pushLog('NETWORK', 'DNS tool note viewed');
      } else if (tool === 'traceroute') {
        buildNetworkToolOutput(
          'Traceroute',
          'The PocketLab HTTP API does not expose traceroute. Use Termux ping/traceroute for authoritative route diagnostics.'
        );
        pushLog('NETWORK', 'Traceroute tool note viewed');
      }
    } finally {
      btn.classList.remove('running');
      renderAllLogViews();
    }
  }

  function renderAi() {
    const interpretation = state.ai;
    const latest = state.latestCV;
    const risk = interpretation?.riskLevel || '—';

    $('#aiCameraStatus').textContent =
      latest ? `Agent live · ${latest.event}` : 'Waiting for laptop CV agent';

    $('#aiFps').textContent = risk === '—' ? '—' : risk.toUpperCase();

    $('#aiConfidence').textContent =
      latest?.confidence != null
        ? `${Math.round(latest.confidence * 100)}% · ${latest.command || 'event'}`
        : '—';

    const detected = $('#aiDetected');
    if (detected) {
      const chips = [];
      if (latest?.event) chips.push(latest.event);
      if (latest?.command) chips.push(`→ ${latest.command}`);
      if (state.rules.length) {
        state.rules.forEach(r => chips.push(r.code));
      }

      detected.innerHTML = (chips.length ? chips : ['Waiting for CV event'])
        .slice(0, 6)
        .map(v => `<span class="chip static">${esc(v)}</span>`)
        .join('');
    }

    const reasoning = $('#aiInterpretation');
    if (reasoning) {
      if (!interpretation) {
        reasoning.textContent = 'Waiting for live PocketLab AI interpretation…';
      } else {
        const lines = [
          `${interpretation.headline || 'PocketLab AI'}`,
          '',
          interpretation.summary || '',
          '',
          ...(interpretation.recommendations || []).slice(0, 3).map(x => `• ${x}`),
          '',
          `Next action: ${interpretation.nextAction || 'Continue monitoring.'}`
        ];

        reasoning.textContent = lines.join('\n');
      }
    }
  }

  let aiStream = null;

  async function enableAiCamera() {
    const viewport = $('#aiViewport');
    const video = $('#aiVideo');

    if (!navigator.mediaDevices?.getUserMedia) {
      showToast('Camera preview is not available in this browser', 'err');
      return;
    }

    try {
      aiStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false
      });

      video.srcObject = aiStream;
      await video.play();
      viewport.classList.add('live');
      $('#aiCameraStatus').textContent = 'Browser preview live';
      pushLog('INFO', 'Browser camera preview enabled');
      showToast('Browser preview enabled');
    } catch {
      showToast('Camera unavailable — check browser permissions', 'err');
    }
  }

  async function refreshContext() {
    const data = await apiFetch('/api/context', {}, 6000);
    if (!data?.context) {
      setApiConnected(false);
      renderOverviewServices();
      renderDeviceServices();
      return null;
    }

    setApiConnected(true);
    applyDeviceContext(data.context);
    syncLogsFromBackend();
    renderAllLogViews();
    return data.context;
  }

  async function refreshIoTTelemetry() {
    const data = await apiFetch('/api/telemetry/iot', {}, 5000);
    if (data?.success) {
      applyIotTelemetry(data);
      renderOverviewServices();
      renderDeviceServices();
      updateStatusPills();
    }
    return data;
  }

  async function refreshDetailedTelemetry() {
    const data = await apiFetch('/api/telemetry', {}, 15000);
    if (!data) {
      setApiConnected(false);
      return null;
    }

    applyTelemetry(data);
    updateStatCards();
    updateDevicePage();
    updateNetworkCards();
    buildSecurityCards();
    buildServicesTable();
    renderOverviewServices();
    renderDeviceServices();
    updateStatusPills();
    return data;
  }

  async function refreshCVHistory() {
    const data = await apiFetch('/api/cv/history?limit=25', {}, 5000);
    if (data?.success) {
      state.cvHistory = Array.isArray(data.history) ? data.history : [];
      state.latestCV = state.cvHistory[0] || state.latestCV;
      syncLogsFromBackend();
      renderAi();
      renderIotDetail();
      renderAllLogViews();
    }
    return data;
  }

  async function refreshAI() {
    const data = await apiFetch('/api/ai/interpret', {}, 7000);
    if (data?.success) {
      state.ai = data.interpretation;
      renderAi();
    }
    return data;
  }

  /* =========================================================
     SETTINGS
     ========================================================= */
  function updateApiFieldMode() {
    const input = $('#settingApiBase');
    const discovery = $('#settingDiscovery');
    if (!input || !discovery) return;

    if (discovery.checked && hostedOnPocketLab) {
      input.value = DEFAULT_API_BASE;
      input.readOnly = true;
      input.title = 'Automatic: uses the PocketLab server that delivered this dashboard.';
    } else {
      input.readOnly = false;
      input.title = '';
    }
  }

  function loadSettingsIntoUI() {
    const input = $('#settingApiBase');
    const discovery = $('#settingDiscovery');

    if (discovery) {
      discovery.checked = CONFIG.autoDiscovery;
    }

    if (input) {
      input.value =
        CONFIG.autoDiscovery && hostedOnPocketLab
          ? DEFAULT_API_BASE
          : (CONFIG.apiBase || '');
    }

    $('#settingTelemetryInterval').value = Math.round(CONFIG.telemetryInterval / 1000);
    $('#settingIotInterval').value = Math.round(CONFIG.iotInterval / 1000);
    $('#telemetryIntervalVal').textContent = `${Math.round(CONFIG.telemetryInterval / 1000)}s`;
    $('#iotIntervalVal').textContent = `${Math.round(CONFIG.iotInterval / 1000)}s`;
    $('#settingLogging').checked = CONFIG.verboseLogging;
    $('#settingAuth').checked = CONFIG.confirmCommands;

    updateApiFieldMode();
  }

  function bindSettings() {
    $('#settingTelemetryInterval')?.addEventListener('input', e => {
      $('#telemetryIntervalVal').textContent = `${e.target.value}s`;
    });

    $('#settingIotInterval')?.addEventListener('input', e => {
      $('#iotIntervalVal').textContent = `${e.target.value}s`;
    });

    $('#settingDiscovery')?.addEventListener('change', e => {
      CONFIG.autoDiscovery = e.target.checked;

      if (CONFIG.autoDiscovery && hostedOnPocketLab) {
        CONFIG.apiBase = DEFAULT_API_BASE;
        localStorage.removeItem('pocketlab.apiBase');
      } else if (!CONFIG.autoDiscovery) {
        CONFIG.apiBase = $('#settingApiBase').value.trim().replace(/\/$/, '');
      }

      localStorage.setItem('pocketlab.autoDiscovery', String(CONFIG.autoDiscovery));
      updateApiFieldMode();

      showToast(
        CONFIG.autoDiscovery
          ? 'Automatic server connection enabled'
          : 'Manual API base mode enabled'
      );
    });

    $('#settingTestConnection')?.addEventListener('click', async () => {
      CONFIG.apiBase =
        CONFIG.autoDiscovery && hostedOnPocketLab
          ? DEFAULT_API_BASE
          : $('#settingApiBase').value.trim().replace(/\/$/, '');

      await checkApiConnection(false);
    });

    $('#settingsSave')?.addEventListener('click', async () => {
      if (CONFIG.autoDiscovery && hostedOnPocketLab) {
        CONFIG.apiBase = DEFAULT_API_BASE;
        localStorage.removeItem('pocketlab.apiBase');
      } else {
        CONFIG.apiBase = $('#settingApiBase').value.trim().replace(/\/$/, '');
        localStorage.setItem('pocketlab.apiBase', CONFIG.apiBase);
      }

      CONFIG.telemetryInterval = Number($('#settingTelemetryInterval').value) * 1000;
      CONFIG.iotInterval = Number($('#settingIotInterval').value) * 1000;
      CONFIG.confirmCommands = $('#settingAuth').checked;
      CONFIG.verboseLogging = $('#settingLogging').checked;

      localStorage.setItem('pocketlab.autoDiscovery', String(CONFIG.autoDiscovery));
      localStorage.setItem('pocketlab.telemetryInterval', String(CONFIG.telemetryInterval));
      localStorage.setItem('pocketlab.iotInterval', String(CONFIG.iotInterval));
      localStorage.setItem('pocketlab.confirmCommands', String(CONFIG.confirmCommands));
      localStorage.setItem('pocketlab.verboseLogging', String(CONFIG.verboseLogging));

      updateApiFieldMode();
      await checkApiConnection(false);
      restartTimers();
      showToast('Settings saved');
      pushLog(
        'INFO',
        CONFIG.autoDiscovery
          ? 'Dashboard configured for automatic same-origin PocketLab connection'
          : 'Dashboard settings updated'
      );
      renderAllLogViews();
    });

    $('#settingDeviceName')?.addEventListener('change', e => {
      const name = e.target.value.trim() || 'pocketlab-phone';
      const span = $('#miniDot')?.parentElement?.querySelector('span:last-child');
      if (span) span.textContent = name;
    });
  }

  /* =========================================================
     TOASTS
     ========================================================= */
  function showToast(msg, type = 'ok') {
    const container = $('#toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast glass ${type === 'err' ? 'err' : ''}`;
    toast.innerHTML =
      `${iconUse(type === 'err' ? 'icon-alert-triangle' : 'icon-check-circle')} <span>${esc(msg)}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 260);
    }, 3200);
  }

  /* =========================================================
     NAVIGATION
     ========================================================= */
  const PAGE_META = {
    overview: { title: 'Overview', subtitle: 'Live snapshot of your device laboratory' },
    device: { title: 'Device', subtitle: 'Identity, battery, resources & runtime' },
    network: { title: 'Network', subtitle: 'Discovery, connectivity & throughput' },
    security: { title: 'Security Lab', subtitle: 'Host scanning & exposed services' },
    iot: { title: 'IoT', subtitle: 'Phone telemetry, CV actions & commands' },
    command: { title: 'Command Center', subtitle: 'Two-way device communication' },
    logs: { title: 'Logs', subtitle: 'Global live event stream' },
    ai: { title: 'AI / CV', subtitle: 'Computer Vision events & PocketLab local reasoning' },
    settings: { title: 'Settings', subtitle: 'Dashboard & connection configuration' }
  };

  function goToPage(page) {
    $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
    const meta = PAGE_META[page];
    if (meta) {
      $('#pageTitle').textContent = meta.title;
      $('#pageSubtitle').textContent = meta.subtitle;
    }
    $('#app').classList.remove('mobile-nav-open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function bindNav() {
    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => goToPage(btn.dataset.page)));
    $$('[data-nav]').forEach(btn => btn.addEventListener('click', () => goToPage(btn.dataset.nav)));
    $('#menuToggle')?.addEventListener('click', () => $('#app').classList.add('mobile-nav-open'));
    $('#sidebarScrim')?.addEventListener('click', () => $('#app').classList.remove('mobile-nav-open'));
    $('#collapseBtn')?.addEventListener('click', () => $('#app').classList.toggle('sidebar-collapsed'));
  }

  function bindNetworkTools() {
    $$('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => runNetworkTool(btn.dataset.tool, $('#networkToolOutput'), btn));
    });
  }

  function bindCommandCenter() {
    $('#cmdSend')?.addEventListener('click', () => {
      sendCommand($('#cmdCommand').value);
    });
  }

  function bindLogControls() {
    $$('.chip[data-filter]').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('.chip[data-filter]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeLogFilter = chip.dataset.filter;
        renderFullLogs();
      });
    });

    $('#logSearch')?.addEventListener('input', e => {
      state.logSearch = e.target.value.trim().toLowerCase();
      renderFullLogs();
    });

    $('#logStreamToggle')?.addEventListener('click', () => {
      state.logsPaused = !state.logsPaused;
      $('#logStreamToggle').innerHTML = state.logsPaused
        ? `${iconUse('icon-play')} <span>Resume</span>`
        : `${iconUse('icon-pause')} <span>Pause</span>`;
    });
  }

  function bindOverviewRefresh() {
    $('#refreshOverview')?.addEventListener('click', async () => {
      await Promise.all([
        refreshContext(),
        refreshDetailedTelemetry(),
        refreshIoTTelemetry(),
        refreshCVHistory(),
        refreshAI()
      ]);
      showToast('Live data refreshed');
    });
  }

  function bindAi() {
    $('#aiEnableCamera')?.addEventListener('click', enableAiCamera);
  }

  /* =========================================================
     CLOCK / TIMERS
     ========================================================= */
  function tickClock() {
    const clock = $('#clock');
    if (clock) clock.textContent = fmtTime();
  }

  let timers = [];

  function restartTimers() {
    timers.forEach(clearInterval);
    timers = [
      setInterval(() => refreshDetailedTelemetry(), CONFIG.telemetryInterval),
      setInterval(() => refreshIoTTelemetry(), CONFIG.iotInterval),
      setInterval(() => refreshContext(), CONFIG.contextInterval),
      setInterval(() => refreshAI(), CONFIG.aiInterval),
      setInterval(() => refreshCVHistory(), Math.max(3000, CONFIG.iotInterval)),
      setInterval(tickClock, 1000)
    ];
  }

  async function init() {
    buildStatCards();
    buildNetworkCards();
    buildSecurityCards();
    buildServicesTable();
    updateCommandOptions();
    loadSettingsIntoUI();

    bindNav();
    bindNetworkTools();
    bindCommandCenter();
    bindLogControls();
    bindOverviewRefresh();
    bindSettings();
    bindAi();

    tickClock();
    setApiConnected(false);

    pushLog('INFO', 'Dashboard initialized');
    renderAllLogViews();

    await Promise.all([
      refreshContext(),
      refreshDetailedTelemetry(),
      refreshIoTTelemetry(),
      refreshCVHistory(),
      refreshAI()
    ]);

    renderAllLogViews();
    restartTimers();

    window.addEventListener('resize', () => {
      STAT_DEFS.forEach(def => {
        const canvas = document.querySelector(`.stat-card[data-key="${def.key}"] [data-canvas]`);
        drawSparkline(canvas, state.history[def.hist], ACCENT_HEX[def.accent]);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
