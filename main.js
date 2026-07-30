'use strict';

var obsidian = require('obsidian');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Konfiguration ────────────────────────────────────────────────
const VIEW_TYPE  = 'token-usage-view';
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

const DEFAULT_SETTINGS = { refreshSeconds: 30 };

// ── Hilfsfunktionen ──────────────────────────────────────────────

// Grün (#52B788) → Amber (#F59E0B) → Rot (#E55050) je nach Intensität 0–1
function intensityColor(ratio, isToday) {
  let r, g, b;
  if (ratio <= 0) {
    r = 70; g = 70; b = 70; // kein Verbrauch: grau
  } else if (ratio < 0.5) {
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
  const a = isToday ? 1.0 : 0.60;
  return `rgba(${r},${g},${b},${a})`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)         return (n / 1_000).toFixed(1) + 'K';
  return String(n);
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
      label:   new Date(from).toLocaleDateString('de-DE', { weekday: 'short' }).slice(0, 2),
      isToday: i === 0,
      total:   agg.input + agg.output,
      input:   agg.input,
      output:  agg.output,
    });
  }
  return result;
}

// ── JSONL-Parsing ─────────────────────────────────────────────────
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
          try {
            const stat = fs.statSync(full);
            files.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
          } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {}
  return files.sort((a, b) => b.mtime - a.mtime);
}

function parseUsageFromFile(filePath, minTimestamp, fileSize) {
  const entries = [];
  let content = '';
  try {
    if (fileSize > 1_500_000 && minTimestamp && minTimestamp > daysAgoTs(1)) {
      const chunk = Math.min(600_000, fileSize);
      const buf   = Buffer.alloc(chunk);
      const fd    = fs.openSync(filePath, 'r');
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
      } catch (e) {}
    }
  } catch (e) {}
  return entries;
}

// ── View ──────────────────────────────────────────────────────────
class AnthropicUsageView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin; this.data = null;
    this._watcher = null; this._watchedFile = null; this._debounce = null;
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
    } catch (e) {}
  }

  _teardownWatcher() {
    if (this._watcher)  { try { this._watcher.close(); } catch(e){} this._watcher = null; }
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
  }

  async refresh() {
    if (!this.data) this.render();
    try {
      const todayTs = dayStart(new Date());
      const day7Ts  = daysAgoTs(7);
      const day30Ts = daysAgoTs(30);
      const files   = getAllSessionFiles();
      const curId   = files.length > 0 ? path.basename(files[0].path, '.jsonl') : null;

      let all = [];
      for (const f of files) {
        if (f.mtime < day30Ts) break;
        all = all.concat(parseUsageFromFile(f.path, day30Ts, f.size));
      }
      all.sort((a, b) => b.timestamp - a.timestamp);

      const d7 = all.filter(e => e.timestamp >= day7Ts);

      this.data = {
        lastAction: all[0] || null,
        session:    aggregate(curId ? all.filter(e => e.sessionId === curId) : []),
        today:      aggregate(all.filter(e => e.timestamp >= todayTs)),
        day7:       aggregate(d7),
        day30:      aggregate(all),
        chart7:     groupByDay(d7, 7),
        updatedAt:  new Date(),
      };

      if (files.length > 0 && files[0].path !== this._watchedFile) this._setupWatcher();
    } catch (err) {
      console.error('AnthropicUsage refresh error:', err);
    }
    this.render();
  }

  render() {
    const el = this.containerEl.children[1];
    el.empty();
    el.addClass('au-container');

    if (!this.data) {
      el.createEl('div', { cls: 'au-loading', text: 'Lade...' });
      return;
    }
    const d = this.data;

    // ── Header
    const hdr = el.createEl('div', { cls: 'au-header' });
    hdr.createEl('span', { cls: 'au-title', text: 'Token Usage' });
    const btn = hdr.createEl('button', { cls: 'au-refresh-btn', text: '↻' });
    btn.title = 'Aktualisieren'; btn.onclick = () => this.refresh();

    // ── Meta: Live-Status
    const meta = el.createEl('div', { cls: 'au-meta' });
    const live = this._watcher ? '● Live' : '○';
    meta.createEl('span', { cls: 'au-live', text: `${live} ${d.updatedAt.toLocaleTimeString('de-DE')}` });

    // ── Balkenchart 7 Tage
    this._renderChart(el, d.chart7);

    // ── Letzte Aktion (sehr kompakt)
    if (d.lastAction) {
      const la  = d.lastAction;
      const sec = el.createEl('div', { cls: 'au-section' });
      const lhdr = sec.createEl('div', { cls: 'au-last-hdr' });
      lhdr.createEl('span', { cls: 'au-section-title', text: 'Letzte Aktion' });
      lhdr.createEl('span', { cls: 'au-model-chip', text: la.model.replace('claude-', '') });
      sec.createEl('div', {
        cls:  'au-last-tokens',
        text: `In ${fmtTokens(la.usage.input_tokens)}  ·  Out ${fmtTokens(la.usage.output_tokens)}  ·  Cache ${fmtTokens(la.usage.cache_read_input_tokens)}`,
      });
    }

    // ── Perioden
    this._renderPeriod(el, 'Diese Session', d.session);
    this._renderPeriod(el, 'Heute',         d.today);
    this._renderPeriod(el, '7 Tage',        d.day7);
    this._renderPeriod(el, '30 Tage',       d.day30);
  }

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
      col.createEl('div', {
        cls:  'au-chart-lbl' + (day.isToday ? ' au-lbl-today' : ''),
        text: day.label,
      });
    }
  }

  _renderPeriod(parent, title, stats) {
    if (stats.count === 0) return;
    const sec = parent.createEl('div', { cls: 'au-section' });
    sec.createEl('div', { cls: 'au-section-title', text: title });

    const maxVal = Math.max(stats.input, stats.output, stats.cacheRead, 1);
    this._statRow(sec, 'Input',  stats.input,     maxVal, 'blue');
    this._statRow(sec, 'Output', stats.output,    maxVal, 'green');
    this._statRow(sec, 'Cache',  stats.cacheRead, maxVal, 'amber');
  }

  _statRow(parent, label, value, max, color) {
    const row = parent.createEl('div', { cls: 'au-stat-row' });
    row.createEl('span', { cls: 'au-stat-lbl', text: label });
    row.createEl('span', { cls: `au-stat-val au-text-${color}`, text: fmtTokens(value) });
    const wrap = row.createEl('div', { cls: 'au-mini-bar-wrap' });
    const bar  = wrap.createEl('div', { cls: `au-mini-bar au-bar-${color}` });
    bar.style.width = (value / max * 100).toFixed(1) + '%';
  }
}

// ── Settings Tab ──────────────────────────────────────────────────
class AnthropicUsageSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Token Usage' });
    new obsidian.Setting(containerEl)
      .setName('Auto-Refresh (Sekunden)')
      .setDesc('Fallback-Polling. Datei-Watcher löst zusätzlich bei jeder neuen Antwort sofort aus.')
      .addText(t => t.setPlaceholder('30').setValue(String(this.plugin.settings.refreshSeconds))
        .onChange(async v => {
          const n = parseInt(v);
          if (!isNaN(n) && n >= 5) { this.plugin.settings.refreshSeconds = n; await this.plugin.saveSettings(); }
        }));

    containerEl.createEl('p', { cls: 'au-settings-info',
      text: 'Quelle: ' + CLAUDE_DIR + ' — kein API-Key erforderlich.' });
  }
}

// ── Plugin ────────────────────────────────────────────────────────
class AnthropicUsagePlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, leaf => new AnthropicUsageView(leaf, this));
    this.addRibbonIcon('activity', 'Token Usage', () => this.activateView());
    this.addCommand({ id: 'open-token-usage', name: 'Token Usage öffnen', callback: () => this.activateView() });
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
