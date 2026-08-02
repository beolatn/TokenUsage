'use strict';

var obsidian = require('obsidian');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Constants ────────────────────────────────────────────────────
const VIEW_TYPE  = 'token-usage-view';
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const HELP_URL   = 'https://www.langeatn.de/docs/token-usage/';

const MODEL_COLORS = {
  Haiku:  '#06B6D4',
  Sonnet: '#4A90D9',
  Opus:   '#9B5DE5',
  Fable:  '#E9C46A',
  Other:  '#6B7280',
};

const DEFAULT_SETTINGS = {
  refreshSeconds: 30,
  reportPath:     'Token Usage Report.md',
  dashboardPath:  'Token Usage Dashboard.html',
};

// Logo SVG — compact bar chart using plugin accent colors
const LOGO_SVG = `<svg width="15" height="12" viewBox="0 0 15 12" fill="none" aria-hidden="true" style="flex-shrink:0">
  <rect x="0"    y="7" width="2.5" height="5"  rx="0.6" fill="#4A90D9" opacity="0.45"/>
  <rect x="3.5"  y="3" width="2.5" height="9"  rx="0.6" fill="#4A90D9" opacity="0.65"/>
  <rect x="7"    y="0" width="2.5" height="12" rx="0.6" fill="#4A90D9"/>
  <rect x="10.5" y="4" width="2.5" height="8"  rx="0.6" fill="#9B5DE5" opacity="0.80"/>
</svg>`;

// Glossary entries shown in the help panel
const HELP_SECTIONS = [
  {
    title: 'Tokens',
    body:  'The unit Claude bills for. Every word, punctuation mark, and space in a message is split into tokens — roughly 4 characters or ¾ of a word each. Both your input AND Claude\'s response are counted separately.',
  },
  {
    title: 'Input & Output',
    body:  'Input = everything you send (message + conversation history + system prompt). Output = everything Claude writes back. Output tokens typically cost 3–5× more than input tokens.',
  },
  {
    title: 'C.Write — Cache Write',
    body:  'When Claude processes a long context for the first time, it can store ("write") it into a prompt cache. Cache Write costs ~1.25× regular input — a small premium paid upfront to unlock future savings.',
  },
  {
    title: 'C.Read — Cache Read',
    body:  'Any follow-up request that reuses the same cached context is served at ~0.10× the input price — roughly 10× cheaper than reprocessing. A high C.Read value means you are working efficiently with the same material.',
  },
  {
    title: 'C.Write vs C.Read — what the ratio tells you',
    body:  'Reuse Factor = C.Read ÷ C.Write. High ratio → deep focus, same context across many requests. Low ratio → exploratory mode, constant context switches.\n\n≥ 8×  Deep focus — excellent cache return.\n3–8×  Balanced — focused work with some variety.\n1–3×  Exploratory — frequent new context.\n< 1×  Minimal reuse — mostly independent short sessions.',
  },
  {
    title: '5h Window',
    body:  'Claude rate-limits usage on a rolling 5-hour window starting from your first request. When the window closes, capacity resets. "↺ Xh Ym" in the footer counts down until the oldest entry in your current window expires.',
  },
  {
    title: 'Models',
    body:  'Haiku — fastest, cheapest, great for quick tasks.\nSonnet — balanced capability and cost.\nOpus — most capable in the Opus line.\nFable — Anthropic\'s most capable released model, highest cost.\n\nThe colored bar under the 7-day chart shows which model you actually used most in the last 7 days.',
  },
  {
    title: 'Sessions',
    body:  'Each Claude Code workspace project session has a unique ID. One session = one continuous conversation context. The dashboard Top Sessions table ranks sessions by total token volume across the last 30 days.',
  },
  {
    title: 'Cost overview (approximate, USD)',
    body:  'Input:        ~$3 / 1M tokens (Sonnet)\nOutput:       ~$15 / 1M tokens\nCache Write:  ~$3.75 / 1M tokens (+25%)\nCache Read:   ~$0.30 / 1M tokens (−90%)\n\nActual pricing depends on your plan and model. These figures illustrate why a high Reuse Factor reduces costs significantly.',
  },
];

// ── Helpers ──────────────────────────────────────────────────────

function intensityColor(ratio, isToday) {
  let r, g, b;
  if (ratio <= 0) { r = 70; g = 70; b = 70; }
  else if (ratio < 0.5) {
    const t = ratio * 2;
    r = Math.round(82  + (245 - 82)  * t);
    g = Math.round(183 + (158 - 183) * t);
    b = Math.round(136 + (11  - 136) * t);
  } else {
    const t = (ratio - 0.5) * 2;
    r = Math.round(245 + (229 - 245) * t);
    g = Math.round(158 + (80  - 158) * t);
    b = Math.round(11  + (80  - 11)  * t);
  }
  return `rgba(${r},${g},${b},${isToday ? 1.0 : 0.60})`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)         return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtDuration(ms) {
  if (ms <= 0) return '0m';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function dayStart(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0); return d.getTime();
}
function daysAgoTs(n) {
  const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d.getTime();
}

function aggregate(entries) {
  const r = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, count: 0 };
  for (const e of entries) {
    r.input       += e.usage.input_tokens                || 0;
    r.output      += e.usage.output_tokens               || 0;
    r.cacheCreate += e.usage.cache_creation_input_tokens || 0;
    r.cacheRead   += e.usage.cache_read_input_tokens     || 0;
    r.count++;
  }
  return r;
}

function groupByDay(entries, nDays) {
  const result = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const from = daysAgoTs(i), to = from + 86_400_000;
    const agg  = aggregate(entries.filter(e => e.timestamp >= from && e.timestamp < to));
    result.push({
      label:   new Date(from).toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2),
      date:    new Date(from).toLocaleDateString('en-GB'),
      isToday: i === 0,
      total:   agg.input + agg.output,
      input:   agg.input,
      output:  agg.output,
    });
  }
  return result;
}

function modelFamily(name) {
  const m = (name || '').toLowerCase();
  if (m.includes('haiku'))  return 'Haiku';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('opus'))   return 'Opus';
  if (m.includes('fable'))  return 'Fable';
  return 'Other';
}

function modelDistribution(entries) {
  const counts = {}, tokens = {};
  for (const e of entries) {
    const f   = modelFamily(e.model);
    counts[f] = (counts[f] || 0) + 1;
    tokens[f] = (tokens[f] || 0) + e.usage.input_tokens + e.usage.output_tokens;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count, tokens: tokens[name] || 0, pct: total > 0 ? Math.round(count / total * 100) : 0 }))
    .sort((a, b) => b.count - a.count);
}

// ── JSONL Parsing ─────────────────────────────────────────────────
function getAllSessionFiles() {
  const files = [];
  if (!fs.existsSync(CLAUDE_DIR)) return files;
  try {
    for (const proj of fs.readdirSync(CLAUDE_DIR)) {
      const projDir = path.join(CLAUDE_DIR, proj);
      try {
        for (const entry of fs.readdirSync(projDir)) {
          if (!entry.endsWith('.jsonl')) continue;
          const full = path.join(projDir, entry);
          try { const s = fs.statSync(full); files.push({ path: full, mtime: s.mtimeMs, size: s.size }); } catch(e) {}
        }
      } catch(e) {}
    }
  } catch(e) {}
  return files.sort((a, b) => b.mtime - a.mtime);
}

function parseUsageFromFile(filePath, minTimestamp, fileSize) {
  const entries = [];
  let content = '';
  try {
    if (fileSize > 1_500_000 && minTimestamp && minTimestamp > daysAgoTs(1)) {
      const chunk = Math.min(600_000, fileSize);
      const buf = Buffer.alloc(chunk);
      const fd  = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, chunk, fileSize - chunk);
      fs.closeSync(fd);
      content = buf.toString('utf8');
      const nl = content.indexOf('\n');
      if (nl > -1) content = content.slice(nl + 1);
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant') continue;
        const msg = obj.message;
        if (!msg?.usage) continue;
        const ts = new Date(obj.timestamp).getTime();
        if (minTimestamp && ts < minTimestamp) continue;
        entries.push({
          timestamp: ts, model: msg.model || 'unknown', sessionId: obj.sessionId || '',
          usage: {
            input_tokens:                msg.usage.input_tokens                || 0,
            output_tokens:               msg.usage.output_tokens               || 0,
            cache_creation_input_tokens: msg.usage.cache_creation_input_tokens || 0,
            cache_read_input_tokens:     msg.usage.cache_read_input_tokens     || 0,
          }
        });
      } catch(e) {}
    }
  } catch(e) {}
  return entries;
}

// ── View ──────────────────────────────────────────────────────────
class AnthropicUsageView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin     = plugin;
    this.data       = null;
    this.helpVisible = false;
    this._watcher   = null;
    this._watchedFile = null;
    this._debounce  = null;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Token Usage'; }
  getIcon()        { return 'activity'; }

  async onOpen()  { await this.refresh(); this._setupWatcher(); }
  async onClose() { this._teardownWatcher(); }

  _setupWatcher() {
    this._teardownWatcher();
    const files = getAllSessionFiles();
    if (!files.length) return;
    const latest = files[0].path;
    try {
      this._watchedFile = latest;
      this._watcher = fs.watch(latest, { persistent: false }, () => {
        if (this._debounce) clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this.refresh(), 600);
      });
    } catch(e) {}
  }

  _teardownWatcher() {
    if (this._watcher)  { try { this._watcher.close(); } catch(e){} this._watcher = null; }
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
  }

  async refresh() {
    if (!this.data) this.render();
    try {
      const now     = Date.now();
      const todayTs = dayStart(new Date());
      const day7Ts  = daysAgoTs(7);
      const day30Ts = daysAgoTs(30);
      const win5hTs = now - 5 * 3_600_000;
      const files   = getAllSessionFiles();
      const curId   = files.length > 0 ? path.basename(files[0].path, '.jsonl') : null;

      let all = [];
      for (const f of files) {
        if (f.mtime < day30Ts) break;
        all = all.concat(parseUsageFromFile(f.path, day30Ts, f.size));
      }
      all.sort((a, b) => b.timestamp - a.timestamp);

      const d7       = all.filter(e => e.timestamp >= day7Ts);
      const win5h    = all.filter(e => e.timestamp >= win5hTs);
      const win5hAgg = aggregate(win5h);

      this.data = {
        lastAction: all[0] || null,
        session:    aggregate(curId ? all.filter(e => e.sessionId === curId) : []),
        today:      aggregate(all.filter(e => e.timestamp >= todayTs)),
        day7:       aggregate(d7),
        day30:      aggregate(all),
        chart7:     groupByDay(d7, 7),
        window5h: {
          agg:    win5hAgg,
          oldest: win5h.length > 0 ? Math.min(...win5h.map(e => e.timestamp)) : null,
          total:  win5hAgg.input + win5hAgg.output,
        },
        entries7:   d7,
        entries30:  all,
        updatedAt:  new Date(),
      };

      if (files.length > 0 && files[0].path !== this._watchedFile) this._setupWatcher();
    } catch(err) {
      console.error('AnthropicUsage refresh error:', err);
    }
    this.render();
  }

  render() {
    const el = this.containerEl.children[1];
    el.empty();
    el.addClass('au-container');

    // ── Header (always present)
    const hdr = el.createEl('div', { cls: 'au-header' });

    // Logo
    const logoEl = hdr.createEl('div', { cls: 'au-logo' });
    logoEl.innerHTML = LOGO_SVG + '<span class="au-logo-text">Token Usage</span>';

    // Button group
    const btnWrap = hdr.createEl('div', { cls: 'au-header-btns' });

    const dashBtn = btnWrap.createEl('button', { cls: 'au-dash-btn', text: 'Dashboard' });
    dashBtn.title   = 'Open BI dashboard in browser (HTML + charts)';
    dashBtn.onclick = () => this._generateDashboard();

    const reportBtn = btnWrap.createEl('button', { cls: 'au-report-btn', text: 'Report' });
    reportBtn.title   = 'Create Markdown report in vault and open it';
    reportBtn.onclick = () => this._generateReport();

    const refreshBtn = btnWrap.createEl('button', { cls: 'au-refresh-btn', text: '↻' });
    refreshBtn.title   = 'Refresh now';
    refreshBtn.onclick = () => this.refresh();

    const helpBtn = btnWrap.createEl('button', {
      cls:  'au-help-btn' + (this.helpVisible ? ' au-help-active' : ''),
      text: '?',
    });
    helpBtn.title   = 'Help — glossary and concept explanations';
    helpBtn.onclick = () => { this.helpVisible = !this.helpVisible; this.render(); };

    // ── Help mode: replace content with glossary
    if (this.helpVisible) {
      this._renderHelp(el);
      return;
    }

    if (!this.data) { el.createEl('div', { cls: 'au-loading', text: 'Loading...' }); return; }
    const d = this.data;

    // ── Meta
    const meta = el.createEl('div', { cls: 'au-meta' });
    meta.createEl('span', { cls: 'au-live', text: `${this._watcher ? '● Live' : '○'} ${d.updatedAt.toLocaleTimeString('en-GB')}` });

    // ── 7-day chart
    this._renderChart(el, d.chart7);

    // ── Model distribution (7 days)
    this._renderModelBar(el, d.entries7);

    // ── Last action
    if (d.lastAction) {
      const la  = d.lastAction;
      const sec = el.createEl('div', { cls: 'au-section' });
      const lhdr = sec.createEl('div', { cls: 'au-last-hdr' });
      lhdr.createEl('span', { cls: 'au-section-title', text: 'Last Action' });
      lhdr.createEl('span', { cls: 'au-model-chip', text: la.model.replace('claude-', '') });
      sec.createEl('div', {
        cls:  'au-last-tokens',
        text: `In ${fmtTokens(la.usage.input_tokens)}  ·  Out ${fmtTokens(la.usage.output_tokens)}  ·  C.Rd ${fmtTokens(la.usage.cache_read_input_tokens)}`,
      });
    }

    // ── 5h Window
    this._renderWindow5h(el);

    // ── Periods
    this._renderPeriod(el, 'This Session', d.session);
    this._renderPeriod(el, 'Today',        d.today);
    this._renderPeriod(el, '7 Days',       d.day7);
    this._renderPeriod(el, '30 Days',      d.day30);

    // ── Footer
    const footer   = el.createEl('div', { cls: 'au-footer' });
    const leftSpan = footer.createEl('span', { cls: 'au-reset-countdown' });
    if (d.window5h.oldest) {
      const msLeft = Math.max(0, d.window5h.oldest + 5 * 3_600_000 - Date.now());
      if (msLeft > 0) leftSpan.textContent = `↺ ${fmtDuration(msLeft)}`;
    }
    footer.createEl('span', { cls: 'au-version', text: `v${this.plugin.manifest.version}` });
  }

  // ── Help panel ────────────────────────────────────────────────
  _renderHelp(parent) {
    const wrap = parent.createEl('div', { cls: 'au-help' });

    const intro = wrap.createEl('div', { cls: 'au-help-intro' });
    intro.createEl('span', { cls: 'au-help-title', text: 'Glossary & Concepts' });
    intro.createEl('span', { cls: 'au-help-sub', text: 'What every value means and how they relate' });

    for (const sec of HELP_SECTIONS) {
      const s = wrap.createEl('div', { cls: 'au-help-section' });
      s.createEl('div', { cls: 'au-help-section-title', text: sec.title });
      for (const line of sec.body.split('\n')) {
        s.createEl('p', { cls: 'au-help-section-body', text: line || ' ' });
      }
    }

    const linkWrap = wrap.createEl('div', { cls: 'au-help-link-wrap' });
    const link = linkWrap.createEl('a', { cls: 'au-help-link', text: '↗ Full documentation on langeatn.de' });
    link.href = '#';
    link.onclick = (e) => {
      e.preventDefault();
      try { require('electron').shell.openExternal(HELP_URL); } catch(err) {}
    };
  }

  // ── Chart ─────────────────────────────────────────────────────
  _renderChart(parent, days) {
    const sec   = parent.createEl('div', { cls: 'au-section au-chart-section' });
    const chart = sec.createEl('div', { cls: 'au-chart' });
    const max   = Math.max(...days.map(d => d.total), 1);
    for (const day of days) {
      const ratio = max > 0 ? day.total / max : 0;
      const color = intensityColor(ratio, day.isToday);
      const col   = chart.createEl('div', { cls: 'au-chart-col' });
      const pct   = Math.max(Math.round(ratio * 100), day.total > 0 ? 4 : 0);
      const bar   = col.createEl('div', { cls: 'au-chart-bar' + (day.isToday ? ' au-bar-today' : '') });
      bar.style.height     = pct + '%';
      bar.style.background = color;
      if (day.isToday) bar.style.boxShadow = `0 0 8px ${color}`;
      bar.title = `${day.label}: ${fmtTokens(day.total)} T`;
      col.createEl('div', { cls: 'au-chart-lbl' + (day.isToday ? ' au-lbl-today' : ''), text: day.label });
    }
  }

  // ── Model bar ─────────────────────────────────────────────────
  _renderModelBar(parent, entries) {
    if (!entries || entries.length === 0) return;
    const dist = modelDistribution(entries);
    if (dist.length === 0) return;

    const sec = parent.createEl('div', { cls: 'au-section au-model-section' });
    sec.createEl('div', { cls: 'au-section-title', text: 'Models (last 7 days)' });

    const bar = sec.createEl('div', { cls: 'au-model-bar' });
    for (const m of dist) {
      if (m.pct === 0) continue;
      const seg = bar.createEl('div', { cls: 'au-model-seg' });
      seg.style.width      = `${m.pct}%`;
      seg.style.background = MODEL_COLORS[m.name] || MODEL_COLORS.Other;
      seg.title            = `${m.name}: ${m.count} calls · ${fmtTokens(m.tokens)} T · ${m.pct}%`;
    }

    const legend = sec.createEl('div', { cls: 'au-model-legend' });
    for (const m of dist) {
      if (m.count === 0) continue;
      const item = legend.createEl('span', { cls: 'au-model-legend-item' });
      const dot  = item.createEl('span', { cls: 'au-model-dot' });
      dot.style.background = MODEL_COLORS[m.name] || MODEL_COLORS.Other;
      item.createEl('span', { text: `${m.name} ${m.pct}%` });
    }
  }

  // ── 5h Window ─────────────────────────────────────────────────
  _renderWindow5h(parent) {
    const { window5h } = this.data;
    if (window5h.agg.count === 0) return;
    const sec    = parent.createEl('div', { cls: 'au-section' });
    sec.createEl('div', { cls: 'au-section-title', text: 'Last 5 hour Session' });
    const maxVal = Math.max(window5h.agg.input, window5h.agg.output, window5h.agg.cacheCreate, window5h.agg.cacheRead, 1);
    this._statRow(sec, 'Input',   window5h.agg.input,       maxVal, 'blue');
    this._statRow(sec, 'Output',  window5h.agg.output,      maxVal, 'green');
    this._statRow(sec, 'C.Write', window5h.agg.cacheCreate, maxVal, 'purple');
    this._statRow(sec, 'C.Read',  window5h.agg.cacheRead,   maxVal, 'amber');
  }

  // ── Period section ────────────────────────────────────────────
  _renderPeriod(parent, title, stats) {
    if (stats.count === 0) return;
    const sec    = parent.createEl('div', { cls: 'au-section' });
    sec.createEl('div', { cls: 'au-section-title', text: title });
    const maxVal = Math.max(stats.input, stats.output, stats.cacheCreate, stats.cacheRead, 1);
    this._statRow(sec, 'Input',   stats.input,       maxVal, 'blue');
    this._statRow(sec, 'Output',  stats.output,      maxVal, 'green');
    this._statRow(sec, 'C.Write', stats.cacheCreate, maxVal, 'purple');
    this._statRow(sec, 'C.Read',  stats.cacheRead,   maxVal, 'amber');
  }

  _statRow(parent, label, value, max, color) {
    const row = parent.createEl('div', { cls: 'au-stat-row' });
    row.createEl('span', { cls: 'au-stat-lbl', text: label });
    row.createEl('span', { cls: `au-stat-val au-text-${color}`, text: fmtTokens(value) });
    const wrap = row.createEl('div', { cls: 'au-mini-bar-wrap' });
    const bar  = wrap.createEl('div', { cls: `au-mini-bar au-bar-${color}` });
    bar.style.width = (value / max * 100).toFixed(1) + '%';
  }

  // ── Report ────────────────────────────────────────────────────
  async _generateReport() {
    if (!this.data) { new obsidian.Notice('Token Usage: No data yet.'); return; }
    const content    = this._buildReportContent();
    const reportPath = (this.plugin.settings.reportPath || 'Token Usage Report.md').trim();
    try {
      const existing = this.plugin.app.vault.getAbstractFileByPath(reportPath);
      if (existing) await this.plugin.app.vault.modify(existing, content);
      else          await this.plugin.app.vault.create(reportPath, content);
      const file = this.plugin.app.vault.getAbstractFileByPath(reportPath);
      if (file) await this.plugin.app.workspace.getLeaf(true).openFile(file);
      new obsidian.Notice('Token Usage report created.');
    } catch(e) {
      new obsidian.Notice(`Report failed: ${e.message}`);
    }
  }

  _buildReportContent() {
    const d   = this.data;
    const now = d.updatedAt;
    const ts  = now.toLocaleString('en-GB');
    const fmt = (n) => fmtTokens(n);
    const lines = [];

    lines.push('---');
    lines.push('tags: [plugin, token-usage, report]');
    lines.push(`date: ${now.toISOString().slice(0, 10)}`);
    lines.push(`updated: "${ts}"`);
    lines.push('---', '', '# Token Usage Report', '');
    lines.push(`> Created by Token Usage Plugin v${this.plugin.manifest.version} on ${ts}`, '');

    if (d.lastAction) {
      const la = d.lastAction;
      lines.push('## Last Action', '');
      lines.push('| | |', '|---|---|');
      lines.push(`| Model | \`${la.model}\` |`);
      lines.push(`| Timestamp | ${new Date(la.timestamp).toLocaleString('en-GB')} |`);
      lines.push(`| Input | ${fmt(la.usage.input_tokens)} |`);
      lines.push(`| Output | ${fmt(la.usage.output_tokens)} |`);
      lines.push(`| Cache Write | ${fmt(la.usage.cache_creation_input_tokens)} |`);
      lines.push(`| Cache Read | ${fmt(la.usage.cache_read_input_tokens)} |`, '');
    }

    const w = d.window5h;
    lines.push('## 5h Window', '');
    if (w.agg.count > 0) {
      lines.push('| | |', '|---|---|');
      lines.push(`| Input | ${fmt(w.agg.input)} |`);
      lines.push(`| Output | ${fmt(w.agg.output)} |`);
      lines.push(`| Cache Write | ${fmt(w.agg.cacheCreate)} |`);
      lines.push(`| Cache Read | ${fmt(w.agg.cacheRead)} |`);
      lines.push(`| Total (In+Out) | ${fmt(w.total)} |`);
      if (w.oldest) {
        const msLeft = Math.max(0, w.oldest + 5 * 3_600_000 - Date.now());
        lines.push(`| Window resets in | ${fmtDuration(msLeft)} |`);
      }
    } else { lines.push('No activity in the last 5 hours.'); }
    lines.push('');

    const addPeriod = (title, stats) => {
      if (stats.count === 0) return;
      lines.push(`## ${title}`, '', '| | |', '|---|---|');
      lines.push(`| Input | ${fmt(stats.input)} |`);
      lines.push(`| Output | ${fmt(stats.output)} |`);
      lines.push(`| Cache Write | ${fmt(stats.cacheCreate)} |`);
      lines.push(`| Cache Read | ${fmt(stats.cacheRead)} |`);
      lines.push(`| API Calls | ${stats.count} |`, '');
    };
    addPeriod('This Session', d.session);
    addPeriod('Today',        d.today);
    addPeriod('7 Days',       d.day7);
    addPeriod('30 Days',      d.day30);

    const dist7 = modelDistribution(d.entries7);
    if (dist7.length > 0) {
      lines.push('## Models (7 Days)', '', '| Model | Calls | % | Tokens |', '|---|---|---|---|');
      for (const m of dist7) { lines.push(`| ${m.name} | ${m.count} | ${m.pct}% | ${fmt(m.tokens)} |`); }
      lines.push('');
    }

    const tc = d.day30.cacheCreate, tr = d.day30.cacheRead;
    lines.push('## Cache Efficiency (30 Days)', '', '| | |', '|---|---|');
    lines.push(`| Cache Write | ${fmt(tc)} |`);
    lines.push(`| Cache Read | ${fmt(tr)} |`);
    lines.push(`| Reuse Factor (Read/Write) | ${tc > 0 ? (tr / tc).toFixed(1) : 0}x |`, '');

    lines.push('## 7-Day Overview', '', '| Date | Input | Output | Total |', '|---|---|---|---|');
    for (const day of d.chart7) {
      lines.push(`| ${day.date}${day.isToday ? ' (today)' : ''} | ${fmt(day.input)} | ${fmt(day.output)} | ${fmt(day.total)} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  // ── Dashboard ─────────────────────────────────────────────────
  async _generateDashboard() {
    if (!this.data) { new obsidian.Notice('Token Usage: No data yet.'); return; }
    const html     = this._buildDashboard();
    const dashPath = (this.plugin.settings.dashboardPath || 'Token Usage Dashboard.html').trim();
    try {
      const existing = this.plugin.app.vault.getAbstractFileByPath(dashPath);
      if (existing) await this.plugin.app.vault.modify(existing, html);
      else          await this.plugin.app.vault.create(dashPath, html);
      const basePath = this.plugin.app.vault.adapter.basePath;
      const absPath  = path.join(basePath, dashPath);
      const { shell } = require('electron');
      await shell.openPath(absPath);
      new obsidian.Notice('Dashboard opened in browser.');
    } catch(e) {
      new obsidian.Notice(`Dashboard failed: ${e.message}`);
    }
  }

  _buildDashboard() {
    const d       = this.data;
    const entries = d.entries30;
    const now     = d.updatedAt;

    const days30 = [];
    for (let i = 29; i >= 0; i--) {
      const from = daysAgoTs(i), to = from + 86_400_000;
      const dayE = entries.filter(e => e.timestamp >= from && e.timestamp < to);
      const byM  = { Haiku: 0, Sonnet: 0, Opus: 0, Fable: 0, Other: 0 };
      let reqs = 0, cacheCreate = 0, cacheRead = 0;
      for (const e of dayE) {
        const f = modelFamily(e.model);
        byM[f]      += e.usage.input_tokens + e.usage.output_tokens;
        cacheCreate += e.usage.cache_creation_input_tokens || 0;
        cacheRead   += e.usage.cache_read_input_tokens     || 0;
        reqs++;
      }
      days30.push({
        label: new Date(from).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
        ...byM, total: Object.values(byM).reduce((a, b) => a + b, 0),
        reqs, cacheCreate, cacheRead,
      });
    }

    const dist30           = modelDistribution(entries);
    const totalCacheCreate = entries.reduce((s, e) => s + (e.usage.cache_creation_input_tokens || 0), 0);
    const totalCacheRead   = entries.reduce((s, e) => s + (e.usage.cache_read_input_tokens     || 0), 0);
    const reuseRatio       = totalCacheCreate > 0 ? parseFloat((totalCacheRead / totalCacheCreate).toFixed(1)) : 0;

    const BKTS = [
      { label: '<1K', max: 1_000 }, { label: '1-5K', max: 5_000 },
      { label: '5-20K', max: 20_000 }, { label: '20-50K', max: 50_000 },
      { label: '50-100K', max: 100_000 }, { label: '100K+', max: Infinity },
    ];
    const hist = BKTS.map(b => ({ label: b.label, count: 0 }));
    for (const e of entries) {
      const t = e.usage.input_tokens + e.usage.output_tokens;
      const i = BKTS.findIndex(b => t < b.max);
      if (i >= 0) hist[i].count++;
    }

    const sessMap = {};
    for (const e of entries) {
      const sid = e.sessionId || 'unknown';
      if (!sessMap[sid]) sessMap[sid] = { id: sid.slice(0, 8), first: e.timestamp, tokens: 0, reqs: 0, models: {} };
      const s = sessMap[sid];
      s.tokens += e.usage.input_tokens + e.usage.output_tokens;
      s.reqs++;
      const f = modelFamily(e.model); s.models[f] = (s.models[f] || 0) + 1;
    }
    const topSess = Object.values(sessMap)
      .sort((a, b) => b.tokens - a.tokens).slice(0, 10)
      .map(s => ({
        ...s,
        start:   new Date(s.first).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
        primary: Object.entries(s.models).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other',
      }));

    const totalTok   = d.day30.input + d.day30.output;
    const avgPerReq  = d.day30.count > 0 ? Math.round(totalTok / d.day30.count) : 0;
    const activeDays = days30.filter(x => x.reqs > 0).length;

    const safeJson = JSON.stringify({
      days30, dist30, hist, sessions: topSess,
      cache: { totalCreate: totalCacheCreate, totalRead: totalCacheRead, ratio: reuseRatio },
    });

    return this._dashHtml({
      generated: now.toLocaleString('en-GB'),
      version:   this.plugin.manifest.version,
      totalTok:  fmtTokens(totalTok),
      totalReqs: d.day30.count.toLocaleString('en-GB'),
      activeDays: `${activeDays} / 30`,
      avgPerReq: fmtTokens(avgPerReq),
      safeJson,
    });
  }

  _dashHtml({ generated, version, totalTok, totalReqs, activeDays, avgPerReq, safeJson }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token Usage Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.5}
.dash{max-width:1100px;margin:0 auto;padding:28px 20px 48px}
header{margin-bottom:24px;display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.logo-header{display:flex;align-items:center;gap:8px}
header h1{font-size:22px;font-weight:700;letter-spacing:-0.02em;background:linear-gradient(120deg,#4A90D9 0%,#9B5DE5 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.meta{font-size:11px;color:#64748b;margin-top:4px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:14px 16px;transition:border-color .25s}
.cv{font-size:22px;font-weight:700;color:#f1f5f9;font-variant-numeric:tabular-nums}
.cl{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-top:4px}
.cb{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin-bottom:16px}
.cb h2{font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}
.crow{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th{font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px;text-align:left;border-bottom:1px solid #334155}
td{padding:8px 10px;font-size:12px;font-variant-numeric:tabular-nums;border-bottom:1px solid #1e293b;color:#cbd5e1}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.03)}
.badge{font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px}
.cache-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.cache-explain{padding:14px 16px;background:rgba(255,255,255,0.03);border-radius:6px;border-left:3px solid #334155;color:#cbd5e1;font-size:12px;line-height:1.7}
.cache-explain strong{color:#f1f5f9}
.cache-explain .hint{margin-top:10px;font-size:11px;color:#64748b;line-height:1.6}
@media(max-width:700px){.cards{grid-template-columns:1fr 1fr}.crow{grid-template-columns:1fr}.cache-cards{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="dash">
  <header>
    <div>
      <div class="logo-header">
        <svg width="20" height="17" viewBox="0 0 15 12" fill="none" aria-hidden="true">
          <rect x="0"    y="7" width="2.5" height="5"  rx="0.6" fill="#4A90D9" opacity="0.45"/>
          <rect x="3.5"  y="3" width="2.5" height="9"  rx="0.6" fill="#4A90D9" opacity="0.65"/>
          <rect x="7"    y="0" width="2.5" height="12" rx="0.6" fill="#4A90D9"/>
          <rect x="10.5" y="4" width="2.5" height="8"  rx="0.6" fill="#9B5DE5" opacity="0.80"/>
        </svg>
        <h1>Token Usage Dashboard</h1>
      </div>
      <div class="meta">Generated ${generated} &nbsp;·&nbsp; Plugin v${version} &nbsp;·&nbsp; Last 30 days</div>
    </div>
  </header>
  <div class="cards">
    <div class="card"><div class="cv">${totalTok}</div><div class="cl">Tokens (30 days)</div></div>
    <div class="card"><div class="cv">${totalReqs}</div><div class="cl">API calls</div></div>
    <div class="card"><div class="cv">${activeDays}</div><div class="cl">Active days</div></div>
    <div class="card"><div class="cv">${avgPerReq}</div><div class="cl">Avg tokens / call</div></div>
  </div>
  <div class="cb">
    <h2>Daily token usage — 30 days (by model)</h2>
    <canvas id="cDaily" height="110"></canvas>
  </div>
  <div class="crow">
    <div class="cb"><h2>Model distribution (calls)</h2><canvas id="cModel" height="220"></canvas></div>
    <div class="cb"><h2>Tokens per request</h2><canvas id="cDist" height="220"></canvas></div>
  </div>
  <div class="cb">
    <h2>Top sessions by token volume</h2>
    <table><thead><tr><th>Session</th><th>Start</th><th>Tokens</th><th>Calls</th><th>Model</th></tr></thead>
    <tbody id="tSess"></tbody></table>
  </div>
  <div class="cb">
    <h2>Cache efficiency &amp; usage patterns</h2>
    <div class="cache-cards">
      <div class="card"><div class="cv" id="ccCreate">—</div><div class="cl">Cache write (30d)</div></div>
      <div class="card"><div class="cv" id="ccRead">—</div><div class="cl">Cache read (30d)</div></div>
      <div class="card" id="ccRatioCard"><div class="cv" id="ccRatio">—</div><div class="cl">Reuse factor (read ÷ write)</div></div>
    </div>
    <canvas id="cCache" height="90" style="margin-bottom:14px"></canvas>
    <div class="cache-explain" id="ccExplain"></div>
  </div>
</div>
<script>
var D=${safeJson};
var C={Haiku:'#06B6D4',Sonnet:'#4A90D9',Opus:'#9B5DE5',Fable:'#E9C46A',Other:'#6B7280'};
function fN(n){if(!n)return'0';if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n);}
Chart.defaults.color='#94a3b8';Chart.defaults.borderColor='rgba(255,255,255,0.07)';
var models=['Haiku','Sonnet','Opus','Fable','Other'];
var used=models.filter(function(m){return D.days30.some(function(d){return d[m]>0;});});
new Chart(document.getElementById('cDaily'),{type:'bar',data:{labels:D.days30.map(function(d){return d.label;}),datasets:used.map(function(m){return{label:m,data:D.days30.map(function(d){return d[m]||0;}),backgroundColor:C[m],stack:'s'};})},options:{responsive:true,scales:{x:{stacked:true,grid:{color:'rgba(255,255,255,0.05)'}},y:{stacked:true,grid:{color:'rgba(255,255,255,0.05)'},ticks:{callback:function(v){return fN(v);}}}},plugins:{legend:{position:'top',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){return' '+ctx.dataset.label+': '+fN(ctx.raw);}}}}}});
var dist=D.dist30.filter(function(m){return m.count>0;});
new Chart(document.getElementById('cModel'),{type:'doughnut',data:{labels:dist.map(function(m){return m.name;}),datasets:[{data:dist.map(function(m){return m.count;}),backgroundColor:dist.map(function(m){return C[m.name]||C.Other;}),borderWidth:2,borderColor:'#0f172a'}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){var m=dist[ctx.dataIndex];return' '+m.name+': '+m.count+' calls ('+m.pct+'%)';}}}}}});
new Chart(document.getElementById('cDist'),{type:'bar',data:{labels:D.hist.map(function(h){return h.label;}),datasets:[{data:D.hist.map(function(h){return h.count;}),backgroundColor:'#4A90D9',borderRadius:3}]},options:{responsive:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return' '+ctx.raw+' requests';}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'}},y:{beginAtZero:true,grid:{color:'rgba(255,255,255,0.05)'}}}}});
var tbody=document.getElementById('tSess');
D.sessions.forEach(function(s){var tr=document.createElement('tr');var col=C[s.primary]||C.Other;tr.innerHTML='<td style="font-family:monospace;color:#64748b">'+s.id+'…</td><td>'+s.start+'</td><td style="color:#f1f5f9;font-weight:600">'+fN(s.tokens)+'</td><td>'+s.reqs+'</td><td><span class="badge" style="background:'+col+'22;color:'+col+'">'+s.primary+'</span></td>';tbody.appendChild(tr);});
(function(){var cache=D.cache;document.getElementById('ccCreate').textContent=fN(cache.totalCreate);document.getElementById('ccRead').textContent=fN(cache.totalRead);document.getElementById('ccRatio').textContent=cache.ratio+'x';var rc=document.getElementById('ccRatioCard'),r=cache.ratio;if(r>=8)rc.style.borderColor='#52B788';else if(r>=3)rc.style.borderColor='#4A90D9';else if(r>=1)rc.style.borderColor='#F59E0B';else if(r>0)rc.style.borderColor='#9B5DE5';
var h='',t='';
if(!cache.totalCreate&&!cache.totalRead){h='No cache data.';t='No cache tokens recorded in the last 30 days.';}
else if(r>=8){h='Deep focus mode.';t='You work intensely with the same context. Docs, artifacts or long chats are reused heavily — the model reads from cache instead of reprocessing. Efficient and cost-effective.';}
else if(r>=3){h='Balanced usage.';t='Focused phases alternate with fresh tasks. You bring new context regularly but also reuse existing material across multiple requests.';}
else if(r>=1){h='Exploratory mode.';t='You bring new context frequently — many different projects, short sessions, or frequent topic switches. Cache is created but rarely reused intensively.';}
else{h='Minimal cache reuse.';t='Almost every request brings fresh context. Highly exploratory or many independent short sessions without repeating the same source material.';}
var hint='Cache Write costs ~1.25× regular input — you pay a premium to store the context. Cache Read costs ~0.10× — 10× cheaper to reuse than reprocess. The Reuse Factor (Read ÷ Write) shows whether your investment in caching is paying off.';
document.getElementById('ccExplain').innerHTML='<strong>'+h+'</strong> '+t+'<div class="hint">'+hint+'</div>';
new Chart(document.getElementById('cCache'),{type:'line',data:{labels:D.days30.map(function(d){return d.label;}),datasets:[{label:'Cache Write',data:D.days30.map(function(d){return d.cacheCreate||0;}),borderColor:'#9B5DE5',backgroundColor:'rgba(155,93,229,0.08)',tension:0.35,fill:true,pointRadius:2,pointHoverRadius:4},{label:'Cache Read',data:D.days30.map(function(d){return d.cacheRead||0;}),borderColor:'#F59E0B',backgroundColor:'rgba(245,158,11,0.08)',tension:0.35,fill:true,pointRadius:2,pointHoverRadius:4}]},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'top',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){return' '+ctx.dataset.label+': '+fN(ctx.raw);}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'}},y:{beginAtZero:true,grid:{color:'rgba(255,255,255,0.05)'},ticks:{callback:function(v){return fN(v);}}}}}});
}());
<\/script>
</body>
</html>`;
  }
}

// ── Settings ──────────────────────────────────────────────────────
class AnthropicUsageSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Token Usage' });
    new obsidian.Setting(containerEl)
      .setName('Auto-refresh interval (seconds)')
      .setDesc('Fallback polling interval. The file watcher triggers immediately on every new Claude response — this is the backup.')
      .addText(t => t.setPlaceholder('30').setValue(String(this.plugin.settings.refreshSeconds))
        .onChange(async v => { const n = parseInt(v); if (!isNaN(n) && n >= 5) { this.plugin.settings.refreshSeconds = n; await this.plugin.saveSettings(); } }));
    new obsidian.Setting(containerEl)
      .setName('Report path in vault')
      .setDesc('Relative path for the Markdown report. Overwritten on every click.')
      .addText(t => t.setPlaceholder('Token Usage Report.md').setValue(this.plugin.settings.reportPath || 'Token Usage Report.md')
        .onChange(async v => { if (v.trim()) { this.plugin.settings.reportPath = v.trim(); await this.plugin.saveSettings(); } }));
    new obsidian.Setting(containerEl)
      .setName('Dashboard path in vault')
      .setDesc('Relative path for the HTML dashboard. Regenerated on every click, then opened in your default browser.')
      .addText(t => t.setPlaceholder('Token Usage Dashboard.html').setValue(this.plugin.settings.dashboardPath || 'Token Usage Dashboard.html')
        .onChange(async v => { if (v.trim()) { this.plugin.settings.dashboardPath = v.trim(); await this.plugin.saveSettings(); } }));
    containerEl.createEl('p', { cls: 'au-settings-info', text: 'Source: ' + CLAUDE_DIR + ' — no API key required.' });
  }
}

// ── Plugin ────────────────────────────────────────────────────────
class AnthropicUsagePlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, leaf => new AnthropicUsageView(leaf, this));
    this.addRibbonIcon('activity', 'Token Usage', () => this.activateView());
    this.addCommand({ id: 'open-token-usage', name: 'Open Token Usage', callback: () => this.activateView() });
    this.addCommand({
      id: 'generate-token-report', name: 'Create Token Usage report',
      callback: () => { const l = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (l?.view instanceof AnthropicUsageView) l.view._generateReport(); }
    });
    this.addCommand({
      id: 'generate-token-dashboard', name: 'Open Token Usage dashboard',
      callback: () => { const l = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (l?.view instanceof AnthropicUsageView) l.view._generateDashboard(); }
    });
    this.addSettingTab(new AnthropicUsageSettingTab(this.app, this));
    this.registerInterval(window.setInterval(
      () => this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => { if (l.view instanceof AnthropicUsageView) l.view.refresh(); }),
      (this.settings.refreshSeconds || 30) * 1000
    ));
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    workspace.revealLeaf(leaf);
  }
  async loadSettings()  { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings()  { await this.saveData(this.settings); }
}

module.exports = AnthropicUsagePlugin;
