'use strict';

var obsidian = require('obsidian');
// Node.js `fs` is required here because Claude Code's session data lives outside
// the Obsidian vault, at ~/.claude/projects/ (JSONL files).
// The Obsidian vault API only provides access to files inside the vault, so it
// cannot be used to read these session files. This is the only reason fs is used;
// all vault reads and writes go through the Obsidian API as expected.
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Constants ────────────────────────────────────────────────────
const VIEW_TYPE  = 'token-usage-view';
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const HELP_URL   = 'https://www.langeatn.de/media/token-usage/';
const CLAUDE_SETTINGS_PATH   = path.join(os.homedir(), '.claude', 'settings.json');
const DEFAULT_RETENTION_DAYS = 30; // Anthropic's own default when cleanupPeriodDays is unset

// Claude Desktop "Agent Mode" (v1.8) — the desktop app runs Claude Code embedded and writes the
// exact same JSONL session format, but into its own isolated HOME instead of ~/.claude. Without
// this second source that usage is invisible to the plugin even though the data is right there.
// Layout below the anchor: <workspace>/<session>/local_<uuid>/.claude/projects/<cwd>/<id>.jsonl
const AGENT_MODE_DIRNAME = 'local-agent-mode-sessions';
// One-shot archive rebuild after adding the agent-mode source. Past archive files are treated as
// final (see _archiveDays), so days already archived would keep their old, too-low totals and the
// numbers would visibly drop again once such a day ages out of the live window. Bumping this tag
// re-writes every day still covered by live data, exactly once. See settings.archiveRebuildDone.
const ARCHIVE_REBUILD_TAG = '1.8.0-agentmode';

// Reads Claude Code's own retention window from ~/.claude/settings.json so the plugin's
// read depth matches what the user actually configured (v1.7). Falls back to Anthropic's
// documented default (30) if the file is missing, unreadable, or the value is invalid —
// never throws, never blocks a refresh.
function readCleanupPeriodDays() {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return DEFAULT_RETENTION_DAYS;
    const raw = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    const val = raw && raw.cleanupPeriodDays;
    if (typeof val === 'number' && Number.isInteger(val) && val >= 1) return val;
    return DEFAULT_RETENTION_DAYS;
  } catch (e) {
    return DEFAULT_RETENTION_DAYS;
  }
}

// Writes cleanupPeriodDays into ~/.claude/settings.json (v1.7 Teil 2). Touches only that one
// key — every other field in the file is read back and preserved as-is. A .bak copy of the
// previous file content is written first (only if the file already existed), so a bad write
// or an unrelated Anthropic schema change can always be undone by hand. Returns true/false,
// never throws — the caller decides how to surface failure to the user.
function writeCleanupPeriodDays(days) {
  try {
    let settings = {};
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8');
      fs.writeFileSync(CLAUDE_SETTINGS_PATH + '.bak', raw, 'utf8');
      settings = JSON.parse(raw);
    }
    settings.cleanupPeriodDays = days;
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

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
  vaultReportPath: 'Vault_Token_Usage_Projects.md',
  dashboardPath:  'Token Usage Dashboard.html',
  archivePath:    'Token Usage Archive',
  archiveEnabled: true,
  reportPeriodDays: 30,
  language:       'en',
  // UI relaunch Phase 2 — 'classic' is the default so existing users see zero change unless
  // they actively opt in. 'nextgen' adds per-row verdict glyphs to the Today section only;
  // see _renderPeriodToday()/_statRowNextGen().
  sidebarMode:    'classic',
  // Tracks the last plugin version the user has seen the "What's new" popup for.
  // null = never recorded yet. See AnthropicUsagePlugin._maybeShowWhatsNew().
  lastSeenVersion: null,
  // Which one-shot archive rebuild has already run. null = none yet.
  // Compared against ARCHIVE_REBUILD_TAG in _archiveDays().
  archiveRebuildDone: null,
  // NextGen activity calendar (v1.8) — month grid pinned to the bottom of the NextGen
  // sidebar, one colored dot per day. Default on; Classic sidebar is never affected.
  calendarVisible: true,
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
    body:  'Rolling 5-hour window matching Claude\'s rate-limit period. "Claude 5h resets in: ~Xh Ym" counts down to the next reset.\n~ = approximation: session files are written after each response completes, not at session start. May lag 10–25 min. For the precise time, check Claude Code or claude.ai.',
  },
  {
    title: 'The three time views',
    body:  'Three independent cuts through the same data — they do not nest automatically.\n\nLast 5 Hour Session — rolling window matching Claude\'s rate-limit period. Counts toward your usage limit.\n\nThis Session — all entries with the current session ID, regardless of calendar date. A Claude Code session can span multiple days. If you started a session yesterday and are still in it today, This Session will show more tokens than Today. That is expected — the session accumulates across calendar boundaries.\n\nToday — calendar day since midnight, regardless of which session the tokens came from.\n\nThe sub-label under each title shows its exact scope at a glance. Full explanation at langeatn.de/media/token-usage/',
  },
  {
    title: 'NextGen Sidebar',
    body:  'The sidebar has two layouts, switchable anytime in Settings → Sidebar appearance. Classic is the original single-page view and stays the default. NextGen switches to an icon rail with dedicated Today, Overview, and Settings pages, replaces the daily bar chart with a 7-day activity heatmap, and shows the 7-day and N-day summaries as colored KPI tiles with trend sparklines.\n\nIn NextGen, each of Today\'s four token rows also gets a compact verdict marker — a green dot when close to your own recent average, an amber arrow when running noticeably higher. The comparison window follows your Claude data retention setting, not a fixed number of days.\n\nSwitching between Classic and NextGen is fully reversible and does not affect any underlying data.',
  },
  {
    title: 'Activity calendar',
    body:  'In the NextGen sidebar a month calendar sits at the bottom of every page. Each past day carries a colored dot sized against your own recent daily average: green below average, amber around it, red for a spike (2x or more). Days with no activity have no dot. Use the arrows to move back through your history as far as the archive reaches; the calendar never goes into the future and is display only. Turn it off under Settings → Activity calendar if you prefer a shorter sidebar.',
  },
  {
    title: 'Models',
    body:  'Haiku — fastest, cheapest, great for quick tasks.\nSonnet — balanced capability and cost.\nOpus — most capable in the Opus line.\nFable — Anthropic\'s most capable released model, highest cost.\n\nThe colored bar under the 7-day chart shows which model you actually used most in the last 7 days.',
  },
  {
    title: 'Sessions',
    body:  'Each Claude Code workspace project session has a unique ID. One session = one continuous conversation context. The dashboard Top Sessions table ranks sessions by total token volume across your configured read window (30 days by default).',
  },
  {
    title: 'Vault Token Usage Controlling',
    body:  'If you use Claude Code across more than one Obsidian vault — separate vaults per client, or a personal vault alongside a work vault — the HTML dashboard\'s Projects view breaks total token usage down by vault, and by sub-project within a vault whenever your working directory changed during a session.\n\nEach vault gets its own row: total tokens, share of overall usage, active days, and first/last active day. A day-by-vault detail table shows the same breakdown per calendar day, and a standalone Vault_Token_Usage_Projects.md export (Command Palette or Settings) is built for spreadsheets — useful for splitting costs across clients or projects when billing.',
  },
  {
    title: 'Sub-project detail',
    body:  'The dashboard Projects view lists one row per vault by default. Tick "Show sub-project detail" above the table to give every vault with sub-folder activity an expander: open it to see that vault\'s per-subfolder token split inline (label, tokens, share of the vault). Sorting still applies to the vault rows; the sub-rows stay grouped under their vault. The same breakdown is also in the Vault_Token_Usage_Projects.md export.',
  },
  {
    title: 'What is measured',
    body:  'This plugin reads what Claude Code writes to disk, so it covers every way you run Claude Code: in a terminal, inside Obsidian, in an editor like VS Code, and the agent mode built into the Claude desktop app. All of it lands in the same numbers.\n\nWhat it cannot show is ordinary chat — the conversations you have in the Claude desktop app or on claude.ai. Those never write token counts to your machine; the only usage signal available there is a rounded percentage of your current limit, not the actual token counts this plugin is built on.\n\nSo if a day feels busier than the figures suggest, that is usually the reason: your chat usage counts against the same plan limit, but leaves no local trace to measure. Worth keeping in mind for the rate limit estimates in particular, which can only be derived from the portion that is visible here.',
  },
  {
    title: 'Archive & long-term data',
    body:  'Claude Code deletes its own session files automatically — 30 days by default, or whatever you set under cleanupPeriodDays in Settings. Without a copy elsewhere, anything older than that is gone for good.\n\nThe archive solves this: every day you use Claude Code, the plugin writes a small summary file to Token Usage Archive/ in your vault — aggregated totals only, never your actual conversations. Every time you open Obsidian, it checks all the days still available and fills in any day that doesn\'t have a file yet, including gaps from being closed for a while.\n\nThe honest limit: the archive can only save what still exists at the moment you open the app. If Obsidian stays closed longer than your retention period, the days in between are gone before the plugin ever gets a chance to see them — no way around that without running continuously. Increase the retention (Settings → Claude data retention) if you open Obsidian less than daily, to give the plugin a wider safety margin.',
  },
  {
    title: 'Cost overview (approximate, USD)',
    body:  'Input:        ~$3 / 1M tokens (Sonnet)\nOutput:       ~$15 / 1M tokens\nCache Write:  ~$3.75 / 1M tokens (+25%)\nCache Read:   ~$0.30 / 1M tokens (−90%)\n\nActual pricing depends on your plan and model. These figures illustrate why a high Reuse Factor reduces costs significantly.',
  },
];

// ── i18n ─────────────────────────────────────────────────────────

let _lang = 'en';

function t(key, ...args) {
  const s = STRINGS[_lang]?.[key] ?? STRINGS.en[key];
  return typeof s === 'function' ? s(...args) : (s !== undefined ? s : key);
}

const STRINGS = {
  en: {
    loading:          'Loading...',
    lastAction:       'Last Action',
    chipIn:           'In',
    chipOut:          'Out',
    chipCWr:          'C.Wr',
    chipCRd:          'C.Rd',
    startedYesterday: 'Started yesterday · spans multiple days',
    startedDate:      (d) => `Started ${d} · spans multiple days`,
    startedToday:     (t) => `Started today at ${t}`,
    thisSession:      'This Session',
    today:            'Today',
    calendarDay:      'Calendar day · since midnight',
    sevenDays:        '7 Days',
    thirtyDays:       (n) => `${n} Days`,
    resetsIn:         (d) => `Claude 5h resets in: ~${d}`,
    glossaryTitle:    'Glossary & Concepts',
    glossarySub:      'What every value means and how they relate',
    helpLink:         '↗ Full documentation on langeatn.de',
    heatmapTitle:     'Last 7 Days',
    heatLegendHigh:   'High',
    heatLegendMedium: 'Medium',
    heatLegendLow:    'Low',
    heatLegendEmpty:  'No activity',
    models:           'Models (last 7 days)',
    last5h:           'Last 5 Hour Session',
    waiting:          'Waiting for next request...',
    rollingWindow:    'Rolling window · counts toward rate limit',
    backBtn:          '← Back',
    spikeAvg:         (r) => `↑ ${r}× avg`,
    windowCleared:    'Window cleared · full 5h available',
    noData:           'Token Usage: No data yet.',
    reportCreated:    'Token Usage report created.',
    reportFailed:     'Report failed: ',
    vaultReportCreated: 'Vault Token Usage Projects report created.',
    vaultReportFailed:  'Vault report failed: ',
    dashOpened:       'Dashboard opened in browser.',
    dashFailed:       'Dashboard failed: ',
    rowInput:         'Input',
    rowOutput:        'Output',
    rowCWrite:        'C.Write',
    rowCRead:         'C.Read',
    settingLang:      'Language',
    settingLangDesc:  'Display language for the plugin UI. Takes effect immediately.',
    settingRefresh:   'Auto-refresh interval (seconds)',
    settingRefreshDesc: 'Fallback polling interval. The file watcher triggers immediately on every new Claude response — this is the backup.',
    settingReport:    'Report path in vault',
    settingReportDesc: 'Vault-relative path — the file lives inside your vault folder, right alongside your notes, and is overwritten on every click. Use the button to open its location.',
    settingVaultReport:    'Vault report path in vault',
    settingVaultReportDesc: 'Vault-relative path for the per-project/vault usage breakdown — a separate file from the main report, handy to hand to clients as a usage/billing reference. Use the button to open its location.',
    settingDash:      'Dashboard path in vault',
    settingDashDesc:  'Vault-relative path — the file lives inside your vault folder, regenerated on every click and then opened in your default browser. Use the button to open its location.',
    settingArchive:        'Archive folder in vault',
    settingArchiveDesc:    'Vault-relative folder — lives inside your vault folder for daily usage summaries, one small Markdown file per day (aggregates only, never raw session content). Lets you keep long-term trends even after Claude Code deletes the original session files. Use the button to open its location.',
    settingArchiveEnabled:     'Enable daily archive',
    settingArchiveEnabledDesc: 'Writes a daily summary file automatically. Turn off if you don\'t want the plugin creating files in your vault.',
    settingReportPeriod:     'Report period',
    settingReportPeriodDesc: 'How far back the dashboard and report look. Beyond your Claude data retention, this is filled in from the daily archive — recent days stay live, older ones come from Token Usage Archive/.',
    settingSidebarMode:      'Sidebar appearance',
    settingSidebarModeDesc: 'Classic keeps the current sidebar exactly as-is. NextGen switches to an icon rail with dedicated Today/Overview/Settings pages, a 7-day activity heatmap, and colored KPI tiles with trend sparklines — plus a compact verdict marker next to each value in Today, based on your own recent average (follows your Claude data retention setting).',
    verdictHigh:      (d) => `Higher than your ${d}-day average for this type — worth a glance.`,
    verdictNormal:    (d) => `Close to your ${d}-day average for this type.`,
    tileTotal:        'Total',
    tileCalls:        'Calls',
    tileActiveDays:   'Active days',
    tileAvgPerDay:    'Avg / active day',
    railOverview:     'Overview',
    railSettings:     'Settings',
    settingSource:    (p) => `Source: ${p} — no API key required.`,
    settingCleanup:     'Claude data retention (days)',
    settingCleanupDesc: 'Controls how long Claude Code keeps session files. Default: 30 days. For long-term controlling (cost trends, contract comparisons) recommended: 90–180 days. Writes directly to Claude Code\'s settings.json; a backup (.bak) is created automatically before each change.',
    settingPathsHeading: 'File locations',
    settingShowInFolder: 'Show in folder',
    settingShowInFolderFailed: 'Could not open the file manager for this path: ',
    cleanupSaved:  (n) => `Retention updated — Claude Code will now keep session files for ${n} days.`,
    cleanupFailed: 'Failed to update retention: ',
    archiveBackfilled: (n) => `Token Usage archived ${n} days of history.`,
    calPrev:          'Previous month',
    calNext:          'Next month',
    settingCalendar:     'Activity calendar (NextGen)',
    settingCalendarDesc: 'Shows a month calendar at the bottom of the NextGen sidebar with one colored dot per day, sized against your recent daily average (green below, amber around, red well above). The Classic sidebar is unaffected.',
    helpSections:     HELP_SECTIONS,
  },
  de: {
    loading:          'Laden...',
    lastAction:       'Letzte Aktion',
    chipIn:           'In',
    chipOut:          'Out',
    chipCWr:          'C.Wr',
    chipCRd:          'C.Rd',
    startedYesterday: 'Gestern begonnen · über mehrere Tage',
    startedDate:      (d) => `Begonnen am ${d} · über mehrere Tage`,
    startedToday:     (t) => `Heute begonnen um ${t}`,
    thisSession:      'Diese Session',
    today:            'Heute',
    calendarDay:      'Kalendertag · seit Mitternacht',
    sevenDays:        '7 Tage',
    thirtyDays:       (n) => `${n} Tage`,
    resetsIn:         (d) => `Claude 5h-Fenster wird zurückgesetzt in: ~${d}`,
    glossaryTitle:    'Glossar & Konzepte',
    glossarySub:      'Was jeder Wert bedeutet und wie sie zusammenhängen',
    helpLink:         '↗ Vollständige Dokumentation auf langeatn.de',
    heatmapTitle:     'Letzte 7 Tage',
    heatLegendHigh:   'Hoch',
    heatLegendMedium: 'Mittel',
    heatLegendLow:    'Niedrig',
    heatLegendEmpty:  'Keine Aktivität',
    models:           'Modelle (in den letzten 7 Tagen)',
    last5h:           'Letzte 5-Stunden-Session',
    waiting:          'Warte auf nächste Anfrage...',
    rollingWindow:    'Rollierendes Zeitfenster · zählt zum Rate-Limit',
    backBtn:          '← Zurück',
    spikeAvg:         (r) => `↑ ${r}× Ø`,
    noData:           'Token Usage: Noch keine Daten.',
    reportCreated:    'Token-Usage-Report erstellt.',
    reportFailed:     'Report fehlgeschlagen: ',
    vaultReportCreated: 'Vault-Token-Usage-Projects-Report erstellt.',
    vaultReportFailed:  'Vault-Report fehlgeschlagen: ',
    windowCleared:    'Fenster zurückgesetzt · volle 5h verfügbar',
    dashOpened:       'Dashboard im Browser geöffnet.',
    dashFailed:       'Dashboard fehlgeschlagen: ',
    rowInput:         'Input',
    rowOutput:        'Output',
    rowCWrite:        'C.Write',
    rowCRead:         'C.Read',
    settingLang:      'Sprache',
    settingLangDesc:  'Anzeigesprache für die Plugin-Oberfläche. Funktioniert ohne Neustart.',
    settingRefresh:   'Automatisches Aktualisierungsintervall (in Sekunden)',
    settingRefreshDesc: 'Fallback-Abfrageintervall. Der Datei-Watcher Prozess reagiert sofort auf jede neue Claude-Antwort — dies ist eine Absicherung des Prozesses. Normalerweise muss hier nichts geändert werden.',
    settingReport:    'Report-Pfad im Vault',
    settingReportDesc: 'Vault-relativer Pfad — die Datei liegt in deinem Vault-Ordner, direkt neben deinen Notizen, und wird bei jeder erneuten Ausführung überschrieben. Über den Button öffnest du den Ablageort.',
    settingVaultReport:    'Vault-Report-Pfad im Vault',
    settingVaultReportDesc: 'Vault-relativer Pfad für die Aufschlüsselung nach Projekt/Vault — eine eigene Datei getrennt vom Hauptreport, praktisch als Nutzungs-/Abrechnungsreferenz für Kunden. Über den Button öffnest du den Ablageort.',
    settingDash:      'Dashboard-Pfad im Vault',
    settingDashDesc:  'Vault-relativer Pfad — die Datei liegt in deinem Vault-Ordner, wird bei jeder Ausführung neu generiert und im Standardbrowser geöffnet. Über den Button öffnest du den Ablageort.',
    settingArchive:        'Archiv-Ordner im Vault',
    settingArchiveDesc:    'Vault-relativer Ordner — liegt in deinem Vault-Ordner, für tägliche Nutzungs-Zusammenfassungen, eine kleine Markdown-Datei pro Tag (nur Aggregate, nie Rohinhalte der Sessions). Ermöglicht Langzeit-Trends, auch nachdem Claude Code die ursprünglichen Session-Dateien gelöscht hat. Über den Button öffnest du den Ablageort.',
    settingArchiveEnabled:     'Tägliches Archiv aktivieren',
    settingArchiveEnabledDesc: 'Schreibt automatisch eine tägliche Zusammenfassungsdatei. Ausschalten, wenn das Plugin keine Dateien im Vault anlegen soll.',
    settingReportPeriod:     'Berichtszeitraum',
    settingReportPeriodDesc: 'Wie weit Dashboard und Report zurückblicken. Über die eingestellte Claude-Datenaufbewahrung hinaus wird aus dem täglichen Archiv aufgefüllt — aktuelle Tage bleiben live, ältere kommen aus Token Usage Archive/.',
    settingSidebarMode:      'Sidebar-Darstellung',
    settingSidebarModeDesc: 'Classic zeigt die Sidebar exakt wie bisher. NextGen wechselt zu einer Icon-Rail mit eigenen Today-/Overview-/Settings-Seiten, einer 7-Tage-Aktivitäts-Heatmap und farbigen KPI-Kacheln mit Trend-Sparklines — dazu eine kompakte Verdict-Markierung bei jedem Wert im Heute-Bereich, basierend auf deinem eigenen aktuellen Durchschnitt (richtet sich nach deiner eingestellten Claude-Datenaufbewahrung).',
    verdictHigh:      (d) => `Höher als dein ${d}-Tage-Durchschnitt für diesen Typ — einen Blick wert.`,
    verdictNormal:    (d) => `Nahe an deinem ${d}-Tage-Durchschnitt für diesen Typ.`,
    tileTotal:        'Gesamt',
    tileCalls:        'Aufrufe',
    tileActiveDays:   'Aktive Tage',
    tileAvgPerDay:    'Ø / aktivem Tag',
    railOverview:     'Übersicht',
    railSettings:     'Einstellungen',
    settingSource:    (p) => `Quelle: ${p} — kein API-Schlüssel erforderlich.`,
    settingCleanup:     'Claude-Datenaufbewahrung (Tage)',
    settingCleanupDesc: 'Steuert wie lange Claude Code Session-Dateien behält. Standard: 30 Tage. Für Langzeit-Controlling (Kostentrends, Vertragsvergleiche) empfohlen: 90–180 Tage. Schreibt direkt in Claude Codes settings.json; vor jeder Änderung wird automatisch ein Backup (.bak) angelegt.',
    settingPathsHeading: 'Speicherorte',
    settingShowInFolder: 'Im Explorer/Finder anzeigen',
    settingShowInFolderFailed: 'Konnte den Dateimanager für diesen Pfad nicht öffnen: ',
    cleanupSaved:  (n) => `Aufbewahrung aktualisiert — Claude Code behält Session-Dateien jetzt ${n} Tage.`,
    cleanupFailed: 'Aktualisierung fehlgeschlagen: ',
    archiveBackfilled: (n) => `Token Usage hat ${n} Tage Historie archiviert.`,
    calPrev:          'Vorheriger Monat',
    calNext:          'Nächster Monat',
    settingCalendar:     'Aktivitätskalender (NextGen)',
    settingCalendarDesc: 'Zeigt unten in der NextGen-Sidebar einen Monatskalender mit einem farbigen Punkt pro Tag, gewichtet gegen deinen jüngsten Tagesdurchschnitt (grün darunter, gelb um den Schnitt, rot deutlich darüber). Die Classic-Sidebar bleibt unberührt.',
    helpSections: [
      {
        title: 'Token',
        body:  'Die Einheit, die Claude berechnet. Jedes Wort, Satzzeichen und Leerzeichen in einer Nachricht wird in Token aufgeteilt — etwa 4 Zeichen oder ¾ eines Wortes. Sowohl deine Eingabe ALS AUCH Claudes Antwort werden dabei separat gezählt.',
      },
      {
        title: 'Input & Output',
        body:  'Input = alles was du sendest (Nachricht + Gesprächsverlauf + System-Prompt). Output = alles was Claude zurückschreibt. Output-Tokens kosten typischerweise 3–5× mehr als Input-Tokens.',
      },
      {
        title: 'C.Write — Cache Write',
        body:  'Wenn Claude einen langen Kontext zum ersten Mal verarbeitet, kann er ihn in einen Prompt-Cache speichern ("schreiben"). Cache Write kostet ~1,25× des normalen Inputs — ein einmaliger Aufpreis, der zukünftige Einsparungen ermöglicht.',
      },
      {
        title: 'C.Read — Cache Read',
        body:  'Jede Folgeanfrage, die denselben gecachten Kontext wiederverwendet, wird zu ~0,10× des Input-Preises bedient — etwa 10 x günstiger als eine erneute Verarbeitung. Ein hoher C.Read-Wert bedeutet effizientes Arbeiten mit gleichbleibendem Material.',
      },
      {
        title: 'C.Write vs. C.Read — was das Verhältnis aussagt',
        body:  'Wiederverwendungsfaktor = C.Read ÷ C.Write. Hoher Faktor → Tiefenfokus, gleicher Kontext über viele Anfragen. Niedriger Faktor → Erkundungsmodus, häufige Kontextwechsel.\n\n≥ 8×  Tiefenfokus — ausgezeichnete Cache-Rendite.\n3–8×  Ausgewogen — fokussiertes Arbeiten mit etwas Abwechslung.\n1–3×  Erkundend — häufig neuer Kontext.\n< 1×  Minimale Wiederverwendung — meist unabhängige Kurzsessions.',
      },
      {
        title: '5-Stunden-Fenster',
        body:  'Ein rollierendes 5-Stunden-Fenster passend zu Claudes Rate-Limit-Zeitraum. "Claude 5h-Fenster wird zurückgesetzt in: ~Xh Ym" zählt bis zum nächsten Reset herunter.\n~ = Näherungswert: Session-Dateien werden nach jeder abgeschlossenen Antwort geschrieben, nicht beim Start. Kann 10–25 Min. verzögert sein. Den genauen Zeitpunkt findest du in Claude Code oder auf claude.ai.',
      },
      {
        title: 'Die drei unterschiedlichen Zeitansichten in der Übersicht',
        body:  'Es gibt drei unabhängige Ausschnitte aus denselben Daten — sie sind nicht automatisch ineinander verschachtelt.\n\nDie Letzte 5-Stunden-Session — rollierendes Fenster passend zu Claudes Rate-Limit-Zeitraum. Zählt zu deinem Nutzungslimit.\n\nDiese Session — alle Einträge mit der aktuellen Session-ID, unabhängig vom Kalenderdatum. Eine Claude Code Session kann mehrere Tage umfassen. Wenn du eine Session gestern begonnen hast und heute noch darin weiterarbeitest, zeigt "Diese Session" mehr Tokens als "Heute". Das ist so gewollt und designt — die Session akkumuliert über Kalendergrenzen hinweg.\n\nHeute — Kalendertag seit Mitternacht, unabhängig davon, aus welcher Session die Token stammen.\n\nDie Beschreibung unter jedem Titel zeigt den genauen Geltungsbereich auf einen Blick. Du findest eine vollständige Erklärung auf langeatn.de/media/token-usage/',
      },
      {
        title: 'NextGen-Seitenleiste',
        body:  'Die Seitenleiste hat zwei Darstellungen, jederzeit umschaltbar unter Settings → Sidebar appearance. Classic ist die ursprüngliche Einzelseiten-Ansicht und bleibt der Standard. NextGen wechselt zu einer Icon-Leiste mit eigenen Today-, Overview- und Settings-Seiten, ersetzt das tägliche Balkendiagramm durch eine 7-Tage-Aktivitäts-Heatmap und zeigt die 7-Tage- und N-Tage-Zusammenfassungen als farbige KPI-Kacheln mit Trend-Sparklines.\n\nIn NextGen bekommt außerdem jede der vier Token-Zeilen im Heute-Bereich eine kompakte Verdict-Markierung — ein grüner Punkt, wenn der Wert nahe an deinem eigenen aktuellen Durchschnitt liegt, ein gelber Pfeil, wenn er deutlich darüber liegt. Das Vergleichsfenster richtet sich nach deiner eingestellten Claude-Datenaufbewahrung, nicht nach einer festen Anzahl Tage.\n\nDer Wechsel zwischen Classic und NextGen ist jederzeit rückgängig zu machen und beeinflusst keine zugrunde liegenden Daten.',
      },
      {
        title: 'Aktivitätskalender',
        body:  'In der NextGen-Seitenleiste sitzt unten auf jeder Seite ein Monatskalender. Jeder vergangene Tag trägt einen farbigen Punkt, gewichtet gegen deinen eigenen jüngsten Tagesdurchschnitt: grün darunter, gelb um den Schnitt herum, rot bei einem Ausschlag (2x oder mehr). Tage ohne Aktivität haben keinen Punkt. Mit den Pfeilen gehst du so weit zurück, wie das Archiv reicht; in die Zukunft geht der Kalender nie, und er ist reine Anzeige. Unter Settings → Aktivitätskalender lässt er sich abschalten, wenn du eine kürzere Seitenleiste möchtest.',
      },
      {
        title: 'Modelle',
        body:  'Haiku — schnellstes, günstigstes Modell, ideal für schnelle Aufgaben.\nSonnet — ausgewogenes Verhältnis aus Leistung und Kosten.\nOpus — leistungsstarkes Modell in der Opus-Linie.\nFable — Anthropics leistungsfähigstes veröffentlichtes Modell, höchste Kosten.\n\nDer farbige Balken unter dem 7-Tage-Diagramm zeigt, welches Modell du in den letzten 7 Tagen am häufigsten genutzt hast.',
      },
      {
        title: 'Sessions',
        body:  'Jede Claude Code Workspace-Projektsession hat eine eindeutige ID. Eine Session = ein kontinuierlicher Gesprächskontext. Die Top-Sessions-Tabelle im Dashboard ordnet Sessions nach dem Gesamt-Token-Volumen des eingestellten Lesezeitraums (standardmäßig 30 Tage).',
      },
      {
        title: 'Vault Token Usage Controlling',
        body:  'Wenn du Claude Code über mehr als ein Obsidian-Vault hinweg nutzt — getrennte Vaults pro Kunde, oder ein privates Vault neben einem Arbeits-Vault —, schlüsselt die Projects-Ansicht im HTML-Dashboard den gesamten Token-Verbrauch nach Vault auf, und innerhalb eines Vaults zusätzlich nach Unterprojekt, wann immer sich dein Arbeitsverzeichnis innerhalb einer Session geändert hat.\n\nJedes Vault bekommt eine eigene Zeile: Gesamt-Tokens, Anteil am Gesamtverbrauch, aktive Tage sowie erster und letzter aktiver Tag. Eine Tag-für-Vault-Detailtabelle zeigt dieselbe Aufschlüsselung pro Kalendertag, und ein eigenständiger Vault_Token_Usage_Projects.md-Export (Command Palette oder Settings) ist für Tabellenkalkulationen gedacht — nützlich, um Kosten bei der Abrechnung auf Kunden oder Projekte aufzuteilen.',
      },
      {
        title: 'Unterprojekt-Detail',
        body:  'Die Projects-Ansicht im Dashboard zeigt standardmäßig eine Zeile pro Vault. Setze oben über der Tabelle den Haken bei "Show sub-project detail", dann bekommt jedes Vault mit Unterordner-Aktivität ein Aufklapp-Symbol: geöffnet zeigt es die Token-Aufteilung nach Unterordner direkt in der Tabelle (Bezeichnung, Tokens, Anteil am Vault). Die Sortierung wirkt weiterhin nur auf die Vault-Zeilen; die Unterzeilen bleiben unter ihrem Vault gruppiert. Dieselbe Aufschlüsselung steht auch im Vault_Token_Usage_Projects.md-Export.',
      },
      {
        title: 'Was gemessen wird',
        body:  'Dieses Plugin liest, was Claude Code auf die Festplatte schreibt. Damit ist jede Art erfasst, wie du Claude Code nutzt: im Terminal, in Obsidian, in einem Editor wie VS Code sowie im Agent-Modus der Claude-Desktop-App. All das fließt in dieselben Zahlen ein.\n\nNicht zeigen kann es den normalen Chat — also die Gespräche in der Claude-Desktop-App oder auf claude.ai. Dort werden keine Token-Werte auf deinem Rechner gespeichert; verfügbar ist dort nur ein gerundeter Prozentwert deiner aktuellen Auslastung, nicht die tatsächlichen Token-Zahlen, auf denen dieses Plugin aufbaut.\n\nWenn ein Tag also voller wirkt als die Zahlen vermuten lassen, ist das meist der Grund: Dein Chat-Verbrauch zählt auf dasselbe Limit, hinterlässt lokal aber keine messbare Spur. Besonders bei den Rate-Limit-Schätzungen im Hinterkopf behalten, denn die lassen sich nur aus dem hier sichtbaren Teil ableiten.',
      },
      {
        title: 'Archiv & Langzeit-Daten',
        body:  'Claude Code löscht seine eigenen Session-Dateien automatisch — standardmäßig nach 30 Tagen, oder nach dem was du unter cleanupPeriodDays in den Settings eingestellt hast. Ohne eine Kopie an anderer Stelle ist alles Ältere endgültig weg.\n\nDas Archiv löst das: an jedem Tag, an dem du Claude Code nutzt, schreibt das Plugin eine kleine Zusammenfassungsdatei nach Token Usage Archive/ in deinem Vault — nur aggregierte Summen, nie deine tatsächlichen Gespräche. Jedes Mal wenn du Obsidian öffnest, prüft es alle noch verfügbaren Tage und füllt jeden Tag nach, der noch keine Datei hat — auch Lücken durch eine Zeit, in der das Plugin nicht lief.\n\nDie ehrliche Grenze: das Archiv kann nur retten, was zum Zeitpunkt des Öffnens noch existiert. Bleibt Obsidian länger geschlossen als der eingestellte Aufbewahrungszeitraum, sind die dazwischenliegenden Tage bereits weg, bevor das Plugin überhaupt eine Chance hatte hinzuschauen — daran führt ohne durchgehenden Betrieb kein Weg vorbei. Erhöhe die Aufbewahrung (Settings → Claude data retention), wenn du Obsidian seltener als täglich öffnest, um dem Plugin mehr Sicherheitsspielraum zu geben.',
      },
      {
        title: 'Kostenübersicht (ungefähr, USD)',
        body:  'Input:        ~3 $ / 1M Token (Sonnet)\nOutput:       ~15 $ / 1M Token\nCache Write:  ~3,75 $ / 1M Token (+25 %)\nCache Read:   ~0,30 $ / 1M Token (−90 %)\n\nDie tatsächlichen Preise hängen von deinem Plan und Modell ab. Diese Werte verdeutlichen, warum ein hoher Wiederverwendungsfaktor die Kosten erheblich senkt.',
      },
    ],
  },
  fr: {
    loading:          'Chargement...',
    lastAction:       'Dernière action',
    chipIn:           'In',
    chipOut:          'Out',
    chipCWr:          'C.Wr',
    chipCRd:          'C.Rd',
    startedYesterday: 'Démarrée hier · s\'étend sur plusieurs jours',
    startedDate:      (d) => `Démarrée le ${d} · s'étend sur plusieurs jours`,
    startedToday:     (time) => `Démarrée aujourd'hui à ${time}`,
    thisSession:      'Cette session',
    today:            'Aujourd\'hui',
    calendarDay:      'Jour calendaire · depuis minuit',
    sevenDays:        '7 jours',
    thirtyDays:       (n) => `${n} jours`,
    resetsIn:         (d) => `Réinitialisation des 5 h de Claude dans : ~${d}`,
    glossaryTitle:    'Glossaire et concepts',
    glossarySub:      'Ce que signifie chaque valeur et comment elles sont liées',
    helpLink:         '↗ Documentation complète sur langeatn.de',
    heatmapTitle:     '7 derniers jours',
    heatLegendHigh:   'Élevé',
    heatLegendMedium: 'Moyen',
    heatLegendLow:    'Faible',
    heatLegendEmpty:  'Aucune activité',
    models:           'Modèles (7 derniers jours)',
    last5h:           'Dernière session de 5 heures',
    waiting:          'En attente de la prochaine requête...',
    rollingWindow:    'Fenêtre glissante · prise en compte dans la limite de débit',
    backBtn:          '← Retour',
    spikeAvg:         (r) => `↑ ${r}× moy.`,
    windowCleared:    'Fenêtre réinitialisée · 5 h entièrement disponibles',
    noData:           'Token Usage : pas encore de données.',
    reportCreated:    'Rapport Token Usage créé.',
    reportFailed:     'Échec du rapport : ',
    vaultReportCreated: 'Rapport Vault Token Usage Projects créé.',
    vaultReportFailed:  'Échec du rapport vault : ',
    dashOpened:       'Tableau de bord ouvert dans le navigateur.',
    dashFailed:       'Échec du tableau de bord : ',
    rowInput:         'Input',
    rowOutput:        'Output',
    rowCWrite:        'C.Write',
    rowCRead:         'C.Read',
    settingLang:      'Langue',
    settingLangDesc:  'Langue d\'affichage de l\'interface du plugin. Prend effet immédiatement.',
    settingRefresh:   'Intervalle d\'actualisation automatique (secondes)',
    settingRefreshDesc: 'Intervalle d\'interrogation de secours. Le processus de surveillance des fichiers réagit immédiatement à chaque nouvelle réponse de Claude — il s\'agit de la solution de secours.',
    settingReport:    'Chemin du rapport dans le vault',
    settingReportDesc: 'Chemin relatif au vault — le fichier se trouve dans votre dossier de vault, juste à côté de vos notes, et est remplacé à chaque clic. Utilisez le bouton pour ouvrir son emplacement.',
    settingVaultReport:    'Chemin du rapport vault dans le vault',
    settingVaultReportDesc: 'Chemin relatif au vault pour la répartition par projet/vault — un fichier séparé du rapport principal, pratique à remettre aux clients comme référence d\'utilisation/de facturation. Utilisez le bouton pour ouvrir son emplacement.',
    settingDash:      'Chemin du tableau de bord dans le vault',
    settingDashDesc:  'Chemin relatif au vault — le fichier se trouve dans votre dossier de vault, régénéré à chaque clic puis ouvert dans votre navigateur par défaut. Utilisez le bouton pour ouvrir son emplacement.',
    settingArchive:        'Dossier d\'archive dans le vault',
    settingArchiveDesc:    'Dossier relatif au vault — se trouve dans votre dossier de vault, pour les résumés quotidiens d\'utilisation, un petit fichier Markdown par jour (agrégats uniquement, jamais le contenu brut des sessions). Permet de conserver les tendances à long terme même après la suppression des fichiers de session d\'origine par Claude Code. Utilisez le bouton pour ouvrir son emplacement.',
    settingArchiveEnabled:     'Activer l\'archive quotidienne',
    settingArchiveEnabledDesc: 'Écrit automatiquement un fichier récapitulatif quotidien. Désactivez si vous ne souhaitez pas que le plugin crée des fichiers dans votre vault.',
    settingReportPeriod:     'Période du rapport',
    settingReportPeriodDesc: 'Jusqu\'où le tableau de bord et le rapport remontent. Au-delà de votre conservation des données Claude, la période est complétée depuis l\'archive quotidienne — les jours récents restent en direct, les plus anciens proviennent de Token Usage Archive/.',
    settingSidebarMode:      'Apparence de la barre latérale',
    settingSidebarModeDesc: 'Classic conserve la barre latérale actuelle telle quelle. NextGen passe à une barre d\'icônes avec des pages Today/Overview/Settings dédiées, une carte thermique d\'activité sur 7 jours, et des tuiles KPI colorées avec sparklines — plus un repère compact à côté de chaque valeur dans Today, basé sur votre moyenne récente (suit votre réglage de conservation des données Claude).',
    verdictHigh:      (d) => `Plus élevé que votre moyenne sur ${d} jours pour ce type — à surveiller.`,
    verdictNormal:    (d) => `Proche de votre moyenne sur ${d} jours pour ce type.`,
    tileTotal:        'Total',
    tileCalls:        'Appels',
    tileActiveDays:   'Jours actifs',
    tileAvgPerDay:    'Moy. / jour actif',
    railOverview:     'Aperçu',
    railSettings:     'Paramètres',
    settingSource:    (p) => `Source : ${p} — aucune clé API requise.`,
    settingCleanup:     'Conservation des données Claude (jours)',
    settingCleanupDesc: 'Détermine combien de temps Claude Code conserve les fichiers de session. Par défaut : 30 jours. Pour un suivi à long terme (tendances de coûts, comparaisons de contrats), recommandé : 90 à 180 jours. Écrit directement dans le fichier settings.json de Claude Code ; une sauvegarde (.bak) est créée automatiquement avant chaque modification.',
    settingPathsHeading: 'Emplacements des fichiers',
    settingShowInFolder: 'Afficher dans le dossier',
    settingShowInFolderFailed: 'Impossible d\'ouvrir le gestionnaire de fichiers pour ce chemin : ',
    cleanupSaved:  (n) => `Conservation mise à jour — Claude Code conservera les fichiers de session pendant ${n} jours.`,
    cleanupFailed: 'Échec de la mise à jour : ',
    archiveBackfilled: (n) => `Token Usage a archivé ${n} jours d'historique.`,
    calPrev:          'Mois précédent',
    calNext:          'Mois suivant',
    settingCalendar:     'Calendrier d\'activité (NextGen)',
    settingCalendarDesc: 'Affiche en bas de la barre latérale NextGen un calendrier mensuel avec une pastille colorée par jour, pondérée par rapport à votre moyenne quotidienne récente (vert en dessous, ambre autour, rouge nettement au-dessus). La barre latérale Classic n\'est pas affectée.',
    helpSections: [
      {
        title: 'Jetons',
        body:  'L\'unité facturée par Claude. Chaque mot, signe de ponctuation et espace d\'un message est divisé en jetons — environ 4 caractères ou ¾ de mot chacun. Votre saisie ET la réponse de Claude sont comptées séparément.',
      },
      {
        title: 'Input & Output',
        body:  'Input = tout ce que vous envoyez (message + historique de la conversation + prompt système). Output = tout ce que Claude renvoie. Les tokens Output coûtent généralement 3 à 5× plus cher que les tokens Input.',
      },
      {
        title: 'C.Write — Cache Write',
        body:  'Lorsque Claude traite un long contexte pour la première fois, il peut le stocker (« écrire ») dans un cache de prompt. Cache Write coûte environ 1,25× le prix d\'un Input normal — un petit supplément initial qui permet des économies ultérieures.',
      },
      {
        title: 'C.Read — Cache Read',
        body:  'Toute requête de suivi qui réutilise le même contexte mis en cache est servie à environ 0,10× le prix de l\'Input — soit environ 10× moins cher qu\'un nouveau traitement. Une valeur C.Read élevée indique que vous travaillez efficacement avec le même contenu.',
      },
      {
        title: 'C.Write vs C.Read — ce que le ratio indique',
        body:  'Facteur de réutilisation = C.Read ÷ C.Write. Ratio élevé → concentration approfondie, même contexte pour de nombreuses requêtes. Ratio faible → mode exploratoire, changements constants de contexte.\n\n≥ 8×  Concentration approfondie — excellent rendement du cache.\n3–8×  Équilibré — travail ciblé avec une certaine variété.\n1–3×  Exploratoire — nouveau contexte fréquent.\n< 1×  Réutilisation minimale — principalement de courtes sessions indépendantes.',
      },
      {
        title: 'Fenêtre de 5 h',
        body:  'Fenêtre glissante de 5 heures correspondant à la période de limitation de débit de Claude. « Réinitialisation des 5 h de Claude dans : ~Xh Ym » effectue le compte à rebours jusqu\'à la prochaine réinitialisation.\n~ = approximation : les fichiers de session sont écrits après la fin de chaque réponse, et non au début de la session. Un décalage de 10 à 25 min est possible. Pour l\'heure exacte, consultez Claude Code ou claude.ai.',
      },
      {
        title: 'Les trois vues temporelles',
        body:  'Trois découpages indépendants des mêmes données — ils ne sont pas automatiquement imbriqués.\n\nDernière session de 5 heures — fenêtre glissante correspondant à la période de limitation de débit de Claude. Elle est prise en compte dans votre limite d\'utilisation.\n\nCette session — toutes les entrées portant l\'ID de la session actuelle, quelle que soit la date. Une session Claude Code peut s\'étendre sur plusieurs jours. Si vous avez commencé une session hier et la poursuivez aujourd\'hui, Cette session affichera plus de tokens qu\'Aujourd\'hui. C\'est normal — la session s\'accumule au-delà des limites calendaires.\n\nAujourd\'hui — jour calendaire depuis minuit, indépendamment de la session d\'origine des tokens.\n\nLe sous-libellé sous chaque titre indique immédiatement son périmètre exact. Explication complète sur langeatn.de/media/token-usage/',
      },
      {
        title: 'Barre latérale NextGen',
        body:  'La barre latérale propose deux apparences, modifiables à tout moment sous Réglages → Apparence de la barre latérale. Classic est la vue d\'origine sur une seule page et reste la valeur par défaut. NextGen bascule vers une barre d\'icônes avec des pages dédiées Today, Overview et Settings, remplace le graphique quotidien à barres par une carte thermique d\'activité sur 7 jours, et affiche les résumés sur 7 jours et N jours sous forme de tuiles KPI colorées avec sparklines.\n\nDans NextGen, chacune des quatre lignes de tokens d\'Aujourd\'hui reçoit également un repère compact — un point vert lorsque la valeur est proche de votre moyenne récente, une flèche ambre lorsqu\'elle est nettement plus élevée. La fenêtre de comparaison suit votre réglage de conservation des données Claude, pas un nombre de jours fixe.\n\nBasculer entre Classic et NextGen est entièrement réversible et n\'affecte aucune donnée sous-jacente.',
      },
      {
        title: 'Calendrier d\'activité',
        body:  'Dans la barre latérale NextGen, un calendrier mensuel se trouve en bas de chaque page. Chaque jour passé porte une pastille colorée, pondérée par rapport à votre propre moyenne quotidienne récente : vert en dessous, ambre autour, rouge pour un pic (2x ou plus). Les jours sans activité n\'ont pas de pastille. Les flèches permettent de remonter aussi loin que l\'archive le permet ; le calendrier ne va jamais dans le futur et sert uniquement d\'affichage. Désactivez-le sous Réglages → Calendrier d\'activité si vous préférez une barre latérale plus courte.',
      },
      {
        title: 'Modèles',
        body:  'Haiku — le plus rapide et le moins cher, idéal pour les tâches rapides.\nSonnet — équilibre entre capacités et coût.\nOpus — le plus performant de la gamme Opus.\nFable — le modèle publié le plus performant d\'Anthropic, au coût le plus élevé.\n\nLa barre colorée sous le graphique sur 7 jours indique le modèle que vous avez réellement le plus utilisé au cours des 7 derniers jours.',
      },
      {
        title: 'Sessions',
        body:  'Chaque session de projet dans un espace de travail Claude Code possède un ID unique. Une session = un contexte de conversation continu. Le tableau Top Sessions du tableau de bord classe les sessions selon le volume total de tokens sur la période de lecture configurée (30 jours par défaut).',
      },
      {
        title: 'Vault Token Usage Controlling',
        body:  'Si vous utilisez Claude Code sur plusieurs vaults Obsidian — un vault distinct par client, ou un vault personnel à côté d\'un vault professionnel —, la vue Projects du tableau de bord HTML répartit le total des tokens consommés par vault, et par sous-projet au sein d\'un vault chaque fois que votre répertoire de travail a changé pendant une session.\n\nChaque vault obtient sa propre ligne : total de tokens, part de la consommation globale, jours actifs, ainsi que premier et dernier jour d\'activité. Un tableau de détail jour par vault affiche la même répartition par jour calendaire, et un export autonome Vault_Token_Usage_Projects.md (palette de commandes ou réglages) est conçu pour les tableurs — utile pour répartir les coûts entre clients ou projets lors de la facturation.',
      },
      {
        title: 'Détail par sous-projet',
        body:  'La vue Projects du tableau de bord affiche par défaut une ligne par vault. Cochez « Show sub-project detail » au-dessus du tableau : chaque vault ayant de l\'activité dans des sous-dossiers reçoit alors une flèche de dépliage qui montre, directement dans le tableau, la répartition des tokens par sous-dossier (libellé, tokens, part du vault). Le tri continue de s\'appliquer aux lignes de vault ; les sous-lignes restent regroupées sous leur vault. La même répartition figure aussi dans l\'export Vault_Token_Usage_Projects.md.',
      },
      {
        title: 'Ce qui est mesuré',
        body:  'Ce plugin lit ce que Claude Code écrit sur le disque. Toutes les façons d\'utiliser Claude Code sont donc couvertes : dans un terminal, dans Obsidian, dans un éditeur comme VS Code, ainsi que le mode agent intégré à l\'application de bureau Claude. Tout cela alimente les mêmes chiffres.\n\nCe qu\'il ne peut pas montrer, c\'est le chat classique — les conversations menées dans l\'application de bureau ou sur claude.ai. Aucun décompte de tokens n\'y est enregistré sur votre machine ; le seul indicateur disponible est un pourcentage arrondi de votre limite actuelle, et non les valeurs réelles sur lesquelles repose ce plugin.\n\nSi une journée vous semble donc plus chargée que ne le suggèrent les chiffres, c\'est généralement l\'explication : votre usage du chat compte dans la même limite, mais ne laisse aucune trace mesurable en local. À garder à l\'esprit surtout pour les estimations de limites, qui ne peuvent être déduites que de la partie visible ici.',
      },
      {
        title: 'Archive et données à long terme',
        body:  'Claude Code supprime automatiquement ses propres fichiers de session — 30 jours par défaut, ou selon la valeur définie sous cleanupPeriodDays dans les paramètres. Sans copie ailleurs, tout ce qui est plus ancien disparaît définitivement.\n\nL\'archive résout ce problème : chaque jour où vous utilisez Claude Code, le plugin écrit un petit fichier récapitulatif dans Token Usage Archive/ de votre vault — uniquement des totaux agrégés, jamais vos conversations réelles. Chaque fois que vous ouvrez Obsidian, il vérifie tous les jours encore disponibles et complète tout jour qui n\'a pas encore de fichier, y compris les écarts dus à une période où le plugin n\'était pas actif.\n\nLa limite honnête : l\'archive ne peut sauvegarder que ce qui existe encore au moment où vous ouvrez l\'application. Si Obsidian reste fermé plus longtemps que votre période de conservation, les jours intermédiaires disparaissent avant même que le plugin ait eu la chance de les voir — impossible d\'y remédier sans une exécution continue. Augmentez la conservation (Paramètres → Claude data retention) si vous ouvrez Obsidian moins d\'une fois par jour, pour donner au plugin une marge de sécurité plus large.',
      },
      {
        title: 'Aperçu des coûts (approximatif, USD)',
        body:  'Input:        ~3 $ / 1 M de tokens (Sonnet)\nOutput:       ~15 $ / 1 M de tokens\nCache Write:  ~3,75 $ / 1 M de tokens (+25 %)\nCache Read:   ~0,30 $ / 1 M de tokens (−90 %)\n\nLe tarif réel dépend de votre forfait et du modèle. Ces chiffres illustrent pourquoi un facteur de réutilisation élevé réduit considérablement les coûts.',
      },
    ],
  },
  it: {
    loading:          'Caricamento...',
    lastAction:       'Ultima azione',
    chipIn:           'In',
    chipOut:          'Out',
    chipCWr:          'C.Wr',
    chipCRd:          'C.Rd',
    startedYesterday: 'Avviata ieri · si estende su più giorni',
    startedDate:      (d) => `Avviata il ${d} · si estende su più giorni`,
    startedToday:     (time) => `Avviata oggi alle ${time}`,
    thisSession:      'Questa sessione',
    today:            'Oggi',
    calendarDay:      'Giorno di calendario · da mezzanotte',
    sevenDays:        '7 giorni',
    thirtyDays:       (n) => `${n} giorni`,
    resetsIn:         (d) => `Le 5 ore di Claude si azzerano tra: ~${d}`,
    glossaryTitle:    'Glossario e concetti',
    glossarySub:      'Cosa significa ogni valore e come essi sono collegati',
    helpLink:         '↗ Documentazione completa su langeatn.de',
    heatmapTitle:     'Ultimi 7 giorni',
    heatLegendHigh:   'Alto',
    heatLegendMedium: 'Medio',
    heatLegendLow:    'Basso',
    heatLegendEmpty:  'Nessuna attività',
    models:           'Modelli (ultimi 7 giorni)',
    last5h:           'Ultima sessione di 5 ore',
    waiting:          'In attesa della prossima richiesta...',
    rollingWindow:    'Finestra mobile · conteggiata nel limite di utilizzo',
    backBtn:          '← Indietro',
    spikeAvg:         (r) => `↑ ${r}× media`,
    windowCleared:    'Finestra azzerata · 5 ore completamente disponibili',
    noData:           'Token Usage: nessun dato disponibile sull\'utilizzo.',
    reportCreated:    'Report sull\'utilizzo del token creato.',
    reportFailed:     'Creazione del report non riuscita: ',
    vaultReportCreated: 'Report Vault Token Usage Projects creato.',
    vaultReportFailed:  'Creazione del report vault non riuscita: ',
    dashOpened:       'Dashboard aperta nel browser.',
    dashFailed:       'Apertura della dashboard non riuscita: ',
    rowInput:         'Input',
    rowOutput:        'Output',
    rowCWrite:        'C.Write',
    rowCRead:         'C.Read',
    settingLang:      'Lingua',
    settingLangDesc:  'Lingua di visualizzazione per l\'interfaccia del plugin. Ha effetto immediato.',
    settingRefresh:   'Intervallo di aggiornamento automatico (secondi)',
    settingRefreshDesc: 'Intervallo di polling di riserva. Il processo di monitoraggio dei file reagisce immediatamente a ogni nuova risposta di Claude — questa è la soluzione di riserva.',
    settingReport:    'Percorso del report nel vault',
    settingReportDesc: 'Percorso relativo al vault — il file si trova nella cartella del tuo vault, accanto alle tue note, e viene sovrascritto a ogni clic. Usa il pulsante per aprirne la posizione.',
    settingVaultReport:    'Percorso del report vault nel vault',
    settingVaultReportDesc: 'Percorso relativo al vault per la ripartizione per progetto/vault — un file separato dal report principale, utile da consegnare ai clienti come riferimento di utilizzo/fatturazione. Usa il pulsante per aprirne la posizione.',
    settingDash:      'Percorso della dashboard nel vault',
    settingDashDesc:  'Percorso relativo al vault — il file si trova nella cartella del tuo vault, rigenerato a ogni clic e quindi aperto nel browser predefinito. Usa il pulsante per aprirne la posizione.',
    settingArchive:        'Cartella archivio nel vault',
    settingArchiveDesc:    'Cartella relativa al vault — si trova nella cartella del tuo vault, per i riepiloghi giornalieri di utilizzo, un piccolo file Markdown al giorno (solo aggregati, mai il contenuto grezzo delle sessioni). Consente di mantenere le tendenze a lungo termine anche dopo che Claude Code elimina i file di sessione originali. Usa il pulsante per aprirne la posizione.',
    settingArchiveEnabled:     'Abilita archivio giornaliero',
    settingArchiveEnabledDesc: 'Scrive automaticamente un file di riepilogo giornaliero. Disattiva se non vuoi che il plugin crei file nel tuo vault.',
    settingReportPeriod:     'Periodo del report',
    settingReportPeriodDesc: 'Fino a quando indietro guardano dashboard e report. Oltre la conservazione dei dati Claude impostata, il periodo viene completato dall\'archivio giornaliero — i giorni recenti restano live, quelli più vecchi provengono da Token Usage Archive/.',
    settingSidebarMode:      'Aspetto della barra laterale',
    settingSidebarModeDesc: 'Classic mantiene la barra laterale attuale invariata. NextGen passa a una barra di icone con pagine dedicate Today/Overview/Settings, una mappa di calore dell\'attività su 7 giorni e riquadri KPI colorati con sparkline — più un indicatore compatto accanto a ogni valore in Today, basato sulla tua media recente (segue la tua impostazione di conservazione dei dati Claude).',
    verdictHigh:      (d) => `Più alto della tua media di ${d} giorni per questo tipo — vale la pena controllare.`,
    verdictNormal:    (d) => `Vicino alla tua media di ${d} giorni per questo tipo.`,
    tileTotal:        'Totale',
    tileCalls:        'Chiamate',
    tileActiveDays:   'Giorni attivi',
    tileAvgPerDay:    'Media / giorno attivo',
    railOverview:     'Panoramica',
    railSettings:     'Impostazioni',
    settingSource:    (p) => `Fonte: ${p} — nessuna chiave API richiesta.`,
    settingCleanup:     'Conservazione dei dati Claude (giorni)',
    settingCleanupDesc: 'Determina per quanto tempo Claude Code conserva i file di sessione. Predefinito: 30 giorni. Per il controllo a lungo termine (andamento dei costi, confronto dei piani) consigliato: 90–180 giorni. Scrive direttamente nel file settings.json di Claude Code; prima di ogni modifica viene creato automaticamente un backup (.bak).',
    settingPathsHeading: 'Percorsi dei file',
    settingShowInFolder: 'Mostra nella cartella',
    settingShowInFolderFailed: 'Impossibile aprire il gestore file per questo percorso: ',
    cleanupSaved:  (n) => `Conservazione aggiornata — Claude Code conserverà i file di sessione per ${n} giorni.`,
    cleanupFailed: 'Aggiornamento non riuscito: ',
    archiveBackfilled: (n) => `Token Usage ha archiviato ${n} giorni di cronologia.`,
    calPrev:          'Mese precedente',
    calNext:          'Mese successivo',
    settingCalendar:     'Calendario attività (NextGen)',
    settingCalendarDesc: 'Mostra in fondo alla barra laterale NextGen un calendario mensile con un punto colorato per giorno, ponderato rispetto alla tua media giornaliera recente (verde sotto, ambra intorno, rosso ben sopra). La barra laterale Classic non è interessata.',
    helpSections: [
      {
        title: 'Token',
        body:  'L\'unità fatturata da Claude. Ogni parola, segno di punteggiatura e spazio in un messaggio viene suddiviso in token — circa 4 caratteri o ¾ di parola ciascuno. Sia il tuo input SIA la risposta di Claude vengono conteggiati separatamente.',
      },
      {
        title: 'Input & Output',
        body:  'Input = tutto ciò che invii (messaggio + cronologia della conversazione + prompt di sistema). Output = tutto ciò che Claude restituisce. I token Output costano in genere dalle 3 alle 5 volte i token input.',
      },
      {
        title: 'C.Write — Cache Write',
        body:  'Quando Claude elabora per la prima volta un contesto lungo, può memorizzarlo («scriverlo») in una cache del prompt. Cache Write costa 1,25 volte dell\'input normale — un piccolo sovrapprezzo iniziale che consente risparmi futuri.',
      },
      {
        title: 'C.Read — Cache Read',
        body:  'Ogni richiesta successiva che riutilizza lo stesso contesto memorizzato nella cache viene gestita a circa 0,10 volte il prezzo dell\'input — approssimativamente 10 volte meno rispetto a una nuova elaborazione. Un valore C.Read elevato indica che stai lavorando in modo efficiente con lo stesso materiale.',
      },
      {
        title: 'C.Write vs C.Read — cosa indica il rapporto',
        body:  'Fattore di riutilizzo = C.Read ÷ C.Write. Rapporto elevato → concentrazione profonda, stesso contesto per molte richieste. Rapporto basso → modalità esplorativa, continui cambi di contesto.\n\n≥ 8×  Concentrazione profonda — rendimento eccellente della cache.\n3–8×  Bilanciato — lavoro mirato con una certa varietà.\n1–3×  Esplorativo — nuovo contesto frequente.\n< 1×  Riutilizzo minimo — perlopiù brevi sessioni indipendenti.',
      },
      {
        title: 'Finestra di 5 ore',
        body:  'La finestra mobile di utilizzo di Claude è di 5 ore. «Al prossimo reset mancano: ~Xh Ym» mostra il conto alla rovescia fino al prossimo azzeramento.\n~ = approssimazione: i file di sessione vengono scritti dopo il completamento di ogni risposta, non all\'avvio della sessione. Può esserci un ritardo di 10–25 minuti. Per l\'orario preciso, controlla Claude Code o claude.ai.',
      },
      {
        title: 'Le tre viste temporali',
        body:  'Tre viste indipendenti sugli stessi dati — non sono automaticamente annidate.\n\nUltima sessione di 5 ore — finestra mobile corrispondente al periodo del limite di utilizzo di Claude. Conta ai fini del limite di utilizzo.\n\nQuesta sessione — tutte le voci con l\'ID della sessione corrente, indipendentemente dalla data di calendario. Una sessione di Claude Code può durare più giorni. Se hai iniziato una sessione ieri e la stai ancora usando oggi, Questa sessione mostrerà più token di Oggi. È previsto — la sessione si accumula oltre i confini del calendario.\n\nOggi — giorno di calendario da mezzanotte, indipendentemente dalla sessione da cui provengono i token.\n\nIl sottotitolo sotto ogni titolo mostra subito l\'ambito esatto. Spiegazione completa su langeatn.de/media/token-usage/',
      },
      {
        title: 'Barra laterale NextGen',
        body:  'La barra laterale ha due aspetti, cambiabili in qualsiasi momento in Impostazioni → Aspetto della barra laterale. Classic è la vista originale a pagina singola e resta l\'impostazione predefinita. NextGen passa a una barra di icone con pagine dedicate Today, Overview e Settings, sostituisce il grafico a barre giornaliero con una mappa di calore dell\'attività su 7 giorni e mostra i riepiloghi su 7 giorni e N giorni come riquadri KPI colorati con sparkline.\n\nIn NextGen, ciascuna delle quattro righe di token in Oggi riceve anche un indicatore compatto — un punto verde quando il valore è vicino alla tua media recente, una freccia ambra quando è nettamente più alto. La finestra di confronto segue la tua impostazione di conservazione dei dati Claude, non un numero fisso di giorni.\n\nIl passaggio tra Classic e NextGen è completamente reversibile e non influisce sui dati sottostanti.',
      },
      {
        title: 'Calendario attività',
        body:  'Nella barra laterale NextGen, in fondo a ogni pagina si trova un calendario mensile. Ogni giorno passato ha un punto colorato, ponderato rispetto alla tua media giornaliera recente: verde sotto la media, ambra intorno ad essa, rosso per un picco (2x o più). I giorni senza attività non hanno punto. Con le frecce puoi tornare indietro fin dove arriva l\'archivio; il calendario non va mai nel futuro ed è solo di visualizzazione. Disattivalo in Impostazioni → Calendario attività se preferisci una barra laterale più corta.',
      },
      {
        title: 'Modelli',
        body:  'Haiku — il più veloce e conveniente, ideale per attività rapide.\nSonnet — equilibrio tra capacità e costo.\nOpus — il più capace della linea Opus.\nFable — il modello pubblicato più capace di Anthropic, con il costo più elevato.\n\nLa barra colorata sotto il grafico dei 7 giorni mostra quale modello hai effettivamente utilizzato di più negli ultimi 7 giorni.',
      },
      {
        title: 'Sessioni',
        body:  'Ogni sessione di progetto in uno spazio di lavoro Claude Code ha un ID univoco. Una sessione = un contesto di conversazione continuo. La tabella Top Sessions della dashboard ordina le sessioni in base al volume totale di token nel periodo di lettura configurato (30 giorni per impostazione predefinita).',
      },
      {
        title: 'Vault Token Usage Controlling',
        body:  'Se utilizzi Claude Code su più vault Obsidian — vault separati per cliente, oppure un vault personale accanto a uno di lavoro — la vista Projects della dashboard HTML suddivide il consumo totale di token per vault, e per sottoprogetto all\'interno di un vault ogni volta che la directory di lavoro è cambiata durante una sessione.\n\nOgni vault ottiene una propria riga: token totali, quota sul consumo complessivo, giorni attivi e primo/ultimo giorno di attività. Una tabella di dettaglio giorno per vault mostra la stessa suddivisione per giorno di calendario, e un export autonomo Vault_Token_Usage_Projects.md (Command Palette o Impostazioni) è pensato per i fogli di calcolo — utile per ripartire i costi tra clienti o progetti in fase di fatturazione.',
      },
      {
        title: 'Dettaglio sottoprogetti',
        body:  'La vista Projects della dashboard mostra per impostazione predefinita una riga per vault. Spunta "Show sub-project detail" sopra la tabella: ogni vault con attività in sottocartelle riceve una freccia di espansione che mostra, direttamente nella tabella, la suddivisione dei token per sottocartella (etichetta, token, quota sul vault). L\'ordinamento continua ad applicarsi alle righe di vault; le sottorighe restano raggruppate sotto il loro vault. La stessa suddivisione è disponibile anche nell\'export Vault_Token_Usage_Projects.md.',
      },
      {
        title: 'Cosa viene misurato',
        body:  'Questo plugin legge ciò che Claude Code scrive su disco. Sono quindi coperti tutti i modi in cui usi Claude Code: nel terminale, in Obsidian, in un editor come VS Code e nella modalità agente integrata nell\'app desktop di Claude. Tutto confluisce negli stessi numeri.\n\nCiò che non può mostrare è la chat normale — le conversazioni nell\'app desktop o su claude.ai. Lì nessun conteggio di token viene salvato sul tuo computer; l\'unico segnale disponibile è una percentuale arrotondata del limite attuale, non i valori reali su cui si basa questo plugin.\n\nQuindi, se una giornata sembra più intensa di quanto suggeriscano i numeri, di solito il motivo è questo: il consumo in chat incide sullo stesso limite, ma non lascia alcuna traccia misurabile in locale. Da tenere presente soprattutto per le stime dei limiti, che possono essere ricavate solo dalla parte qui visibile.',
      },
      {
        title: 'Archivio e dati a lungo termine',
        body:  'Claude Code elimina automaticamente i propri file di sessione — 30 giorni per impostazione predefinita, oppure il valore impostato in cleanupPeriodDays nelle impostazioni. Senza una copia altrove, tutto ciò che è più vecchio scompare definitivamente.\n\nL\'archivio risolve questo problema: ogni giorno in cui usi Claude Code, il plugin scrive un piccolo file di riepilogo in Token Usage Archive/ nel tuo vault — solo totali aggregati, mai le tue conversazioni reali. Ogni volta che apri Obsidian, controlla tutti i giorni ancora disponibili e completa qualsiasi giorno privo di file, comprese le lacune dovute a un periodo in cui il plugin non era attivo.\n\nIl limite onesto: l\'archivio può salvare solo ciò che esiste ancora al momento dell\'apertura dell\'app. Se Obsidian resta chiuso più a lungo del periodo di conservazione impostato, i giorni intermedi scompaiono prima ancora che il plugin abbia la possibilità di vederli — non c\'è modo di aggirare questo limite senza un\'esecuzione continua. Aumenta la conservazione (Impostazioni → Claude data retention) se apri Obsidian meno di una volta al giorno, per dare al plugin un margine di sicurezza più ampio.',
      },
      {
        title: 'Panoramica dei costi (approssimativa, USD)',
        body:  'Input:        ~3 $ / 1 M di token (Sonnet)\nOutput:       ~15 $ / 1 M di token\nCache Write:  ~3,75 $ / 1 M di token (+25%)\nCache Read:   ~0,30 $ / 1 M di token (−90%)\n\nIl prezzo effettivo dipende dal tuo piano e dal modello. Questi valori mostrano perché un fattore di riutilizzo elevato riduce significativamente i costi.',
      },
    ],
  },
};

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

// Fixed 4-band heatmap coloring (Empty/Low/Medium/High) — deliberately NOT intensityColor()'s
// continuous gradient; flat categorical banding matching the 4-swatch legend (Nachschärfungsliste
// Punkt 5, 01.09.2026; palette revised 01.09.2026 — Björn: purple/blue collided visually with the
// Sonnet/Opus model colors used elsewhere in the sidebar, e.g. the "Models (last 7 days)" bar).
// Gray/green/amber/red instead — reuses the existing --au-* palette, doubles as a genuine
// traffic-light "cold to hot" read, and gives "no activity" its own real color instead of the
// previous opacity-only trick (empty and low used to share --au-gray, distinguished only by
// dimming).
function heatBandColor(ratio) {
  if (ratio <= 0)    return { css: 'var(--au-gray)',  band: 'empty'  };
  if (ratio >= 0.66) return { css: 'var(--au-red)',   band: 'high'   };
  if (ratio >= 0.33) return { css: 'var(--au-amber)', band: 'medium' };
  return                { css: 'var(--au-green)', band: 'low'    };
}

// Overview tiles — KPI-card style (Björn, 01.09.2026, Nachschärfungsliste Punkt 6, scoped down to
// Overview tiles only). Deliberate Node-side port of the Dashboard's sparklineSvg() (browser-only,
// embedded in the giant _dashHtml() template literal, unreachable from the Sidebar's Obsidian-DOM
// render path) — not shared with it, same "deliberate copy" pattern as _statRow/_statRowNextGen.
// Applied via el.innerHTML = svgString, same pattern LOGO_SVG already uses in the sidebar header.
function sparklineSvgNG(values, color, w, h) {
  w = w || 48; h = h || 16;
  if (!values || values.length < 2) return '';
  const max = Math.max(...values), min = Math.min(...values);
  const range = (max - min) || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// Bar-histogram variant, used only for the "Active Days" tile (Björn: bars, not a line, there).
function sparkBarsSvg(values, color, w, h) {
  w = w || 48; h = h || 16;
  if (!values || values.length === 0) return '';
  const max = Math.max(...values, 1);
  const bw = w / values.length;
  const bars = values.map((v, i) => {
    const bh = Math.max(1, (v / max) * h);
    const x = i * bw;
    return `<rect x="${(x + bw * 0.15).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${bh.toFixed(1)}" rx="0.5" fill="${color}"/>`;
  }).join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bars}</svg>`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + ' B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2) + ' M';
  if (n >= 1_000)         return (n / 1_000).toFixed(1) + ' K';
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
// Maps the plugin's 2-letter UI language to a BCP-47 locale for Intl date formatting
// (month names, weekday headers in the NextGen calendar). Everything else in the plugin
// still formats with a fixed 'en-GB' on purpose — only the calendar is user-language-aware.
function localeFor(lang) {
  return { en: 'en-GB', de: 'de-DE', fr: 'fr-FR', it: 'it-IT' }[lang] || 'en-GB';
}

// Billing week starts Sunday 18:00 CEST = 16:00 UTC. Module-level (Phase 0 of the UI relaunch —
// previously a closure inside _buildDashboard()) because both the rate-limit analysis and the
// new Week Status Bar need it.
function billingWeekStart(tsMs) {
  const dt = new Date(tsMs);
  let dow  = dt.getUTCDay(); // 0=Sun
  const h  = dt.getUTCHours();
  let dBack = dow;
  if (dow === 0 && h < 16) dBack = 7;
  const s = new Date(dt);
  s.setUTCDate(dt.getUTCDate() - dBack);
  s.setUTCHours(16, 0, 0, 0);
  return s.getTime();
}

// Pure threshold lookup — returns only a semantic key, never a color or CSS class, so the same
// banding logic can back both the sidebar (NextGen, later phase) and the dashboard without the
// two ever drifting into different thresholds for the same concept. `bands` is ascending:
// [{upTo, key}, ...] — first band where value <= upTo wins.
function bandedVerdict(value, bands) {
  for (const b of bands) { if (value <= b.upTo) return b.key; }
  return bands.length ? bands[bands.length - 1].key : 'neutral';
}

// Focus Score (0-100) — how much a usage pattern looks like sustained deep work vs. scattered
// context-switching, from data the plugin already computes. Three weighted components:
//   cache (0.5)      — reuse-factor bands, identical thresholds to the Reuse Factor glossary entry
//   continuity (0.3) — sessions per active day (fewer, longer sessions score higher)
//   depth (0.2)      — average requests per session (more turns per session scores higher)
function computeFocusScore(sessMap, reuseRatio, activeDays, totalReqs) {
  const sessionCount = Object.keys(sessMap || {}).length;
  const cache = reuseRatio >= 8 ? 80 + Math.min(20, (reuseRatio - 8) / 12 * 20)
    : reuseRatio >= 3 ? 50 + (reuseRatio - 3) / 5 * 30
    : reuseRatio >= 1 ? 25 + (reuseRatio - 1) / 2 * 25
    : reuseRatio > 0  ? reuseRatio * 25 : 0;
  const sessionsPerDay    = sessionCount / Math.max(activeDays, 1);
  const continuity        = Math.max(0, Math.min(100, 100 - (sessionsPerDay - 1) * 25));
  const avgReqsPerSession = totalReqs / Math.max(sessionCount, 1);
  const depth              = Math.max(0, Math.min(100, (avgReqsPerSession / 20) * 100));
  const score = Math.round(0.5 * cache + 0.3 * continuity + 0.2 * depth);
  const badge = score >= 80 ? 'Deep Work Mode' : score >= 60 ? 'Focused' : score >= 40 ? 'Balanced' : 'Scattered';
  const color = score >= 80 ? '#52B788' : score >= 60 ? '#4A90D9' : score >= 40 ? '#F59E0B' : '#6B7280';
  return {
    score, badge, color,
    components: { cache: Math.round(cache), continuity: Math.round(continuity), depth: Math.round(depth) },
  };
}

// Week Status (Phase 1) — where the current billing week stands: token totals per day so far, a
// 3-day rolling-average forecast to Sunday 18:00, and an on-track verdict against the empirical
// weekly-limit estimate (same source as the Rate Limits section — Anthropic publishes no
// official number, so this is always an estimate, never a hard fact).
function computeWeekStatus(entries30sorted, now, weeklyLimitEst, avgDailyFallback) {
  const wkStart = billingWeekStart(now.getTime());
  const nowMs   = now.getTime();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const from = wkStart + i * 86_400_000;
    const to   = from + 86_400_000;
    const tokens = entries30sorted
      .filter(e => e.timestamp >= from && e.timestamp < to)
      .reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
    const status = to <= nowMs ? 'past' : (from <= nowMs && nowMs < to ? 'current' : 'future');
    days.push({ tokens, status });
  }
  const soFar          = days.reduce((s, x) => s + x.tokens, 0);
  const recentWithData = days.filter(x => x.status !== 'future');
  const last3           = recentWithData.slice(-3);
  const dailyAvg = last3.length > 0
    ? last3.reduce((s, x) => s + x.tokens, 0) / last3.length
    : (avgDailyFallback || 0);
  const remainingDays = days.filter(x => x.status === 'future').length;
  const forecast       = soFar + dailyAvg * remainingDays;
  const pct = weeklyLimitEst ? (forecast / weeklyLimitEst) * 100 : null;
  const verdict = pct === null ? 'neutral' : bandedVerdict(pct, [
    { upTo: 80,       key: 'good' },
    { upTo: 100,      key: 'warn' },
    { upTo: Infinity, key: 'bad'  },
  ]);
  const daysUntilExhausted = (weeklyLimitEst && dailyAvg > 0)
    ? Math.max(0, (weeklyLimitEst - soFar) / dailyAvg)
    : null;
  return {
    days, soFar, dailyAvg: Math.round(dailyAvg), remainingDays,
    forecast: Math.round(forecast), pct: pct !== null ? Math.round(pct) : null,
    verdict, weeklyLimitEst, daysUntilExhausted,
  };
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

// 7 days × N×blockHours-blocks bucketing for the NextGen heatmap (Nachschärfungsliste Punkt 5,
// 01.09.2026) — same iteration shape as groupByDay(), just with a nested `blocks` array per day.
function groupByBlocks(entries, nDays, blockHours) {
  const blocksPerDay = 24 / blockHours;
  const blockMs       = blockHours * 3_600_000;
  const result = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const dayFrom = daysAgoTs(i);
    const blocks  = [];
    for (let b = 0; b < blocksPerDay; b++) {
      const from = dayFrom + b * blockMs;
      const to   = from + blockMs;
      const agg  = aggregate(entries.filter(e => e.timestamp >= from && e.timestamp < to));
      const h0   = b * blockHours, h1 = h0 + blockHours;
      blocks.push({
        blockIndex: b,
        total:      agg.input + agg.output,
        rangeLabel: `${String(h0).padStart(2, '0')}–${String(h1).padStart(2, '0')}h`,
      });
    }
    result.push({
      label:   new Date(dayFrom).toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2),
      date:    new Date(dayFrom).toLocaleDateString('en-GB'),
      isToday: i === 0,
      blocks,
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

// Vault/project breakdown (Björn, 01.09.2026) — Claude Code stamps every assistant-line JSONL
// entry with `cwd`, the exact working directory the request ran in. All aggregation (live day
// buckets, archive frontmatter, dashboard/export overview) keys by this display label directly,
// applied as early as possible (right where a raw cwd first enters a tally), never by the raw
// cwd string — this is a deliberate simplification over an earlier draft that kept raw-cwd keys
// in the live branch only: that would have made the SAME vault split into two separate rows once
// its data crossed the archive-retention boundary (live days keyed by cwd, archived days keyed by
// label, because archive frontmatter always stores the label for readability — see
// _buildArchiveContent()). Splitting one real vault into two rows is a guaranteed, everyday bug;
// two different vaults colliding on the same last-folder-name is a rare, avoidable-by-renaming
// edge case. Consistent label-keying accepts the latter risk to eliminate the former.
function vaultLabel(cwd) {
  if (!cwd) return 'Unknown';
  const norm = String(cwd).replace(/[\\/]+$/, '');
  // Claude Desktop agent mode (v1.8): these sessions run in a generated sandbox whose cwd ends in
  // a technical "outputs" folder, so the generic last-segment rule would file every one of them
  // under a meaningless shared "outputs" row. The anchor folder name is part of the path itself,
  // which makes this checkable here — and because every tally keys through vaultLabel(), the
  // special case covers live data, archived data, dashboard, sidebar and export in one place.
  if (norm.includes(AGENT_MODE_DIRNAME)) return 'Claude Desktop (Agent Mode)';
  const parts = norm.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'Unknown';
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
// Collects every *.jsonl below a Claude Code "projects" directory (one subfolder per working
// directory, session files inside). Extracted from getAllSessionFiles() so the identical layout
// can be harvested from more than one root — see getAgentModeProjectDirs().
function collectFromProjectsDir(projectsDir, files) {
  if (!fs.existsSync(projectsDir)) return;
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const projDir = path.join(projectsDir, proj);
      try {
        for (const entry of fs.readdirSync(projDir)) {
          if (!entry.endsWith('.jsonl')) continue;
          const full = path.join(projDir, entry);
          try { const s = fs.statSync(full); files.push({ path: full, mtime: s.mtimeMs, size: s.size }); } catch(e) {}
        }
      } catch(e) {}
    }
  } catch(e) {}
}

// Anchors under which Claude Desktop keeps its agent-mode sessions. Two installation flavours:
//   MSIX/Store  — %LOCALAPPDATA%\Packages\<Claude_hash>\LocalCache\Roaming\Claude\...
//                 (the app itself only ever sees the virtualised %APPDATA%\Claude path, so the
//                  cwd recorded inside the files does NOT match this physical location)
//   classic     — %APPDATA%\Claude\...
// The package folder is globbed rather than hardcoded so the publisher hash can change.
function getAgentModeRoots() {
  const roots = [];
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  roots.push(path.join(appData, 'Claude', AGENT_MODE_DIRNAME));

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const packagesDir  = path.join(localAppData, 'Packages');
  try {
    for (const pkg of fs.readdirSync(packagesDir)) {
      if (!/^Claude_/i.test(pkg)) continue;
      roots.push(path.join(packagesDir, pkg, 'LocalCache', 'Roaming', 'Claude', AGENT_MODE_DIRNAME));
    }
  } catch(e) {}
  return roots;
}

// Walks the known fixed depth below each agent-mode root and returns every ".claude/projects"
// directory found. Deliberately not a recursive scan: the layout is known, and recursing through
// an app sandbox would be needlessly expensive on every refresh.
function getAgentModeProjectDirs() {
  const dirs = [];
  for (const root of getAgentModeRoots()) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const workspace of fs.readdirSync(root)) {
        const wsDir = path.join(root, workspace);
        try {
          for (const session of fs.readdirSync(wsDir)) {
            const sessDir = path.join(wsDir, session);
            try {
              for (const local of fs.readdirSync(sessDir)) {
                const projectsDir = path.join(sessDir, local, '.claude', 'projects');
                if (fs.existsSync(projectsDir)) dirs.push(projectsDir);
              }
            } catch(e) {}
          }
        } catch(e) {}
      }
    } catch(e) {}
  }
  return dirs;
}

function getAllSessionFiles() {
  const files = [];
  collectFromProjectsDir(CLAUDE_DIR, files);
  // Second source (v1.8): Claude Desktop's embedded agent mode. Same format, same parser —
  // only the location differs. Missing folders are the normal case (feature never used, or
  // the desktop app not installed at all) and are handled silently by the existsSync guards.
  for (const dir of getAgentModeProjectDirs()) collectFromProjectsDir(dir, files);
  return files.sort((a, b) => b.mtime - a.mtime);
}

function parseUsageFromFile(filePath, minTimestamp, fileSize) {
  const entries          = [];
  const synthetic        = []; // assistant/<synthetic> entries — written by CC after each compaction
  const compactions      = []; // system/compact_boundary — authoritative compaction data (pre/postTokens)
  const apiErrors        = []; // system/api_error — connection or auth failures
  const aiTitles         = {}; // sessionId → human-readable session title from ai-title entries
  const rateLimitEvents  = []; // assistant/<synthetic> with error:"rate_limit" — actual session/weekly limit hits
  let fullContent  = '';
  let chunkContent = '';
  let usedChunk    = false;
  // Vault/Root breakdown (01.09.2026, revised) — the first cwd seen anywhere in the file
  // (chronologically earliest line) is the session's actual start directory. Individual messages
  // can drift away from it later (e.g. a Bash tool call temporarily cd's into a subfolder), but
  // the session-start cwd stays a stable "which vault/root" anchor for the whole file. Checked in
  // both passes below so large/active files (tail-chunk mode) still catch it from the head block.
  let rootCwd = null;
  try {
    if (fileSize > 1_500_000 && minTimestamp && minTimestamp > daysAgoTs(1)) {
      // Large active file: read only the tail for token entries (performance).
      // ai-title is written at the START of a session — read a small head block too.
      const chunk  = Math.min(600_000, fileSize);
      const buf    = Buffer.alloc(chunk);
      const fd     = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, chunk, fileSize - chunk);
      fs.closeSync(fd);
      chunkContent = buf.toString('utf8');
      const nl     = chunkContent.indexOf('\n');
      if (nl > -1) chunkContent = chunkContent.slice(nl + 1);
      // Also read first 8 kB to capture ai-title (always near the top)
      const headBuf = Buffer.alloc(8192);
      const fdH     = fs.openSync(filePath, 'r');
      const read    = fs.readSync(fdH, headBuf, 0, 8192, 0);
      fs.closeSync(fdH);
      fullContent = headBuf.toString('utf8', 0, read);
      usedChunk = true;
    } else {
      fullContent = fs.readFileSync(filePath, 'utf8');
    }

    // Pass 1 — head block only (ai-title lives near the top)
    for (const line of fullContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!rootCwd && obj.cwd) rootCwd = obj.cwd;
        if (obj.type === 'ai-title' && obj.aiTitle && obj.sessionId) {
          aiTitles[obj.sessionId] = obj.aiTitle;
        }
      } catch(e) {}
    }

    // Pass 2 — main content (tail chunk for large files, full content otherwise)
    const mainContent = usedChunk ? chunkContent : fullContent;
    for (const line of mainContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!rootCwd && obj.cwd) rootCwd = obj.cwd; // fallback if the head-block pass found nothing
        const sid = obj.sessionId || '';

        // ── assistant entries: token usage + synthetic markers
        if (obj.type === 'assistant') {
          const msg = obj.message;
          if (!msg?.usage) continue;
          const ts = new Date(obj.timestamp).getTime();
          if (minTimestamp && ts < minTimestamp) continue;
          // <synthetic>: zero-token boundary marker written by CC directly after a compaction.
          // Gap of ~1 s = auto-compaction; longer gap = session-resume marker.
          // Special case: if obj.error === 'rate_limit', this is a rate-limit hit event —
          // CC writes a synthetic entry with apiErrorStatus 429 and a human-readable message.
          if (msg.model === '<synthetic>') {
            if (obj.error === 'rate_limit') {
              const text = msg.content?.[0]?.text || '';
              const typ  = text.includes('weekly') ? 'weekly' : 'session';
              const rm   = text.match(/resets\s+(.+?)\s*\(Europe\/Berlin\)/);
              rateLimitEvents.push({
                timestamp: ts,
                sessionId: sid,
                type:      typ,
                message:   text,
                reset:     rm ? rm[1].trim() : '',
              });
            } else {
              synthetic.push({ timestamp: ts, sessionId: sid });
            }
            continue;
          }
          // Drop any other zero-token noise not covered above
          if ((msg.usage.input_tokens || 0) === 0 &&
              (msg.usage.output_tokens || 0) === 0 &&
              (msg.usage.cache_creation_input_tokens || 0) === 0 &&
              (msg.usage.cache_read_input_tokens || 0) === 0) continue;
          entries.push({
            timestamp: ts, model: msg.model || 'unknown', sessionId: sid,
            cwd: obj.cwd || '', root: rootCwd || obj.cwd || '',
            usage: {
              input_tokens:                msg.usage.input_tokens                || 0,
              output_tokens:               msg.usage.output_tokens               || 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens:     msg.usage.cache_read_input_tokens     || 0,
            }
          });
          continue;
        }

        // ── system entries: compaction data + API errors
        if (obj.type === 'system') {
          const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
          if (obj.subtype === 'compact_boundary' && obj.compactMetadata) {
            if (!minTimestamp || ts >= minTimestamp) {
              compactions.push({
                timestamp:  ts,
                sessionId:  sid,
                preTokens:  obj.compactMetadata.preTokens  || 0,
                postTokens: obj.compactMetadata.postTokens || 0,
                durationMs: obj.compactMetadata.durationMs || 0,
                trigger:    obj.compactMetadata.trigger    || 'unknown',
              });
            }
          } else if (obj.subtype === 'api_error' && obj.error) {
            if (!minTimestamp || ts >= minTimestamp) {
              apiErrors.push({
                timestamp:   ts,
                sessionId:   sid,
                status:      obj.error.status      || null,
                formatted:   obj.error.formatted   || obj.error.message || '',
                isRateLimit: obj.error.status === 429,
                isNetwork:   obj.error.isNetworkDown || false,
                retryAttempt: obj.retryAttempt     || 1,
              });
            }
          }
          continue;
        }

        // ── ai-title: also collect from main content in case it wasn't in the head block
        if (obj.type === 'ai-title' && obj.aiTitle && obj.sessionId) {
          aiTitles[obj.sessionId] = obj.aiTitle;
        }

      } catch(e) {}
    }
  } catch(e) {}
  return { entries, synthetic, compactions, apiErrors, aiTitles, rateLimitEvents };
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
    this._collapsed = new Set(); // keys of collapsed sections — persists across data refreshes
    // NextGen sidebar v2 (Phase A/E, multi-page nav) — same "persists across rebuilds" pattern
    // as _collapsed/helpVisible above. Only ever read/written when sidebarMode === 'nextgen';
    // Classic never touches this field. Settings IS a real inline page (Björn, 29.08.2026 —
    // matches the original plan; an earlier revision briefly made it open the Obsidian settings
    // modal instead, which was a deviation, reverted here), rendered via the same buildSettingsUI()
    // the real Obsidian settings tab uses — see _renderSettingsPage().
    // 'today' | 'overview' | 'settings'. Rail order/naming as of 29.08.2026 (second revision):
    // Today = Last Action/5h/This Session/Today (the old 'overview' page, renamed — it's the
    // default landing page). Overview = the 7 Days/N Days tile grids (was briefly merged into
    // Today, split back out as its own page — Björn wants room to grow this with more summary
    // info later). Archive dropped from the rail entirely for now (was a placeholder only).
    this._activePage = 'today';
    // NextGen activity calendar (v1.8) — which month is on screen. Same "persists across
    // rebuilds" pattern as _activePage; only read when sidebarMode === 'nextgen' AND
    // settings.calendarVisible !== false. Starts on the current month.
    const _cnow = new Date();
    this._calYear  = _cnow.getFullYear();
    this._calMonth = _cnow.getMonth(); // 0-11
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
      const now           = Date.now();
      const todayTs       = dayStart(new Date());
      const day7Ts        = daysAgoTs(7);
      const retentionDays = readCleanupPeriodDays(); // v1.7: respect Claude Code's own cleanupPeriodDays instead of a hardcoded 30
      const day30Ts       = daysAgoTs(retentionDays);
      const win5hTs       = now - 5 * 3_600_000;
      const files   = getAllSessionFiles();
      const curId   = files.length > 0 ? path.basename(files[0].path, '.jsonl') : null;

      let all                 = [];
      let allSynthetic        = [];
      let allCompactions      = [];
      let allApiErrors        = [];
      let allRateLimitEvents  = [];
      let sessionTitles       = {};
      for (const f of files) {
        if (f.mtime < day30Ts) break;
        const parsed    = parseUsageFromFile(f.path, day30Ts, f.size);
        all             = all.concat(parsed.entries);
        allSynthetic    = allSynthetic.concat(parsed.synthetic);
        allCompactions  = allCompactions.concat(parsed.compactions);
        allApiErrors    = allApiErrors.concat(parsed.apiErrors);
        allRateLimitEvents = allRateLimitEvents.concat(parsed.rateLimitEvents);
        Object.assign(sessionTitles, parsed.aiTitles);
      }
      all.sort((a, b) => b.timestamp - a.timestamp);

      const d7       = all.filter(e => e.timestamp >= day7Ts);
      const win5h    = all.filter(e => e.timestamp >= win5hTs);
      const win5hAgg = aggregate(win5h);
      // Detect if the 5h window just cleared: no current entries, but activity in the last 6h
      const win6hTs      = now - 6 * 3_600_000;
      const windowCleared = win5hAgg.count === 0 && all.some(e => e.timestamp >= win6hTs);

      const sessionEntries = curId ? all.filter(e => e.sessionId === curId) : [];

      // Spike detection — compare today vs personal 29-day baseline (active days only)
      const todayAgg      = aggregate(all.filter(e => e.timestamp >= todayTs));
      const todayTotal    = todayAgg.input + todayAgg.output;
      const past29        = all.filter(e => e.timestamp >= day30Ts && e.timestamp < todayTs);
      const activeDays    = new Set(past29.map(e => dayStart(new Date(e.timestamp)))).size;
      const past29Total   = past29.reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
      const avgDaily      = activeDays > 0 ? past29Total / activeDays : 0;
      const spikeRatio    = (avgDaily > 0 && todayTotal > 0) ? Math.round(todayTotal / avgDaily * 10) / 10 : 0;

      // Community-requested "outlier" signal (Obsidian Forum, shipped as the Today spike badge
      // in v1.6.0), extended to the 7-Days Overview tile (Björn, 01.09.2026, Nachschärfungsliste
      // Punkt 6) — same 29-day baseline (avgDaily) reused, not a second baseline concept. Compares
      // this week's average tokens per active day against that same baseline.
      const d7ActiveDays  = new Set(d7.map(e => dayStart(new Date(e.timestamp)))).size;
      const d7Total       = d7.reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
      const d7AvgDaily    = d7ActiveDays > 0 ? d7Total / d7ActiveDays : 0;
      const spikeRatioWeek = (avgDaily > 0 && d7AvgDaily > 0) ? Math.round(d7AvgDaily / avgDaily * 10) / 10 : 0;

      // Per-token-type spike ratios (UI relaunch Phase 2 — NextGen sidebar verdict glyphs).
      // Same 29-day active-day baseline as spikeRatio above, computed independently per token
      // type so each Today stat row (Input/Output/C.Write/C.Read) can carry its own verdict
      // instead of one combined badge for the whole day. Runs unconditionally regardless of
      // sidebarMode — cheap (reuses past29/activeDays already computed above), and keeps
      // refresh() from having to compute two different data sets depending on which sidebar
      // is actually shown.
      const past29ByType = {
        input:       past29.reduce((s, e) => s + (e.usage.input_tokens || 0), 0),
        output:      past29.reduce((s, e) => s + (e.usage.output_tokens || 0), 0),
        cacheCreate: past29.reduce((s, e) => s + (e.usage.cache_creation_input_tokens || 0), 0),
        cacheRead:   past29.reduce((s, e) => s + (e.usage.cache_read_input_tokens || 0), 0),
      };
      const spikeRatioByType = {};
      for (const k of ['input', 'output', 'cacheCreate', 'cacheRead']) {
        const avgK = activeDays > 0 ? past29ByType[k] / activeDays : 0;
        spikeRatioByType[k] = (avgK > 0 && todayAgg[k] > 0) ? Math.round(todayAgg[k] / avgK * 10) / 10 : 0;
      }

      // Analytics counters — prepared for v1.7 display
      const compact7d    = allCompactions.filter(e => e.timestamp >= day7Ts);
      const compactToday = allCompactions.filter(e => e.timestamp >= todayTs);

      this.data = {
        lastAction:   all[0] || null,
        session:      aggregate(sessionEntries),
        sessionStart: sessionEntries.length > 0 ? Math.min(...sessionEntries.map(e => e.timestamp)) : null,
        today:        todayAgg,
        avgDaily,
        spikeRatio,
        spikeRatioWeek,
        spikeRatioByType,
        day7:       aggregate(d7),
        day30:      aggregate(all),
        retentionDays,
        chart7:     groupByDay(d7, 7),
        heat7:      groupByBlocks(d7, 7, 4),     // NextGen heatmap only — Nachschärfungsliste Punkt 5
        window5h: {
          agg:     win5hAgg,
          oldest:  win5h.length > 0 ? Math.min(...win5h.map(e => e.timestamp)) : null,
          total:   win5hAgg.input + win5hAgg.output,
          cleared: windowCleared,
        },
        entries7:   d7,
        entries30:  all,
        // ── v1.7 analytics data (collected, not yet rendered in the panel) ──────
        // system/compact_boundary: authoritative compaction records.
        // Each entry: { timestamp, sessionId, preTokens, postTokens, durationMs, trigger }
        compactionEvents:  allCompactions,
        compactions7d:     compact7d.length,
        compactionsToday:  compactToday.length,
        // assistant/<synthetic>: CC-internal marker written after each compaction.
        // Correlated with compactionEvents but less informative; kept for reference.
        syntheticEvents:   allSynthetic,
        // system/api_error: connection failures, auth errors.
        // Each entry: { timestamp, sessionId, status, formatted, isRateLimit, isNetwork }
        apiErrors:         allApiErrors,
        // ai-title: maps sessionId → human-readable title generated by CC.
        // Use in dashboard to replace truncated UUIDs in Top Sessions table.
        sessionTitles,
        // Rate-limit events: assistant/<synthetic> entries with error:"rate_limit".
        // Each entry: { timestamp, sessionId, type ('session'|'weekly'), message, reset }
        rateLimitEvents:   allRateLimitEvents,
        updatedAt:  new Date(),
      };

      // v1.7 reporting switch: "day30" (sidebar's long-period section, plus the report's
      // period table) reflects the user's chosen Report period — NOT retentionDays. Those
      // are two different knobs: retentionDays is how far back Claude Code's own JSONL
      // files still exist on disk; reportPeriodDays is how far back the user actually wants
      // to see. Once the archive covers the gap, the two can diverge freely (e.g. 30-day
      // retention with a 1-year report period is entirely normal). Overwrites the plain
      // live-only aggregate computed above with the full live+archive blend.
      const reportPeriodDays = this.plugin.settings.reportPeriodDays || 30;
      this.data.reportPeriodDays = reportPeriodDays;
      const periodSeries = this._buildDayRange(reportPeriodDays);
      this.data.periodSeries = periodSeries; // NEU — Sparkline-Grundlage für die N-Days-Kachel (Punkt 6)
      this.data.day30 = periodSeries.reduce((s, x) => ({
        input:       s.input       + (x.input || 0),
        output:      s.output      + (x.output || 0),
        cacheCreate: s.cacheCreate + (x.cacheCreate || 0),
        cacheRead:   s.cacheRead   + (x.cacheRead || 0),
        count:       s.count       + (x.reqs || 0),
      }), { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, count: 0 });
      // NextGen sidebar tiles (Phase 2 iteration) — active-day count + tokens/active-day for
      // the N-Days period, same "productive days, not calendar days" principle as the
      // Dashboard's summary cards (Björn, 24.08.2026). Computed here (not in render()) because
      // periodSeries is already in hand; render() shouldn't redo _buildDayRange() on every draw.
      this.data.day30ActiveDays = periodSeries.filter(x => x.reqs > 0).length;
      this.data.day30AvgPerActiveDay = this.data.day30ActiveDays > 0
        ? Math.round((this.data.day30.input + this.data.day30.output) / this.data.day30ActiveDays)
        : 0;

      if (files.length > 0 && files[0].path !== this._watchedFile) this._setupWatcher();
      this._archiveDays(); // fire-and-forget — never blocks the render path; backfills + updates today
    } catch(err) {
      console.error('AnthropicUsage refresh error:', err);
    }
    this.render();
  }

  render() {
    const el = this.containerEl.children[1];
    // Computed early (not just below with `content`) because the header's ⚙ button needs it —
    // NextGen has its own working Settings entry in the rail now, so the header button is only
    // needed in Classic, which has no rail at all.
    const isNextGen = this.plugin.settings.sidebarMode === 'nextgen';
    // Preserve scroll position across the render() cycle (Björn, 03.09.2026) — refresh() calls
    // render() unconditionally every refreshSeconds (default 30s), and render() always empties
    // and rebuilds the whole tree. Without this, any mid-scroll read (most noticeably the
    // NextGen inline Settings page, but any long list in either mode) gets yanked back to the
    // top every 30 seconds. Captured BEFORE el.empty() below, from whichever element actually
    // scrolls in the mode we were just in: Classic scrolls on `el` itself (.au-container
    // overflow-y:auto); NextGen scrolls on `.au-content` inside the rail shell instead (`el`
    // itself is overflow-y:hidden there, see .au-container.au-nextgen in styles.css) — and since
    // the whole shell is torn down and rebuilt every render(), that's a brand-new element each
    // time, not the same node whose scrollTop would simply persist on its own. Querying the OLD
    // DOM against the NEW isNextGen value degrades safely if the sidebar mode was just switched
    // (querySelector finds nothing / el.scrollTop is 0 in the mode it wasn't scrolling in) —
    // that just means "start at the top," which is the right behavior for a genuine mode switch.
    const prevScrollEl = isNextGen ? el.querySelector('.au-content') : el;
    const savedScroll   = prevScrollEl ? prevScrollEl.scrollTop : 0;

    el.empty();
    el.addClass('au-container');
    // Explicit toggle (not just addClass) — el.empty() clears children but not the element's
    // own classes, so switching back to Classic must actively remove this or it would linger
    // (Björn, 29.08.2026 — this class is what fixes the permanent-scrollbar bug, see styles.css
    // .au-container.au-nextgen).
    el.toggleClass('au-nextgen', isNextGen);

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

    // Classic-only (Björn, 29.08.2026): NextGen's rail has its own working Settings icon now
    // (opens the same Obsidian settings tab), so this header button would just be a redundant
    // second entry point there. Classic has no rail, so it still needs this button.
    if (!isNextGen) {
      const settingsBtn = btnWrap.createEl('button', { cls: 'au-settings-btn', text: '⚙' });
      settingsBtn.title   = 'Plugin settings';
      settingsBtn.onclick = () => { this.app.setting.open(); this.app.setting.openTabById('token-usage'); };
    }

    const helpBtn = btnWrap.createEl('button', {
      cls:  'au-help-btn' + (this.helpVisible ? ' au-help-active' : ''),
      text: '?',
    });
    helpBtn.title   = 'Help — glossary and concept explanations';
    helpBtn.onclick = () => { this.helpVisible = !this.helpVisible; this.render(); };

    if (this.helpVisible) {
      const backBtn = btnWrap.createEl('button', { cls: 'au-back-btn', text: t('backBtn') });
      backBtn.title   = 'Back to data view';
      backBtn.onclick = () => { this.helpVisible = false; this.render(); };
    }

    // ── NextGen shell: left icon rail + content area (UI relaunch v2, Phase A). Classic never
    // creates .au-shell — `content` is simply `el`, so every call below is byte-for-byte the
    // same code path Classic has always used. See _renderRail()/_renderNextGenPages().
    let content = el;
    if (isNextGen) {
      const shell = el.createEl('div', { cls: 'au-shell' });
      this._renderRail(shell);
      content = shell.createEl('div', { cls: 'au-content' });
    }
    // Restoring `content.scrollTop` right here (synchronously) would be clamped straight back to
    // 0 — the element has no children yet, so its scrollHeight is 0. Every branch below finishes
    // populating `content` (or a container inside it) synchronously before render() returns, so a
    // single rAF callback scheduled here — after all of them, before the next paint — covers
    // every return path (help mode, loading state, NextGen pages, Classic body) without having to
    // duplicate the restore call at each one.
    if (savedScroll > 0) {
      requestAnimationFrame(() => { content.scrollTop = savedScroll; });
    }

    // ── Help mode: replace content with glossary
    if (this.helpVisible) {
      this._renderHelp(content);
      return;
    }

    if (!this.data) { content.createEl('div', { cls: 'au-loading', text: t('loading') }); return; }
    const d = this.data;

    // Anchor block (UI relaunch v2, Björn 29.08.2026): meta/chart/model-bar stay pinned to the
    // top of the scrolling content area on every rail page — only the page-specific content
    // below scrolls underneath them. Classic is untouched: `anchor` is simply `content` there
    // (same reasoning as the `content`/`el` split in Phase A), so this changes nothing for it.
    const anchor = isNextGen ? content.createEl('div', { cls: 'au-content-anchor' }) : content;

    // ── Meta
    const meta = anchor.createEl('div', { cls: 'au-meta' });
    meta.createEl('span', { cls: 'au-live', text: `${this._watcher ? '● Live' : '○'} ${d.updatedAt.toLocaleTimeString('en-GB')}` });

    // ── 7-day chart (Classic: bar chart, unchanged) / heatmap (NextGen only — Nachschärfungsliste
    // Punkt 5, 01.09.2026)
    if (isNextGen) {
      this._renderHeatmap(anchor, d.heat7);
    } else {
      this._renderChart(anchor, d.chart7);
    }

    // ── Model distribution (7 days)
    this._renderModelBar(anchor, d.entries7);

    // UI relaunch Phase 2/v2 — NextGen routes the rest of the body through the rail's page
    // dispatch (_renderNextGenPages); Classic keeps its original, untouched inline sequence
    // below (Last Action, 5h Window, Periods) exactly as before this change.
    if (isNextGen) {
      this._renderNextGenPages(content, d);
      this._renderFooter(content, d);
      // Calendar last, so it's the final child of .au-content and its sticky bottom:0 sticks
      // flush with the scroll container's edge (mirror of the anchor being the first child).
      if (this.plugin.settings.calendarVisible !== false) this._renderCalendar(content, d);
      return;
    }

    // ── Last action
    if (d.lastAction) {
      const la  = d.lastAction;
      const sec = content.createEl('div', { cls: 'au-section' });
      const lhdr = sec.createEl('div', { cls: 'au-last-hdr' });
      lhdr.createEl('span', { cls: 'au-section-title', text: t('lastAction') });
      lhdr.createEl('span', { cls: 'au-model-chip', text: la.model.replace('claude-', '') });
      const chips = sec.createEl('div', { cls: 'au-last-chips' });
      const chipDefs = [
        { label: t('chipIn'),  val: la.usage.input_tokens,                color: 'blue'   },
        { label: t('chipOut'), val: la.usage.output_tokens,               color: 'green'  },
        { label: t('chipCWr'), val: la.usage.cache_creation_input_tokens, color: 'purple' },
        { label: t('chipCRd'), val: la.usage.cache_read_input_tokens,     color: 'amber'  },
      ];
      for (const { label, val, color } of chipDefs) {
        const chip = chips.createEl('span', { cls: `au-last-chip au-last-chip-${color}` });
        chip.createEl('span', { cls: 'au-last-chip-lbl', text: label + ' ' });
        chip.createEl('span', { cls: 'au-last-chip-val', text: fmtTokens(val) });
      }
    }

    // ── 5h Window
    this._renderWindow5h(content);

    // ── Periods
    let sessionSub = '';
    if (d.sessionStart) {
      const startTs  = d.sessionStart;
      const todayMid = dayStart(new Date());
      const start    = new Date(startTs);
      if (startTs < todayMid) {
        const daysAgo = Math.floor((todayMid - startTs) / 86_400_000);
        sessionSub = daysAgo === 1
          ? t('startedYesterday')
          : t('startedDate', start.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }));
      } else {
        sessionSub = t('startedToday', start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      }
    }
    this._renderPeriod(content, 'this-session', t('thisSession'), d.session, sessionSub);
    // Classic — untouched: today/7-days/30-days via the shared _renderPeriod()/_statRow().
    // NextGen's equivalent content (verdict glyphs on Today, tile grids on 7/30 Days) already
    // returned above via _renderNextGenPages(), so this code only ever runs for Classic.
    this._renderPeriod(content, 'today',   t('today'),    d.today, t('calendarDay'));
    this._renderPeriod(content, '7-days',  t('sevenDays'), d.day7);
    this._renderPeriod(content, '30-days', t('thirtyDays', d.reportPeriodDays), d.day30);

    this._renderFooter(content, d);
  }

  // ── Footer (shared by Classic and NextGen) ────────────────────
  _renderFooter(parent, d) {
    const footer   = parent.createEl('div', { cls: 'au-footer' });
    const leftSpan = footer.createEl('span', { cls: 'au-reset-countdown' });
    if (d.window5h.oldest) {
      const msLeft = Math.max(0, d.window5h.oldest + 5 * 3_600_000 - Date.now());
      if (msLeft > 0) leftSpan.textContent = t('resetsIn', fmtDuration(msLeft));
    }
    footer.createEl('span', { cls: 'au-version', text: `v${this.plugin.manifest.version}` });
  }

  // ── NextGen rail + page dispatch (UI relaunch v2, Phase A) ───────────────────────
  // Pure layout wrappers — reuse the exact same, already-tested renderers Classic uses
  // (_renderPeriod/_renderWindow5h/_renderPeriodToday/_renderPeriodTiles), just re-parented
  // behind the rail's active-page state instead of always running inline. None of those
  // renderers are modified by this section.
  _renderRail(parent) {
    const rail = parent.createEl('div', { cls: 'au-rail' });
    // Rail order/naming, second revision (Björn, 29.08.2026): Today (default landing page) →
    // Overview (the 7 Days/N Days tile grids, split back into its own page — room to grow with
    // more summary info later) → Settings. Archive dropped entirely (was a placeholder only,
    // no real content yet — can come back once it has an actual design).
    const pages = [
      { key: 'today',    icon: 'bar-chart-2', label: t('today')        },
      { key: 'overview', icon: 'activity',    label: t('railOverview') },
      { key: 'settings', icon: 'settings',    label: t('railSettings') },
    ];
    for (const p of pages) {
      const btn = rail.createEl('div', {
        cls: 'au-rail-icon' + (this._activePage === p.key ? ' is-active' : ''),
      });
      obsidian.setIcon(btn, p.icon);
      btn.title = p.label;
      btn.onclick = () => {
        this._activePage = p.key;
        this.helpVisible = false; // clicking a page icon should surface that page, not leave help open
        this.render();
      };
    }
  }

  _renderNextGenPages(el, d) {
    switch (this._activePage) {
      case 'overview': this._renderOverviewPage(el, d); break;
      case 'settings': this._renderSettingsPage(el);    break;
      case 'today':
      default:         this._renderTodayPage(el, d);    break;
    }
  }

  // Today page (was "Overview" in the first revision, renamed) = Last Action + 5h Window +
  // This Session + Today — verbatim the same content and renderers Classic uses for these
  // (_renderWindow5h/_renderPeriod/_renderPeriodToday), just moved here so they only show on
  // this one page instead of always inline. Default landing page in NextGen mode.
  _renderTodayPage(el, d) {
    if (d.lastAction) {
      const la  = d.lastAction;
      const sec = el.createEl('div', { cls: 'au-section' });
      const lhdr = sec.createEl('div', { cls: 'au-last-hdr' });
      lhdr.createEl('span', { cls: 'au-section-title', text: t('lastAction') });
      lhdr.createEl('span', { cls: 'au-model-chip', text: la.model.replace('claude-', '') });
      const chips = sec.createEl('div', { cls: 'au-last-chips' });
      const chipDefs = [
        { label: t('chipIn'),  val: la.usage.input_tokens,                color: 'blue'   },
        { label: t('chipOut'), val: la.usage.output_tokens,               color: 'green'  },
        { label: t('chipCWr'), val: la.usage.cache_creation_input_tokens, color: 'purple' },
        { label: t('chipCRd'), val: la.usage.cache_read_input_tokens,     color: 'amber'  },
      ];
      for (const { label, val, color } of chipDefs) {
        const chip = chips.createEl('span', { cls: `au-last-chip au-last-chip-${color}` });
        chip.createEl('span', { cls: 'au-last-chip-lbl', text: label + ' ' });
        chip.createEl('span', { cls: 'au-last-chip-val', text: fmtTokens(val) });
      }
    }

    this._renderWindow5h(el);

    let sessionSub = '';
    if (d.sessionStart) {
      const startTs  = d.sessionStart;
      const todayMid = dayStart(new Date());
      const start    = new Date(startTs);
      if (startTs < todayMid) {
        const daysAgo = Math.floor((todayMid - startTs) / 86_400_000);
        sessionSub = daysAgo === 1
          ? t('startedYesterday')
          : t('startedDate', start.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }));
      } else {
        sessionSub = t('startedToday', start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      }
    }
    this._renderPeriod(el, 'this-session', t('thisSession'), d.session, sessionSub);
    this._renderPeriodToday(el, d);
  }

  // Overview page (Björn, 29.08.2026, second rail revision) = the 7 Days/N Days tile grids,
  // split back out into their own page (briefly lived on Today/the old "Overview" page).
  // Deliberately its own method, not just a rename of the old Trends-page renderer — Björn's
  // plan is to grow this with more summary info later (visual polish first, content later),
  // so it gets a name/identity of its own rather than being "leftover Trends code".
  _renderOverviewPage(el, d) {
    const weekBadge = d.spikeRatioWeek >= 2
      ? { verdict: 'warn', text: `${d.spikeRatioWeek.toFixed(1)}×` }
      : null;
    this._renderPeriodTiles(el, '7-days',  t('sevenDays'), d.day7, 7,
      d.chart7.filter(x => x.total > 0).length, d.chart7, weekBadge);
    this._renderPeriodTiles(el, '30-days', t('thirtyDays', d.reportPeriodDays), d.day30,
      d.reportPeriodDays, d.day30ActiveDays, d.periodSeries);
  }

  // Settings page (Phase E) — the exact same Setting objects the real Obsidian settings tab
  // uses (buildSettingsUI(), shared, defined once), rendered directly into the panel instead of
  // a separate modal. refreshUI here is this.render() (redraws the whole panel, cheap and
  // already the pattern every other rail click uses) rather than a settings-tab-only display().
  _renderSettingsPage(el) {
    const wrap = el.createEl('div', { cls: 'au-inline-settings' });
    buildSettingsUI(wrap, this.app, this.plugin, () => this.render());
  }

  // ── NextGen activity calendar (v1.8) ─────────────────────────────
  // Pinned to the bottom of .au-content on every rail page (Today/Overview/Settings) — the
  // mirror of the sticky-top .au-content-anchor. Display only, no click behaviour. One dot per
  // past active day, banded against the same 29-day avgDaily baseline the Today spike badge
  // uses (no second baseline concept). Classic never calls this.
  _renderCalendar(parent, d) {
    const loc = localeFor(_lang);
    const cal = parent.createEl('div', { cls: 'au-calendar' });

    const viewFirst = new Date(this._calYear, this._calMonth, 1);
    const now       = new Date();
    const minReached = this._calYear < 2020 || (this._calYear === 2020 && this._calMonth <= 0);
    const maxReached = this._calYear === now.getFullYear() && this._calMonth === now.getMonth();

    const head = cal.createEl('div', { cls: 'au-cal-head' });
    const prev = head.createEl('button', { cls: 'au-cal-nav', text: '‹' });
    prev.title = t('calPrev');
    prev.disabled = minReached;
    if (!minReached) prev.onclick = () => this._calShift(-1);
    head.createEl('span', { cls: 'au-cal-title',
      text: viewFirst.toLocaleDateString(loc, { month: 'long', year: 'numeric' }) });
    const next = head.createEl('button', { cls: 'au-cal-nav', text: '›' });
    next.title = t('calNext');
    next.disabled = maxReached;
    if (!maxReached) next.onclick = () => this._calShift(1);

    const grid = cal.createEl('div', { cls: 'au-cal-grid' });
    // Weekday header, Monday-first, localised short names (2024-01-01 is a Monday).
    const wkRef = new Date(2024, 0, 1);
    for (let i = 0; i < 7; i++) {
      const dd = new Date(wkRef); dd.setDate(wkRef.getDate() + i);
      grid.createEl('span', { cls: 'au-cal-dow', text: dd.toLocaleDateString(loc, { weekday: 'short' }) });
    }

    const avg = d.avgDaily || 0;
    for (const c of this._buildMonthDays(this._calYear, this._calMonth)) {
      const cell = grid.createEl('span', {
        cls: 'au-cal-day'
          + (c.outside  ? ' is-outside' : '')
          + (c.isToday  ? ' is-today'   : '')
          + (c.isFuture ? ' is-future'  : ''),
      });
      cell.createEl('span', { cls: 'au-cal-dom', text: String(c.dom) });
      const total = (c.input || 0) + (c.output || 0);
      if (!c.isFuture && total > 0 && avg > 0) {
        const verdict = bandedVerdict(total / avg, [
          { upTo: 1,        key: 'good' }, // below the recent daily average
          { upTo: 2,        key: 'warn' }, // roughly average up to 2×
          { upTo: Infinity, key: 'bad'  }, // 2× or more — a spike
        ]);
        const dot = cell.createEl('span', { cls: `au-cal-dot au-cal-dot-${verdict}` });
        dot.title = new Date(c.ts).toLocaleDateString(loc) + ' · ' + fmtTokens(total);
      }
    }
  }

  // Month step with clamping — never before Jan 2020, never into a future month.
  _calShift(delta) {
    let m = this._calMonth + delta, y = this._calYear;
    while (m < 0)  { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    const now = new Date();
    if (y < 2020 || (y === 2020 && m < 0)) { y = 2020; m = 0; }
    if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth())) {
      y = now.getFullYear(); m = now.getMonth();
    }
    this._calYear = y; this._calMonth = m;
    this.render();
  }

  // ── Help panel ────────────────────────────────────────────────
  _renderHelp(parent) {
    const wrap = parent.createEl('div', { cls: 'au-help' });

    const intro = wrap.createEl('div', { cls: 'au-help-intro' });
    intro.createEl('span', { cls: 'au-help-title', text: t('glossaryTitle') });
    intro.createEl('span', { cls: 'au-help-sub', text: t('glossarySub') });

    for (const sec of (STRINGS[_lang]?.helpSections || HELP_SECTIONS)) {
      const s = wrap.createEl('div', { cls: 'au-help-section' });
      s.createEl('div', { cls: 'au-help-section-title', text: sec.title });
      for (const line of sec.body.split('\n')) {
        if (line.trim()) s.createEl('p', { cls: 'au-help-section-body', text: line });
      }
    }

    const linkWrap = wrap.createEl('div', { cls: 'au-help-link-wrap' });
    const link = linkWrap.createEl('a', { cls: 'au-help-link', text: t('helpLink') });
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

  // ── Heatmap (NextGen only) ───────────────────────────────────
  // 7 days × 6×4h blocks, fixed 3-band coloring (High/Medium/Low). Replaces _renderChart() in
  // NextGen mode only — Nachschärfungsliste Punkt 5, 01.09.2026. _renderChart() itself untouched.
  _renderHeatmap(parent, dayBlocks) {
    const sec = parent.createEl('div', { cls: 'au-section au-heatmap-section' });
    sec.createEl('div', { cls: 'au-section-title', text: t('heatmapTitle') });

    const max = Math.max(...dayBlocks.flatMap(d => d.blocks.map(b => b.total)), 1);

    const grid = sec.createEl('div', { cls: 'au-heatmap-grid' });
    for (const day of dayBlocks) {
      const col   = grid.createEl('div', { cls: 'au-heatmap-col' });
      const cells = col.createEl('div', { cls: 'au-heatmap-cells' });
      for (const block of day.blocks) {
        const ratio = max > 0 ? block.total / max : 0;
        const { css } = heatBandColor(ratio);
        const cell = cells.createEl('div', { cls: 'au-heatmap-cell' });
        cell.style.background = css;
        // isToday/past dimming only — the color itself now fully communicates the band (gray
        // "empty" is a genuinely different color from green "low", not the same gray at a
        // different opacity like the previous purple/blue/gray palette needed).
        cell.style.opacity = day.isToday ? '1' : '0.7';
        cell.title = `${day.date} ${block.rangeLabel}: ${fmtTokens(block.total)} T`;
      }
      col.createEl('div', {
        cls:  'au-heatmap-lbl' + (day.isToday ? ' au-lbl-today' : ''),
        text: day.label,
      });
    }

    const legend = sec.createEl('div', { cls: 'au-heatmap-legend' });
    const legendDefs = [
      { swatchCls: 'au-heatmap-swatch-high',   label: t('heatLegendHigh')   },
      { swatchCls: 'au-heatmap-swatch-medium', label: t('heatLegendMedium') },
      { swatchCls: 'au-heatmap-swatch-low',    label: t('heatLegendLow')    },
      { swatchCls: 'au-heatmap-swatch-empty',  label: t('heatLegendEmpty')  },
    ];
    for (const { swatchCls, label } of legendDefs) {
      const item = legend.createEl('span', { cls: 'au-heatmap-legend-item' });
      item.createEl('span', { cls: `au-heatmap-swatch ${swatchCls}` });
      item.createEl('span', { text: label });
    }
  }

  // ── Model bar ─────────────────────────────────────────────────
  _renderModelBar(parent, entries) {
    if (!entries || entries.length === 0) return;
    const dist = modelDistribution(entries);
    if (dist.length === 0) return;

    const sec = parent.createEl('div', { cls: 'au-section au-model-section' });
    sec.createEl('div', { cls: 'au-section-title', text: t('models') });

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

  // ── Collapsible section helper ────────────────────────────────
  // ngBadge (01.09.2026, Nachschärfungsliste Punkt 6): optional, only ever passed `true` by
  // _renderPeriodToday() (NextGen-exclusive). Classic's only caller, _renderPeriod(), never
  // passes it — so ngBadge stays undefined there and the badge markup is byte-identical to
  // before this change.
  _makeSection(parent, key, title, badge = null, ngBadge = false) {
    const isCollapsed = this._collapsed.has(key);
    const sec  = parent.createEl('div',  { cls: 'au-section' });
    const hdr  = sec.createEl('div',    { cls: 'au-section-hdr' });
    const chev = hdr.createEl('span',   { cls: 'au-chevron', text: isCollapsed ? '▶' : '▼' });
    hdr.createEl('span', { cls: 'au-section-title', text: title });
    if (badge) hdr.createEl('span', { cls: 'au-spike-badge' + (ngBadge ? ' au-spike-badge-ng' : ''), text: badge });
    const body = sec.createEl('div',    { cls: 'au-section-body' });
    if (isCollapsed) body.style.display = 'none';
    hdr.addEventListener('click', () => {
      if (this._collapsed.has(key)) {
        this._collapsed.delete(key);
        chev.textContent   = '▼';
        body.style.display = '';
      } else {
        this._collapsed.add(key);
        chev.textContent   = '▶';
        body.style.display = 'none';
      }
    });
    return { sec, body };
  }

  // ── 5h Window ─────────────────────────────────────────────────
  _renderWindow5h(parent) {
    const { window5h } = this.data;
    if (window5h.agg.count === 0) {
      const { body } = this._makeSection(parent, '5h', t('last5h'));
      body.createEl('div', {
        cls:  'au-section-sub' + (window5h.cleared ? ' au-window-cleared' : ''),
        text: window5h.cleared ? t('windowCleared') : t('waiting'),
      });
      return;
    }
    const { body } = this._makeSection(parent, '5h', t('last5h'));
    body.createEl('div', { cls: 'au-section-sub', text: t('rollingWindow') });
    const maxVal = Math.max(window5h.agg.input, window5h.agg.output, window5h.agg.cacheCreate, window5h.agg.cacheRead, 1);
    this._statRow(body, t('rowInput'),  window5h.agg.input,       maxVal, 'blue');
    this._statRow(body, t('rowOutput'), window5h.agg.output,      maxVal, 'green');
    this._statRow(body, t('rowCWrite'), window5h.agg.cacheCreate, maxVal, 'purple');
    this._statRow(body, t('rowCRead'),  window5h.agg.cacheRead,   maxVal, 'amber');
  }

  // ── Period section ────────────────────────────────────────────
  _renderPeriod(parent, key, title, stats, subtitle) {
    if (stats.count === 0) return;
    const badge = (key === 'today' && this.data.spikeRatio >= 2)
      ? t('spikeAvg', this.data.spikeRatio.toFixed(1))
      : null;
    const { body } = this._makeSection(parent, key, title, badge);
    if (subtitle) body.createEl('div', { cls: 'au-section-sub', text: subtitle });
    const maxVal = Math.max(stats.input, stats.output, stats.cacheCreate, stats.cacheRead, 1);
    this._statRow(body, t('rowInput'),  stats.input,       maxVal, 'blue');
    this._statRow(body, t('rowOutput'), stats.output,      maxVal, 'green');
    this._statRow(body, t('rowCWrite'), stats.cacheCreate, maxVal, 'purple');
    this._statRow(body, t('rowCRead'),  stats.cacheRead,   maxVal, 'amber');
  }

  _statRow(parent, label, value, max, color) {
    const row = parent.createEl('div', { cls: 'au-stat-row' });
    row.createEl('span', { cls: 'au-stat-lbl', text: label });
    row.createEl('span', { cls: `au-stat-val au-text-${color}`, text: fmtTokens(value) });
    const wrap = row.createEl('div', { cls: 'au-mini-bar-wrap' });
    const bar  = wrap.createEl('div', { cls: `au-mini-bar au-bar-${color}` });
    // Log scale: keeps all non-zero values visible across large magnitude differences
    const pct = (value > 0 && max > 0)
      ? (Math.log(1 + value) / Math.log(1 + max) * 100).toFixed(1)
      : 0;
    bar.style.width = pct + '%';
  }

  // ── NextGen sidebar (UI relaunch Phase 2, behind Settings → Sidebar appearance) ─────
  // Classic's render()/_renderPeriod()/_statRow() above are untouched by this section —
  // Today is the only period with a belastbare 29-day baseline (spikeRatioByType, computed
  // in refresh()), so it is the only one with its own NextGen row renderer. This Session/
  // 7 Days/30 Days keep using the shared _renderPeriod()/_statRow() in both sidebar modes.
  _renderPeriodToday(parent, d) {
    const stats = d.today;
    if (stats.count === 0) return;
    // Same combined day-level badge as Classic (unchanged threshold/logic) — the per-row
    // verdict glyphs below are additive detail, not a replacement for this overview signal.
    const badge = d.spikeRatio >= 2 ? t('spikeAvg', d.spikeRatio.toFixed(1)) : null;
    const { body } = this._makeSection(parent, 'today', t('today'), badge, true);
    body.createEl('div', { cls: 'au-section-sub', text: t('calendarDay') });
    const maxVal = Math.max(stats.input, stats.output, stats.cacheCreate, stats.cacheRead, 1);
    const sv = d.spikeRatioByType || {};
    // Same ≥2× threshold as the existing combined spike badge — reused, not reinvented, so
    // the two signals (day-level badge, per-row glyph) never disagree about what "notable"
    // means. No 'bad' state here (that stays reserved for the dashboard's weekly-limit
    // verdict, see bandedVerdict() callers there) — a busy day is not a problem, just notable.
    const verdictFor = (ratio) => ratio === 0 ? 'neutral' : bandedVerdict(ratio, [
      { upTo: 2,        key: 'good' },
      { upTo: Infinity, key: 'warn' },
    ]);
    // Baseline window shown in the verdict tooltip — matches the plugin's own retentionDays
    // (Claude data retention setting), NOT a hardcoded number. Default retentionDays is 30,
    // which spans 29 prior days excluding today (see past29/day30Ts in refresh()) — but this
    // shifts whenever the user changes that setting, so the tooltip must too (Björn, 03.09.2026).
    const baselineDays = Math.max(0, (d.retentionDays || DEFAULT_RETENTION_DAYS) - 1);
    this._statRowNextGen(body, t('rowInput'),  stats.input,       maxVal, 'blue',   verdictFor(sv.input),       baselineDays);
    this._statRowNextGen(body, t('rowOutput'), stats.output,      maxVal, 'green',  verdictFor(sv.output),      baselineDays);
    this._statRowNextGen(body, t('rowCWrite'), stats.cacheCreate, maxVal, 'purple', verdictFor(sv.cacheCreate), baselineDays);
    this._statRowNextGen(body, t('rowCRead'),  stats.cacheRead,   maxVal, 'amber',  verdictFor(sv.cacheRead),   baselineDays);
  }

  // Deliberate copy of _statRow(), not the same function with a branch — keeps Classic's
  // _statRow() truly unmodified. Same label/value/log-scale-bar structure (no row restructure,
  // no extra height), plus an optional compact verdict glyph after the bar.
  _statRowNextGen(parent, label, value, max, color, verdict, baselineDays) {
    const row = parent.createEl('div', { cls: 'au-stat-row au-stat-row-ng' });
    row.createEl('span', { cls: 'au-stat-lbl', text: label });
    row.createEl('span', { cls: `au-stat-val au-text-${color}`, text: fmtTokens(value) });
    const wrap = row.createEl('div', { cls: 'au-mini-bar-wrap' });
    const bar  = wrap.createEl('div', { cls: `au-mini-bar au-bar-${color}` });
    const pct = (value > 0 && max > 0)
      ? (Math.log(1 + value) / Math.log(1 + max) * 100).toFixed(1)
      : 0;
    bar.style.width = pct + '%';
    // 'neutral' (no 29-day baseline yet, e.g. brand-new install) renders no glyph at all —
    // no basis to claim a verdict, better silent than a guess.
    if (verdict && verdict !== 'neutral') {
      const glyph = row.createEl('span', {
        cls:  `au-verdict au-verdict-${verdict}`,
        text: verdict === 'warn' ? '↑' : '●',
      });
      glyph.title = verdict === 'warn' ? t('verdictHigh', baselineDays) : t('verdictNormal', baselineDays);
    }
  }

  // 2x2 tile grid for 7 Days / N Days in NextGen mode (Björn, 28.08.2026 — these two periods
  // are read as "how am I trending", not "compare four token types", so a tile grid of summary
  // numbers says more at a glance than four raw bars). Same vocabulary as the Dashboard's
  // summary cards (Total/Calls/Active days/Avg per active day) so sidebar and Dashboard read
  // consistently — "active days" here means productive days, not calendar days, same principle
  // as everywhere else in the plugin since the 24.08.2026 active-day normalization.
  // KPI-card style (Björn, 01.09.2026, Nachschärfungsliste Punkt 6) — colored left border, bold
  // value, sparkline underneath, styled after the Dashboard's 5 KPI cards but using Obsidian
  // theme variables instead of the Dashboard's fixed dark-theme hex values (the Dashboard is a
  // standalone HTML file, the sidebar must keep working in any Obsidian theme). `series` is the
  // day-by-day data backing the sparklines — d.chart7 for the 7-Days section, d.periodSeries for
  // N-Days (see refresh()). `totalBadge` is optional and only ever passed for the 7-Days section's
  // Total Tokens tile (the community-requested outlier badge, reusing the same 29-day baseline
  // Today's spike badge already uses — see spikeRatioWeek in refresh()); N-Days deliberately never
  // gets one (comparing a 30–360 day average against a 29-day baseline isn't a clean comparison).
  _renderPeriodTiles(parent, key, title, stats, periodDays, activeDays, series, totalBadge) {
    if (stats.count === 0) return;
    const { body } = this._makeSection(parent, key, title);
    const total = stats.input + stats.output;
    const avgPerActiveDay = activeDays > 0 ? Math.round(total / activeDays) : 0;
    const grid = body.createEl('div', { cls: 'au-tile-grid' });
    const totalSeries = (series || []).map(x => (x.input || 0) + (x.output || 0));
    const callsSeries  = (series || []).map(x => x.reqs || 0);
    this._tileKpi(grid, {
      value: fmtTokens(total), label: t('tileTotal'), color: 'blue', badge: totalBadge,
      sparkline: sparklineSvgNG(totalSeries, 'var(--au-blue)'),
    });
    this._tileKpi(grid, {
      value: stats.count.toLocaleString('en-GB'), label: t('tileCalls'), color: 'green',
      sparkline: sparklineSvgNG(callsSeries, 'var(--au-green)'),
    });
    this._tileKpi(grid, {
      value: `${activeDays}/${periodDays}`, label: t('tileActiveDays'), color: 'purple',
      sparkline: sparkBarsSvg(callsSeries, 'var(--au-purple)'), // Balken-Histogramm, Björns Vorgabe
    });
    this._tileKpi(grid, {
      value: fmtTokens(avgPerActiveDay), label: t('tileAvgPerDay'), color: 'amber',
      sparkline: sparklineSvgNG(totalSeries, 'var(--au-amber)'), // gleiche Reihe wie Total Tokens, Björns Entscheidung
    });
  }

  _tileKpi(grid, { value, label, sparkline, color, badge }) {
    const tile = grid.createEl('div', { cls: 'au-tile au-tile-kpi' });
    tile.style.borderLeftColor = `var(--au-${color})`;
    tile.createEl('div', { cls: 'au-tile-lbl', text: label });
    tile.createEl('div', { cls: 'au-tile-val', text: value });
    if (sparkline) {
      const s = tile.createEl('div', { cls: 'au-tile-spark' });
      s.innerHTML = sparkline;
    }
    if (badge) {
      tile.createEl('span', { cls: `au-tile-badge au-verdict-${badge.verdict}`, text: badge.text });
    }
  }

  // ── Archive (v1.7) ───────────────────────────────────────────────
  // Writes a compact, human-readable daily summary to the vault — never the raw JSONL
  // transcripts. One file per calendar day, YAML frontmatter for machine-readable
  // aggregation (Obsidian's own metadataCache parses it, no custom parsing needed) plus
  // a small Markdown table for anyone who just opens the file to look.
  //
  // Backfills, not just "today": every refresh walks ALL days currently present in
  // entries30 (the live retentionDays read window), not only the current calendar day.
  // Any past day that doesn't have an archive file yet gets written once and then left
  // alone — past days are final, no need to re-read or re-diff them. Today's file keeps
  // being recomputed and only overwritten if its content actually changed.
  //
  // This covers two real gaps a "today only" version would have:
  //   - First install: the plugin's very first refresh archives whatever history is
  //     still on disk (up to retentionDays back), not just from that day forward.
  //   - Reopening after Obsidian was closed for a while: any day that happened in the
  //     meantime gets backfilled as long as Claude Code hasn't deleted its JSONL yet.
  // Only a day that Claude Code has already deleted before the plugin ever ran again
  // is unrecoverable — that's a hard physical limit, not a bug in this logic.
  async _archiveDays() {
    if (!this.data || this.plugin.settings.archiveEnabled === false) return;
    try {
      const entries = this.data.entries30 || [];
      if (entries.length === 0) return;

      const todayTs = dayStart(new Date());
      const byDay = new Map(); // dayTs -> entries[]
      for (const e of entries) {
        const dTs = dayStart(new Date(e.timestamp));
        if (!byDay.has(dTs)) byDay.set(dTs, []);
        byDay.get(dTs).push(e);
      }

      const folder = (this.plugin.settings.archivePath || 'Token Usage Archive').trim();
      if (!this.plugin.app.vault.getAbstractFileByPath(folder)) {
        try { await this.plugin.app.vault.createFolder(folder); } catch (e) { /* race with a previous refresh, ignore */ }
      }

      // Under normal daily use exactly one new file is created per run (today's fresh
      // entry) — that's routine and stays silent. More than one means a real backfill
      // just happened: first install (existing history archived at once) or reopening
      // after a gap (missed days caught up). That's the moment worth telling the user
      // about, once, rather than a Notice popping up on every single day forever.
      let newlyArchived = 0;

      // One-shot rebuild (v1.8): a past day's archive file is normally final, but when a NEW data
      // source is added (agent mode) the already-written totals are too low. Left alone they would
      // silently take over again the moment such a day ages out of the live window, looking like
      // the numbers dropped by themselves. Rebuilding is inherently limited to what byDay holds —
      // days still backed by complete live entries — so older files are never touched with
      // half-known data. Runs exactly once per tag, then reverts to the normal skip behaviour.
      const forceRewrite = this.plugin.settings.archiveRebuildDone !== ARCHIVE_REBUILD_TAG;

      for (const [dTs, dayEntries] of byDay) {
        const isToday  = dTs === todayTs;
        const dateStr  = new Date(dTs).toISOString().slice(0, 10);
        const filePath = `${folder}/${dateStr}.md`;
        const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);

        if (existing && !isToday && !forceRewrite) continue; // past day, already archived — final, skip

        const agg      = aggregate(dayEntries);
        const sessions = new Set(dayEntries.map(e => e.sessionId || 'unknown')).size;
        const modelCts = {};
        const modelTok = {}; // token volume per model — needed to redraw the daily chart from archived days alone
        // Vault/project breakdown (01.09.2026, two levels) — same rootLabel/projLabel keying as
        // _buildDayRange()'s live branch, so a vault's live and archived days merge into one row
        // instead of splitting once its data crosses the retention boundary.
        const rootTok = {};
        for (const e of dayEntries) {
          const f = modelFamily(e.model);
          modelCts[f] = (modelCts[f] || 0) + 1;
          modelTok[f] = (modelTok[f] || 0) + e.usage.input_tokens + e.usage.output_tokens;
          const rootLabel = vaultLabel(e.root);
          const projLabel = vaultLabel(e.cwd);
          const tok = e.usage.input_tokens + e.usage.output_tokens;
          if (!rootTok[rootLabel]) rootTok[rootLabel] = { total: 0, projects: {} };
          rootTok[rootLabel].total += tok;
          rootTok[rootLabel].projects[projLabel] = (rootTok[rootLabel].projects[projLabel] || 0) + tok;
        }
        const content = this._buildArchiveContent(dateStr, agg, sessions, modelCts, modelTok, rootTok);

        if (existing) {
          const current = await this.plugin.app.vault.read(existing);
          if (current !== content) await this.plugin.app.vault.modify(existing, content);
        } else {
          await this.plugin.app.vault.create(filePath, content);
          newlyArchived++;
        }
      }

      if (newlyArchived > 1) new obsidian.Notice(t('archiveBackfilled', newlyArchived));

      // Mark the rebuild as done only after the loop actually completed. On an exception we fall
      // into catch below without setting the flag, so the next refresh simply tries again rather
      // than leaving the archive half-migrated.
      if (forceRewrite) {
        this.plugin.settings.archiveRebuildDone = ARCHIVE_REBUILD_TAG;
        await this.plugin.saveSettings();
      }
    } catch (e) {
      console.error('Token Usage archive error:', e);
    }
  }

  _buildArchiveContent(dateStr, agg, sessions, modelCts, modelTok, rootTok) {
    const calls = agg.count;
    const lines = [];
    lines.push('---');
    lines.push('tags: [token-usage-archive]');
    lines.push(`date: ${dateStr}`);
    lines.push(`input: ${agg.input}`);
    lines.push(`output: ${agg.output}`);
    lines.push(`cacheCreate: ${agg.cacheCreate}`);
    lines.push(`cacheRead: ${agg.cacheRead}`);
    lines.push(`calls: ${calls}`);
    lines.push(`sessions: ${sessions}`);
    lines.push('models:');
    for (const [name, count] of Object.entries(modelCts).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${name}: ${count}`);
    }
    // Token volume per model — separate from call counts above, needed so the dashboard's
    // daily stacked-by-model chart can be redrawn from archived days without raw entries.
    lines.push('modelTokens:');
    for (const [name, tok] of Object.entries(modelTok || {}).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${name}: ${tok}`);
    }
    // Vault/project breakdown (01.09.2026, two levels) — rootTok is already keyed by display
    // label (see _archiveDays()), so archive files stay compact and human-readable instead of
    // full Windows paths as YAML keys. Quoted defensively since vault/project folder names are
    // arbitrary user text, unlike the fixed Haiku/Sonnet/Opus/Fable/Other enum above. Nested one
    // level deeper than modelTokens: root -> { project -> tokens } — see _computeProjectOverview()
    // for how the Dashboard/export reduce this back into a root-level total plus a project detail
    // breakdown.
    lines.push('byRoot:');
    for (const [rootLabel, data] of Object.entries(rootTok || {}).sort((a, b) => b[1].total - a[1].total)) {
      lines.push(`  "${rootLabel.replace(/"/g, '\\"')}":`);
      for (const [projLabel, tok] of Object.entries(data.projects || {}).sort((a, b) => b[1] - a[1])) {
        lines.push(`    "${projLabel.replace(/"/g, '\\"')}": ${tok}`);
      }
    }
    lines.push('---');
    lines.push('');
    lines.push(`# Token Usage — ${dateStr}`);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    lines.push(`| Input | ${fmtTokens(agg.input)} |`);
    lines.push(`| Output | ${fmtTokens(agg.output)} |`);
    lines.push(`| Cache Write | ${fmtTokens(agg.cacheCreate)} |`);
    lines.push(`| Cache Read | ${fmtTokens(agg.cacheRead)} |`);
    lines.push(`| API Calls | ${calls.toLocaleString('en-GB')} |`);
    lines.push(`| Sessions | ${sessions} |`);
    lines.push('');
    lines.push('**Models:**');
    lines.push('');
    lines.push('| Model | Calls | % |');
    lines.push('|---|---|---|');
    for (const [name, count] of Object.entries(modelCts).sort((a, b) => b[1] - a[1])) {
      const pct = calls > 0 ? Math.round(count / calls * 100) : 0;
      lines.push(`| ${name} | ${count.toLocaleString('en-GB')} | ${pct}% |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  _readArchiveDays(beforeTs) {
    // Reads pre-aggregated daily archive files strictly before `beforeTs` (days no longer
    // covered by live JSONL). Returns objects shaped exactly like the live day-bucket
    // objects built in _buildDayRange(), so both sources merge into one flat array.
    const folder = (this.plugin.settings.archivePath || 'Token Usage Archive').trim();
    const folderFile = this.plugin.app.vault.getAbstractFileByPath(folder);
    if (!folderFile || !folderFile.children) return [];

    const out = [];
    for (const file of folderFile.children) {
      if (!file.path || !file.path.endsWith('.md')) continue;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const fm = cache && cache.frontmatter;
      if (!fm || !fm.date) continue;
      const dTs = dayStart(new Date(fm.date));
      if (dTs >= beforeTs) continue; // still covered by live data — avoid double counting
      const mt = fm.modelTokens || {};
      // byRoot (01.09.2026, two levels): old archive files predating this feature, or the very
      // short-lived flat byProject: format from earlier today, simply have fm.byRoot ===
      // undefined here — safely defaulted to {}, no migration needed (a past day's file is never
      // rewritten once created; today's file self-heals to the new format on the next refresh).
      // YAML gives us the raw { root: { project: tokens } } shape; normalize it to the same
      // { root: { total, projects } } shape _buildDayRange()'s live branch produces, so both
      // sources are interchangeable for _computeProjectOverview() and the client-side matrix.
      const rawByRoot = fm.byRoot || {};
      const br = {};
      for (const [rootLabel, projMap] of Object.entries(rawByRoot)) {
        const projects = projMap && typeof projMap === 'object' ? projMap : {};
        const total = Object.values(projects).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
        br[rootLabel] = { total, projects };
      }
      out.push({
        ts:    dTs,
        label: new Date(dTs).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
        Haiku:  mt.Haiku  || 0,
        Sonnet: mt.Sonnet || 0,
        Opus:   mt.Opus   || 0,
        Fable:  mt.Fable  || 0,
        Other:  mt.Other  || 0,
        input:       fm.input  || 0,
        output:      fm.output || 0,
        total:       (fm.input || 0) + (fm.output || 0),
        reqs:        fm.calls || 0,
        cacheCreate: fm.cacheCreate || 0,
        cacheRead:   fm.cacheRead || 0,
        byRoot:      br,
      });
    }
    return out;
  }

  _buildDayRange(totalDays) {
    // Thin wrapper — the contiguous "last N days ending today" range every caller used to
    // get directly. Actual live+archive merge logic now lives in _buildDaysBetween() so the
    // NextGen calendar can request arbitrary month windows without duplicating it.
    return this._buildDaysBetween(daysAgoTs(totalDays - 1), daysAgoTs(0));
  }

  _buildDaysBetween(fromTs, toTs) {
    // Unified day series spanning [dayStart(fromTs) .. dayStart(toTs)] inclusive, ascending
    // (v1.7 reporting switch) — live JSONL for days still within retentionDays, pre-aggregated
    // archive files for everything older. A day with neither is a real gap (Claude Code already
    // deleted it before the plugin ever archived it) and shows as zero rather than being
    // skipped, so the chart's x-axis stays continuous.
    const d = this.data;
    const entries       = d.entries30 || [];
    const retentionDays = d.retentionDays || 30;
    const liveFloorTs   = daysAgoTs(retentionDays);

    const archiveByTs = new Map(this._readArchiveDays(liveFloorTs).map(a => [a.ts, a]));

    // Group live entries by calendar day once — O(N) — instead of filtering the whole
    // array per day (O(days × N)). Matters now that refresh() calls this on every tick
    // (for the sidebar's period total), not just on manual Dashboard/Report generation.
    const liveByDay = new Map();
    for (const e of entries) {
      const dTs = dayStart(new Date(e.timestamp));
      if (dTs < liveFloorTs) continue;
      if (!liveByDay.has(dTs)) liveByDay.set(dTs, []);
      liveByDay.get(dTs).push(e);
    }

    const out = [];
    // Cursor at local midnight, advanced with setDate(+1) so it stays on local midnight
    // across DST boundaries (same guarantee daysAgoTs() gave the old index loop).
    const cursor = new Date(dayStart(fromTs));
    const endTs  = dayStart(toTs);
    while (cursor.getTime() <= endTs) {
      const from = cursor.getTime();
      cursor.setDate(cursor.getDate() + 1);
      if (from < liveFloorTs) {
        out.push(archiveByTs.get(from) || {
          ts: from,
          label: new Date(from).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
          Haiku: 0, Sonnet: 0, Opus: 0, Fable: 0, Other: 0,
          input: 0, output: 0, total: 0, reqs: 0, cacheCreate: 0, cacheRead: 0,
          byRoot: {},
        });
        continue;
      }
      const dayE = liveByDay.get(from) || [];
      const byM  = { Haiku: 0, Sonnet: 0, Opus: 0, Fable: 0, Other: 0 };
      // Vault/project breakdown (01.09.2026, revised to two levels) — byRoot[rootLabel] = { total,
      // projects: { projLabel: tokens } }. rootLabel = vaultLabel(e.root) (stable session-start
      // anchor, see parseUsageFromFile()), projLabel = vaultLabel(e.cwd) (can drift within a
      // session). Same key type the archive branch above already uses (_buildArchiveContent()),
      // so a vault's live and archived days merge into one row in _computeProjectOverview()
      // instead of splitting.
      const byRoot = {};
      let input = 0, output = 0, reqs = 0, cacheCreate = 0, cacheRead = 0;
      for (const e of dayE) {
        const f = modelFamily(e.model);
        byM[f]      += e.usage.input_tokens + e.usage.output_tokens;
        input       += e.usage.input_tokens  || 0;
        output      += e.usage.output_tokens || 0;
        cacheCreate += e.usage.cache_creation_input_tokens || 0;
        cacheRead   += e.usage.cache_read_input_tokens     || 0;
        reqs++;
        const rootLabel = vaultLabel(e.root);
        const projLabel = vaultLabel(e.cwd);
        const tok = e.usage.input_tokens + e.usage.output_tokens;
        if (!byRoot[rootLabel]) byRoot[rootLabel] = { total: 0, projects: {} };
        byRoot[rootLabel].total += tok;
        byRoot[rootLabel].projects[projLabel] = (byRoot[rootLabel].projects[projLabel] || 0) + tok;
      }
      out.push({
        ts: from,
        label: new Date(from).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
        ...byM, total: Object.values(byM).reduce((a, b) => a + b, 0),
        input, output, reqs, cacheCreate, cacheRead,
        byRoot,
      });
    }
    return out;
  }

  // NextGen calendar (v1.8) — always a fixed 6×7 = 42-cell grid, Monday-first. Cells outside
  // the target month are filled from the adjacent months and flagged `outside`, so the grid
  // height never changes between months regardless of length or start weekday. Reuses
  // _buildDaysBetween() (no second copy of the live+archive merge).
  _buildMonthDays(year, month) {
    const first = new Date(year, month, 1);
    const startDow = (first.getDay() + 6) % 7; // 0 = Monday .. 6 = Sunday
    const gridStart = new Date(year, month, 1 - startDow);
    const gridEnd   = new Date(gridStart); gridEnd.setDate(gridEnd.getDate() + 41);
    const todayTs   = dayStart(new Date());
    return this._buildDaysBetween(dayStart(gridStart), dayStart(gridEnd)).map(day => {
      const dt = new Date(day.ts);
      return {
        ...day,
        dom:      dt.getDate(),
        outside:  dt.getMonth() !== month,
        isToday:  day.ts === todayTs,
        isFuture: day.ts > todayTs,
      };
    });
  }

  // Vault/project overview (01.09.2026) — reduces a _buildDayRange() series (each day already
  // carrying byProject, raw-cwd-keyed) into one row per vault. Shared by the Dashboard's Projects
  // tab and the Vault_Token_Usage_Projects.md export so the two numbers can never drift apart —
  // same reasoning as _buildReportPayload() existing purely to keep the Reports tab and the main
  // report in sync.
  // Two levels (01.09.2026, revised): each returned row is a Vault/Root, with a nested `projects`
  // array for the sub-folder detail (used only by the Vault_Token_Usage_Projects.md export — the
  // Dashboard deliberately ignores `projects` and shows Root rows only, see renderProjects()).
  _computeProjectOverview(allDays) {
    const acc = {}; // rootLabel -> { label, tokens, activeDays, firstTs, lastTs, projects: { projLabel -> tokens } }
    for (const day of allDays) {
      for (const [rootLabel, data] of Object.entries(day.byRoot || {})) {
        if (!acc[rootLabel]) acc[rootLabel] = { label: rootLabel, tokens: 0, activeDays: 0, firstTs: day.ts, lastTs: day.ts, projects: {} };
        const a = acc[rootLabel];
        a.tokens += data.total || 0;
        a.activeDays++;
        if (day.ts < a.firstTs) a.firstTs = day.ts;
        if (day.ts > a.lastTs) a.lastTs = day.ts;
        for (const [projLabel, tok] of Object.entries(data.projects || {})) {
          a.projects[projLabel] = (a.projects[projLabel] || 0) + tok;
        }
      }
    }
    const roots = Object.values(acc);
    const grand = roots.reduce((s, r) => s + r.tokens, 0);
    return roots.map(r => ({
      ...r,
      pct: grand > 0 ? Math.round(r.tokens / grand * 100) : 0,
      // The sub-project entry whose label exactly matches the root's own label represents
      // "activity directly at the root, no subfolder drift" — it's already fully counted in the
      // root row itself, so it's dropped here to avoid a redundant duplicate detail line.
      projects: Object.entries(r.projects)
        .filter(([label]) => label !== r.label)
        .map(([label, tokens]) => ({ label, tokens, pct: r.tokens > 0 ? Math.round(tokens / r.tokens * 100) : 0 }))
        .sort((a, b) => b.tokens - a.tokens),
    })).sort((a, b) => b.tokens - a.tokens);
  }

  // ── Report ────────────────────────────────────────────────────
  async _generateReport() {
    if (!this.data) { new obsidian.Notice(t('noData')); return; }
    const content    = this._buildReportContent();
    const reportPath = (this.plugin.settings.reportPath || 'Token Usage Report.md').trim();
    try {
      const existing = this.plugin.app.vault.getAbstractFileByPath(reportPath);
      if (existing) await this.plugin.app.vault.modify(existing, content);
      else          await this.plugin.app.vault.create(reportPath, content);
      const file = this.plugin.app.vault.getAbstractFileByPath(reportPath);
      if (file) await this.plugin.app.workspace.getLeaf(true).openFile(file);
      new obsidian.Notice(t('reportCreated'));
    } catch(e) {
      new obsidian.Notice(t('reportFailed') + e.message);
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

    // v1.7 reporting switch: d.day30 is already the full report-period aggregate (live +
    // archive blended, computed once in refresh() — see there for why this differs from
    // d.retentionDays). Reused here so the report and the sidebar never disagree.
    const reportPeriodDays = d.reportPeriodDays || 30;
    addPeriod(`${reportPeriodDays} Days`, d.day30);

    const dist7 = modelDistribution(d.entries7);
    if (dist7.length > 0) {
      lines.push('## Models (7 Days)', '', '| Model | Calls | % | Tokens |', '|---|---|---|---|');
      for (const m of dist7) { lines.push(`| ${m.name} | ${m.count} | ${m.pct}% | ${fmt(m.tokens)} |`); }
      lines.push('');
    }

    const tc = d.day30.cacheCreate, tr = d.day30.cacheRead;
    lines.push(`## Cache Efficiency (${reportPeriodDays} Days)`, '', '| | |', '|---|---|');
    lines.push(`| Cache Write | ${fmt(tc)} |`);
    lines.push(`| Cache Read | ${fmt(tr)} |`);
    lines.push(`| Reuse Factor (Read/Write) | ${tc > 0 ? (tr / tc).toFixed(1) : 0}x |`, '');
    if (reportPeriodDays > (d.retentionDays || 30)) {
      const activeInPeriod = this._buildDayRange(reportPeriodDays).filter(x => x.reqs > 0).length;
      lines.push(`> ${activeInPeriod} of ${reportPeriodDays} days had activity — the rest were quiet days (weekends, time off) or predate what's archived.`, '');
    }

    lines.push('## 7-Day Overview', '', '| Date | Input | Output | Total |', '|---|---|---|---|');
    for (const day of d.chart7) {
      lines.push(`| ${day.date}${day.isToday ? ' (today)' : ''} | ${fmt(day.input)} | ${fmt(day.output)} | ${fmt(day.total)} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  // ── Vault/Project Report (01.09.2026) ──────────────────────────
  // Separate export from the main report — which vault/project consumed how many tokens, and
  // when. Same write/create/modify/open pattern as _generateReport() above, deliberately
  // duplicated rather than parameterized: the two files serve different audiences (personal usage
  // overview vs. a per-project/client breakdown power users may hand off), so keeping them
  // independent avoids one growing awkward branches to serve the other's shape.
  async _generateVaultProjectReport() {
    if (!this.data) { new obsidian.Notice(t('noData')); return; }
    const content    = this._buildVaultReportContent();
    const reportPath = (this.plugin.settings.vaultReportPath || 'Vault_Token_Usage_Projects.md').trim();
    try {
      const existing = this.plugin.app.vault.getAbstractFileByPath(reportPath);
      if (existing) await this.plugin.app.vault.modify(existing, content);
      else          await this.plugin.app.vault.create(reportPath, content);
      const file = this.plugin.app.vault.getAbstractFileByPath(reportPath);
      if (file) await this.plugin.app.workspace.getLeaf(true).openFile(file);
      new obsidian.Notice(t('vaultReportCreated'));
    } catch (e) {
      new obsidian.Notice(t('vaultReportFailed') + e.message);
    }
  }

  _buildVaultReportContent() {
    const d   = this.data;
    const now = d.updatedAt;
    const ts  = now.toLocaleString('en-GB');
    const fmt = (n) => fmtTokens(n);
    const reportPeriodDays = d.reportPeriodDays || 30;
    const days = this._buildDayRange(reportPeriodDays);
    const overview = this._computeProjectOverview(days);
    const lines = [];

    lines.push('---');
    lines.push('tags: [plugin, token-usage, vault-report]');
    lines.push(`date: ${now.toISOString().slice(0, 10)}`);
    lines.push(`updated: "${ts}"`);
    lines.push('---', '', '# Vault Token Usage — Projects', '');
    lines.push(`> Created by Token Usage Plugin v${this.plugin.manifest.version} on ${ts}. Covers the last ${reportPeriodDays} days (Settings → Report period).`, '');

    lines.push('## Overview', '');
    if (overview.length > 0) {
      lines.push('| Vault | Tokens | % | Active Days | First Active | Last Active |', '|---|---|---|---|---|---|');
      for (const p of overview) {
        const first = new Date(p.firstTs).toLocaleDateString('en-GB');
        const last  = new Date(p.lastTs).toLocaleDateString('en-GB');
        lines.push(`| ${p.label} | ${fmt(p.tokens)} | ${p.pct}% | ${p.activeDays} | ${first} | ${last} |`);
      }
    } else {
      lines.push('No vault data recorded yet.');
    }
    lines.push('');

    // Vault/Root level only, same as the Dashboard's Daily Detail matrix — deliberately NOT per
    // sub-project/subfolder here either.
    const labels = Array.from(new Set(days.flatMap(day => Object.keys(day.byRoot || {})))).sort();
    lines.push('## Daily Detail', '');
    if (labels.length > 0) {
      lines.push(`| Date | ${labels.join(' | ')} | Total |`, `|---|${labels.map(() => '---').join('|')}|---|`);
      for (const day of days) {
        const cells = labels.map(l => { const r = (day.byRoot || {})[l]; return fmt(r ? r.total : 0); });
        lines.push(`| ${day.label} | ${cells.join(' | ')} | ${fmt(day.total)} |`);
      }
    } else {
      lines.push('No vault data recorded yet.');
    }
    lines.push('');

    // Project Detail (01.09.2026) — the one place the fine-grained sub-project/subfolder
    // breakdown still appears (deliberately NOT in the Dashboard, see renderProjects()). Meant
    // for power users who want to dig further, e.g. by pulling this table into Excel. One
    // sub-section per root that actually has sub-project activity (roots with none — i.e. all
    // activity happened directly at the root, no cwd drift — are skipped, nothing to add).
    const rootsWithProjects = overview.filter(p => p.projects.length > 0);
    if (rootsWithProjects.length > 0) {
      lines.push('## Project Detail', '');
      lines.push('> Sub-folder breakdown within each vault — reflects `cwd` drift during sessions (e.g. a tool call briefly working in a subfolder), not necessarily deliberate per-project effort. For a spreadsheet-friendly pull, copy the tables below into Excel.', '');
      for (const root of rootsWithProjects) {
        lines.push(`### ${root.label}`, '', '| Project | Tokens | % of vault |', '|---|---|---|');
        for (const p of root.projects) {
          lines.push(`| ${p.label} | ${fmt(p.tokens)} | ${p.pct}% |`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // ── Dashboard ─────────────────────────────────────────────────
  async _generateDashboard() {
    if (!this.data) { new obsidian.Notice(t('noData')); return; }
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
      new obsidian.Notice(t('dashOpened'));
    } catch(e) {
      new obsidian.Notice(t('dashFailed') + e.message);
    }
  }

  _buildDashboard() {
    const d       = this.data;
    const entries = d.entries30; // live JSONL only — up to retentionDays back
    const now     = d.updatedAt;

    // v1.7 reporting switch, extended in the Phase 1 UI relaunch: the dashboard used to bake
    // one fixed report period (30d/90d/6mo/1yr) into the generated HTML — changing it meant
    // regenerating the file. Now the largest possible day range (360d, live JSONL blended with
    // the daily archive exactly as before) is always embedded, and the header dropdown re-slices
    // it client-side — instant, no regeneration. `reportPeriodDays` only picks which slice shows
    // first. Model donut, request-size histogram, and top sessions deliberately stay scoped to
    // `entries` (the live window only) — session- and request-level detail isn't in the archive
    // by design (aggregates only, see Archive section in README), so those three views can't
    // meaningfully extend beyond it anyway; the dashboard labels them accordingly.
    const reportPeriodDays = d.reportPeriodDays || 30;
    const allDays = this._buildDayRange(360);
    const days30  = allDays.slice(-reportPeriodDays); // same slice every Node-side calc below used before

    const dist30           = modelDistribution(entries);
    // Cache totals sum the default report-period series (days30) — used for Node-side figures
    // (Focus Score inputs); the client recomputes the same sum per-slice whenever the period
    // dropdown changes, from the same allDays array, so the two can never drift apart.
    const totalCacheCreate = days30.reduce((s, x) => s + (x.cacheCreate || 0), 0);
    const totalCacheRead   = days30.reduce((s, x) => s + (x.cacheRead   || 0), 0);
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

    // d.day30 is already this exact sum (computed once in refresh(), see there) — reused
    // here instead of re-summing days30, so the cards and the underlying data can't drift
    // apart even if something between refresh() and this call ever changes the setting.
    const totalTok    = d.day30.input + d.day30.output;
    const totalReqs   = d.day30.count;
    const activeDays  = days30.filter(x => x.reqs > 0).length;
    // Tokens per day actually worked, not per calendar day — a vacation gap in the report
    // period must not silently drag this average down. Requested explicitly (Björn, 24.08.2026).
    const avgPerActiveDay = activeDays > 0 ? Math.round(totalTok / activeDays) : 0;

    // ── Rate Limit Analysis ─────────────────────────────────────────
    // Deduplicate type-aware:
    //   weekly  → max 1 per billing week (once hit, same limit until Sunday 18:00)
    //   session → 15-min window (parallel sessions can fire within seconds of each other)
    // In both cases the oldest event is kept — it is the causal one.
    const rlRaw = (d.rateLimitEvents || []).slice().sort((a, b) => a.timestamp - b.timestamp);
    const rlDeduped = [];
    const seenBillingWeeks = new Set();
    let lastSessionTs = 0;
    for (const ev of rlRaw) {
      if (ev.type === 'weekly') {
        const wk = billingWeekStart(ev.timestamp);
        if (!seenBillingWeeks.has(wk)) { seenBillingWeeks.add(wk); rlDeduped.push(ev); }
      } else {
        if (ev.timestamp - lastSessionTs > 15 * 60_000) { rlDeduped.push(ev); lastSessionTs = ev.timestamp; }
      }
    }
    // Compute token metrics at each rate-limit event:
    //   tok5h    — 5h rolling window (relevant for session-limit hits)
    //   tokWeek  — billing-week total up to the event (relevant for weekly-limit hits)
    const entries30sorted = d.entries30.slice().sort((a, b) => a.timestamp - b.timestamp);
    const rlEvents = rlDeduped.map(ev => {
      const wStart = ev.timestamp - 5 * 3_600_000;
      const tok5h  = entries30sorted
        .filter(e => e.timestamp >= wStart && e.timestamp <= ev.timestamp)
        .reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
      let tokWeek = 0;
      if (ev.type === 'weekly') {
        const wkStart = billingWeekStart(ev.timestamp);
        tokWeek = entries30sorted
          .filter(e => e.timestamp >= wkStart && e.timestamp <= ev.timestamp)
          .reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
      }
      return Object.assign({}, ev, { tok5h, tokWeek });
    });
    // Session limit estimate — use events with enough context (> 50 K = window not nearly empty)
    const sessHits = rlEvents.filter(r => r.type === 'session' && r.tok5h > 50_000);
    const rlSessionEst = sessHits.length > 0 ? {
      n:      sessHits.length,
      min:    Math.min.apply(null, sessHits.map(r => r.tok5h)),
      max:    Math.max.apply(null, sessHits.map(r => r.tok5h)),
      median: sessHits.map(r => r.tok5h).sort((a, b) => a - b)[Math.floor(sessHits.length / 2)],
    } : null;
    // Billing week buckets — Sunday 16:00 UTC = 18:00 CEST boundary. billingWeekStart() is now
    // module-level (Phase 0 of the UI relaunch), shared with computeWeekStatus() below.
    const curWkStart = billingWeekStart(now.getTime());
    const weekBuckets = [];
    for (let i = 5; i >= 0; i--) {
      const wStart = curWkStart - i * 7 * 86_400_000;
      const wEnd   = wStart + 7 * 86_400_000;
      const wTok   = entries30sorted
        .filter(e => e.timestamp >= wStart && e.timestamp < wEnd)
        .reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
      const hitWeekly = rlEvents.some(r => r.type === 'weekly' && r.timestamp >= wStart && r.timestamp < wEnd);
      const wLabel = new Date(wStart).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })
        + '–' + new Date(wEnd - 86_400_000).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
      weekBuckets.push({ label: wLabel, tokens: wTok, hitWeekly });
    }
    const weeklyHitWks = weekBuckets.filter(w => w.hitWeekly && w.tokens > 0);
    const weeklyLimitEst = weeklyHitWks.length > 0
      ? Math.min.apply(null, weeklyHitWks.map(w => w.tokens))
      : null;

    const rateLimitPayload = {
      events:       rlEvents.slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 30),
      weeks:        weekBuckets,
      sessionEst:   rlSessionEst,
      weeklyEst:    weeklyLimitEst,
      weeklyHits:   weeklyHitWks.length,
      totalSession: rlEvents.filter(r => r.type === 'session').length,
      totalWeekly:  rlEvents.filter(r => r.type === 'weekly').length,
    };

    // ── Week Status (Phase 1) ─────────────────────────────────────
    const weekStatus = computeWeekStatus(entries30sorted, now, weeklyLimitEst, avgPerActiveDay);

    // ── Focus Score (Phase 1) ─────────────────────────────────────
    const focusScore = computeFocusScore(sessMap, reuseRatio, activeDays, totalReqs);

    // ── Reports tab payload (Phase 1) — mirrors _buildReportContent()'s fields exactly, as
    // plain JSON instead of Markdown. The dashboard runs as a static file in the system browser
    // (shell.openPath(), see _generateDashboard() below) with no channel back into Obsidian, so
    // the Reports tab can't call the existing report generator — it renders the same numbers
    // as its own HTML view instead.
    const reportPayload = this._buildReportPayload();

    const safeJson = JSON.stringify({
      allDays, defaultPeriod: reportPeriodDays, liveWindowDays: d.retentionDays || 30,
      dist30, hist, sessions: topSess,
      rateLimit: rateLimitPayload,
      weekStatus, focusScore,
      report: reportPayload,
      projects: this._computeProjectOverview(allDays),
    });

    return this._dashHtml({
      generated: now.toLocaleString('en-GB'),
      version:   this.plugin.manifest.version,
      safeJson,
    });
  }

  // Reports-tab data — same source fields as _buildReportContent(), reshaped into plain JSON
  // (numbers pre-formatted with fmtTokens, same as the Markdown report) for the dashboard's
  // client-side renderer. Kept as a separate method so the Markdown report path is untouched.
  _buildReportPayload() {
    const d   = this.data;
    const fmt = (n) => fmtTokens(n);
    const la  = d.lastAction;
    const w   = d.window5h;
    const reportPeriodDays = d.reportPeriodDays || 30;
    const dist7 = modelDistribution(d.entries7);
    const activeInPeriod = reportPeriodDays > (d.retentionDays || 30)
      ? this._buildDayRange(reportPeriodDays).filter(x => x.reqs > 0).length
      : null;
    const periods = [
      { title: 'This Session', stats: d.session },
      { title: 'Today', stats: d.today },
      { title: '7 Days', stats: d.day7 },
      { title: `${reportPeriodDays} Days`, stats: d.day30 },
    ].filter(p => p.stats.count > 0).map(p => ({
      title: p.title,
      input: fmt(p.stats.input), output: fmt(p.stats.output),
      cacheCreate: fmt(p.stats.cacheCreate), cacheRead: fmt(p.stats.cacheRead),
      calls: p.stats.count,
    }));
    return {
      lastAction: la ? {
        model: la.model,
        timestamp: new Date(la.timestamp).toLocaleString('en-GB'),
        input: fmt(la.usage.input_tokens), output: fmt(la.usage.output_tokens),
        cacheCreate: fmt(la.usage.cache_creation_input_tokens), cacheRead: fmt(la.usage.cache_read_input_tokens),
      } : null,
      window5h: w.agg.count > 0 ? {
        input: fmt(w.agg.input), output: fmt(w.agg.output),
        cacheCreate: fmt(w.agg.cacheCreate), cacheRead: fmt(w.agg.cacheRead),
        total: fmt(w.total),
        resetsIn: w.oldest ? fmtDuration(Math.max(0, w.oldest + 5 * 3_600_000 - Date.now())) : null,
      } : null,
      periods,
      models7: dist7.map(m => ({ name: m.name, count: m.count, pct: m.pct, tokens: fmt(m.tokens) })),
      cache: {
        write: fmt(d.day30.cacheCreate), read: fmt(d.day30.cacheRead),
        reuse: d.day30.cacheCreate > 0 ? (d.day30.cacheRead / d.day30.cacheCreate).toFixed(1) : '0',
        periodDays: reportPeriodDays, activeInPeriod,
      },
      chart7: (d.chart7 || []).map(x => ({ date: x.date, isToday: x.isToday, input: fmt(x.input), output: fmt(x.output), total: fmt(x.total) })),
    };
  }

  _dashHtml({ generated, version, safeJson }) {
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
header{margin-bottom:20px;display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}
.logo-header{display:flex;align-items:center;gap:8px}
header h1{font-size:22px;font-weight:700;letter-spacing:-0.02em;background:linear-gradient(120deg,#4A90D9 0%,#9B5DE5 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.meta{font-size:11px;color:#64748b;margin-top:4px}
.hdr-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tabs{display:flex;gap:4px;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:2px}
.tab-btn{background:none;border:none;color:#94a3b8;font-size:11px;font-weight:600;padding:5px 12px;border-radius:4px;cursor:pointer;font-family:inherit}
.tab-btn.active{background:#334155;color:#f1f5f9}
select#periodSel{background:#1e293b;border:1px solid #334155;color:#e2e8f0;font-size:11px;font-weight:600;padding:5px 8px;border-radius:6px;font-family:inherit;cursor:pointer}
.kpi-row{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}
.kpi-card{background:#1e293b;border:1px solid #334155;border-left:3px solid #64748b;border-radius:8px;padding:12px 14px;min-height:104px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.kpi-label{font-size:9.5px;color:#64748b;text-transform:uppercase;letter-spacing:.06em}
.kpi-val{font-size:18px;font-weight:700;color:#f1f5f9;font-variant-numeric:tabular-nums;margin-top:2px}
.kpi-sub{font-size:10px;color:#94a3b8;margin-top:2px}
.kpi-badge{display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;margin-top:6px}
.spark{display:block;flex-shrink:0}
.focus-mini{margin-top:6px;display:flex;flex-direction:column;gap:3px}
.focus-mini-row{display:flex;align-items:center;gap:4px}
.focus-mini-track{flex:1;height:3px;background:#334155;border-radius:2px;overflow:hidden}
.focus-mini-fill{height:100%;border-radius:2px}
.focus-mini-lbl{font-size:8px;color:#64748b;width:28px}
.week-card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin-bottom:20px}
.week-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.week-hdr h2{font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em}
.week-verdict{font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px}
.week-bar{display:flex;gap:6px;margin-bottom:10px}
.week-day{flex:1;height:40px;border-radius:5px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:9px;color:#f8fafc;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.week-day.future{background:#1e293b!important;border:1px dashed #334155;color:#475569;text-shadow:none}
.week-day.current{outline:2px solid #f1f5f9;outline-offset:1px}
.week-foot{font-size:11px;color:#94a3b8;line-height:1.6}
.tabpane{display:none}
.tabpane.active{display:block}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:14px 16px;transition:border-color .25s}
.cv{font-size:22px;font-weight:700;color:#f1f5f9;font-variant-numeric:tabular-nums}
.cl{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-top:4px}
.cb{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin-bottom:16px}
.cb h2{font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}
.live-note{font-weight:400;text-transform:none;letter-spacing:0;color:#475569}
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
.report-section{margin-bottom:16px}
/* Projects Overview — sub-project detail (v1.8) */
.proj-toggle{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#cbd5e1;margin-bottom:6px;cursor:pointer;user-select:none}
.proj-toggle input{cursor:pointer}
.proj-detail-note{font-size:11px;color:#64748b;line-height:1.5;margin:2px 0 12px}
.proj-vault-row.has-sub td:first-child{cursor:pointer}
.proj-caret{display:inline-block;width:13px;color:#4A90D9;font-size:11px}
.lead-spacer{display:inline-block;width:13px}
.proj-subcount{color:#64748b;font-weight:400;font-size:11px;margin-left:7px}
.proj-subrow td{background:rgba(74,144,217,.055);font-size:11px;color:#94a3b8;border-bottom:1px solid #182234}
.proj-subrow td:first-child{padding-left:38px;position:relative;color:#cbd5e1}
.proj-subrow td:first-child::before{content:"";position:absolute;left:22px;top:-8px;height:18px;width:9px;border-left:1px solid #475569;border-bottom:1px solid #475569}
.proj-subrow:hover td{background:rgba(74,144,217,.1)}
.proj-subrow .sub-muted{color:#475569}
.proj-other-row td{color:#64748b;font-style:italic}
@media(max-width:900px){.kpi-row{grid-template-columns:repeat(2,1fr)}}
@media(max-width:700px){.cards{grid-template-columns:1fr 1fr}.crow{grid-template-columns:1fr}.cache-cards{grid-template-columns:1fr}.kpi-row{grid-template-columns:1fr}}
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
      <div class="meta">Snapshot generated ${generated} &nbsp;·&nbsp; Plugin v${version} &nbsp;·&nbsp; <a href="https://www.langeatn.de/media/token-usage/" target="_blank" rel="noopener" style="color:#C9A227;text-decoration:none;">Help &amp; Glossary ↗</a></div>
    </div>
    <div class="hdr-right">
      <div class="tabs">
        <button class="tab-btn active" id="tabBtnDash" onclick="showTab('dash')">Dashboard</button>
        <button class="tab-btn" id="tabBtnReports" onclick="showTab('reports')">Reports</button>
        <button class="tab-btn" id="tabBtnProjects" onclick="showTab('projects')">Projects</button>
      </div>
      <select id="periodSel" onchange="applyPeriod(this.value)">
        <option value="30">30 days</option>
        <option value="60">60 days</option>
        <option value="180">6 months</option>
        <option value="360">12 months</option>
      </select>
    </div>
  </header>

  <div id="paneDash" class="tabpane active">
    <div class="kpi-row" id="kpiRow"></div>

    <div class="week-card">
      <div class="week-hdr">
        <h2>This billing week</h2>
        <span class="week-verdict" id="weekVerdict"></span>
      </div>
      <div class="week-bar" id="weekBar"></div>
      <div class="week-foot" id="weekFoot"></div>
    </div>

    <div class="cards" id="summaryCards"></div>

    <div class="cb">
      <h2 id="dailyChartTitle">Daily token usage (by model)</h2>
      <canvas id="cDaily" height="110"></canvas>
    </div>
    <div class="crow">
      <div class="cb"><h2>Model distribution (calls) <span class="live-note" id="liveNote1"></span></h2><canvas id="cModel" height="220"></canvas></div>
      <div class="cb"><h2>Tokens per request <span class="live-note" id="liveNote2"></span></h2><canvas id="cDist" height="220"></canvas></div>
    </div>
    <div class="cb">
      <h2>Top sessions by token volume <span class="live-note" id="liveNote3"></span></h2>
      <table><thead><tr><th>Session</th><th>Start</th><th>Tokens</th><th>Calls</th><th>Model</th></tr></thead>
      <tbody id="tSess"></tbody></table>
    </div>
    <div class="cb">
      <h2>Rate limits</h2>
      <div id="rlEst" style="margin-bottom:14px;padding:10px 14px;background:rgba(255,255,255,0.03);border-radius:6px;border-left:3px solid #52B788;font-size:12px;line-height:1.7;color:#cbd5e1"></div>
      <table><thead><tr><th>Date</th><th>Time</th><th>Type</th><th>Tokens (inp+out)</th><th>Resets at</th></tr></thead>
      <tbody id="tRL"></tbody></table>
    </div>
    <div class="cb">
      <h2>Weekly consumption — billing week (Sun 18:00 → Sun 18:00 Europe/Berlin)</h2>
      <canvas id="cWeekly" height="90"></canvas>
    </div>
    <div class="cb">
      <h2 id="cacheCardsTitle">Cache efficiency &amp; usage patterns</h2>
      <div class="cache-cards">
        <div class="card"><div class="cv" id="ccCreate">—</div><div class="cl">Cache write</div></div>
        <div class="card"><div class="cv" id="ccRead">—</div><div class="cl">Cache read</div></div>
        <div class="card" id="ccRatioCard"><div class="cv" id="ccRatio">—</div><div class="cl">Reuse factor (read ÷ write)</div></div>
      </div>
      <canvas id="cCache" height="90" style="margin-bottom:14px"></canvas>
      <div class="cache-explain" id="ccExplain"></div>
    </div>
  </div>

  <div id="paneReports" class="tabpane"></div>
  <div id="paneProjects" class="tabpane"></div>
</div>
<script>
var D=${safeJson};
var C={Haiku:'#06B6D4',Sonnet:'#4A90D9',Opus:'#9B5DE5',Fable:'#E9C46A',Other:'#6B7280'};
var VERDICT_HEX={good:'#52B788',warn:'#F59E0B',bad:'#EF4444',neutral:'#6B7280'};
function fN(n){if(!n)return'0';if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n);}
Chart.defaults.color='#94a3b8';Chart.defaults.borderColor='rgba(255,255,255,0.07)';

function showTab(name){
  document.getElementById('paneDash').classList.toggle('active', name==='dash');
  document.getElementById('paneReports').classList.toggle('active', name==='reports');
  document.getElementById('paneProjects').classList.toggle('active', name==='projects');
  document.getElementById('tabBtnDash').classList.toggle('active', name==='dash');
  document.getElementById('tabBtnReports').classList.toggle('active', name==='reports');
  document.getElementById('tabBtnProjects').classList.toggle('active', name==='projects');
}

function sparklineSvg(values, color, w, h){
  w=w||96; h=h||26;
  if(!values || values.length<2) return '<svg class="spark" width="'+w+'" height="'+h+'"></svg>';
  var max=Math.max.apply(null,values), min=Math.min.apply(null,values);
  var range=(max-min)||1;
  var pts=values.map(function(v,i){
    var x=(i/(values.length-1))*w;
    var y=h-((v-min)/range)*h;
    return x.toFixed(1)+','+y.toFixed(1);
  }).join(' ');
  return '<svg class="spark" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}
function gaugeSvg(pct, color){
  var clamped=Math.max(0,Math.min(100,pct));
  var r=22, c=2*Math.PI*r;
  var dash=(clamped/100)*c;
  return '<svg class="spark" width="56" height="56" viewBox="0 0 56 56">'
    +'<circle cx="28" cy="28" r="'+r+'" fill="none" stroke="#334155" stroke-width="5"/>'
    +'<circle cx="28" cy="28" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="5" stroke-dasharray="'+dash.toFixed(1)+' '+c.toFixed(1)+'" stroke-linecap="round" transform="rotate(-90 28 28)"/>'
    +'<text x="28" y="32" text-anchor="middle" font-size="12" font-weight="700" fill="#f1f5f9">'+Math.round(pct)+'%</text>'
    +'</svg>';
}
function focusMiniRow(label,val,color){
  return '<div class="focus-mini-row"><span class="focus-mini-lbl">'+label+'</span><div class="focus-mini-track"><div class="focus-mini-fill" style="width:'+val+'%;background:'+color+'"></div></div></div>';
}
function intensityColorJs(ratio, isCurrent){
  var r,g,b;
  if(ratio<=0){r=51;g=65;b=85;}
  else if(ratio<0.5){var t=ratio*2;r=Math.round(82+(245-82)*t);g=Math.round(183+(158-183)*t);b=Math.round(136+(11-136)*t);}
  else{var t=(ratio-0.5)*2;r=Math.round(245+(229-245)*t);g=Math.round(158+(80-158)*t);b=Math.round(11+(80-11)*t);}
  return 'rgba('+r+','+g+','+b+','+(isCurrent?1:0.75)+')';
}

function renderKpiRow(){
  var ws=D.weekStatus, fs=D.focusScore;
  var pastTokens=ws.days.filter(function(d){return d.status!=='future';}).map(function(d){return d.tokens;});
  var wfSpark=sparklineSvg(pastTokens.length>1?pastTokens:[0,0],'#4A90D9');
  var wfCard='<div class="kpi-card" style="border-left-color:#4A90D9"><div><div class="kpi-label">Weekly Forecast</div>'
    +'<div class="kpi-val">'+fN(ws.forecast)+'</div><div class="kpi-sub">so far '+fN(ws.soFar)+'</div></div>'+wfSpark+'</div>';

  var lhColor=VERDICT_HEX[ws.verdict]||VERDICT_HEX.neutral;
  var lhBody = ws.weeklyLimitEst
    ? ('<div class="kpi-val" style="font-size:15px">'+ws.pct+'%</div><div class="kpi-sub">'+(ws.daysUntilExhausted!==null?('~'+ws.daysUntilExhausted.toFixed(1)+'d budget left'):'of est. limit')+'</div>')
    : '<div class="kpi-sub" style="line-height:1.4;max-width:90px">Est. limit not yet available</div>';
  var lhGauge = ws.weeklyLimitEst ? gaugeSvg(ws.pct||0,lhColor) : '';
  var lhCard='<div class="kpi-card" style="border-left-color:'+lhColor+'"><div><div class="kpi-label">Limit Health</div>'+lhBody+'</div>'+lhGauge+'</div>';

  var ceCard='<div class="kpi-card" id="kpiCache" style="border-left-color:#52B788"></div>';
  var dvCard='<div class="kpi-card" id="kpiVelocity" style="border-left-color:#F59E0B"></div>';

  var fsColor=fs.color;
  var fsCard='<div class="kpi-card" style="border-left-color:'+fsColor+'"><div style="width:100%"><div class="kpi-label">Focus Score</div>'
    +'<div class="kpi-val">'+fs.score+'<span style="font-size:11px;color:#64748b">/100</span></div>'
    +'<span class="kpi-badge" style="background:'+fsColor+'22;color:'+fsColor+'">'+fs.badge+'</span>'
    +'<div class="focus-mini">'
    +focusMiniRow('Cache',fs.components.cache,'#9B5DE5')
    +focusMiniRow('Cont.',fs.components.continuity,'#4A90D9')
    +focusMiniRow('Depth',fs.components.depth,'#52B788')
    +'</div></div></div>';

  document.getElementById('kpiRow').innerHTML = wfCard+lhCard+ceCard+dvCard+fsCard;
}

function renderWeekBar(){
  var ws=D.weekStatus;
  // Billing-week buckets run 18:00→18:00 (Sunday 18:00 CEST/CET reset), not local midnight,
  // so the bucket containing "now" technically started the evening before — e.g. at 2pm on a
  // Friday, the bucket accumulating today's tokens began Thursday 18:00. Labeling it "Thu"
  // would read as wrong to anyone glancing at the bar, so the current bucket always shows
  // "Today" instead of its technical start-weekday. The totals themselves are unaffected —
  // this only changes the label, not which hours count toward the billing week.
  var lbls=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var maxTok=Math.max.apply(null, ws.days.map(function(d){return d.tokens;}).concat([1]));
  var html=ws.days.map(function(d,i){
    var cls='week-day'+(d.status==='future'?' future':'')+(d.status==='current'?' current':'');
    var bg = d.status==='future' ? 'transparent' : intensityColorJs(d.tokens/maxTok, d.status==='current');
    var lbl = d.status==='current' ? 'Today' : lbls[i];
    return '<div class="'+cls+'" style="background:'+bg+'"><span>'+lbl+'</span>'+(d.status!=='future'?('<span>'+fN(d.tokens)+'</span>'):'')+'</div>';
  }).join('');
  document.getElementById('weekBar').innerHTML=html;
  var vEl=document.getElementById('weekVerdict');
  var vText = ws.verdict==='good'?'On track':ws.verdict==='warn'?'Approaching limit':ws.verdict==='bad'?'Likely to exceed':'No estimate yet';
  vEl.textContent=vText;
  vEl.style.background=VERDICT_HEX[ws.verdict]+'22';
  vEl.style.color=VERDICT_HEX[ws.verdict];
  var foot = ws.weeklyLimitEst
    ? ('Forecast '+fN(ws.forecast)+' of an estimated '+fN(ws.weeklyLimitEst)+' tokens by Sunday 18:00 &nbsp;·&nbsp; '+ws.remainingDays+' day'+(ws.remainingDays!==1?'s':'')+' left in this billing week.')
    : ('No weekly-limit hit observed yet, so there is nothing to compare against. '+fN(ws.soFar)+' tokens so far this billing week, '+ws.remainingDays+' day'+(ws.remainingDays!==1?'s':'')+' left.');
  document.getElementById('weekFoot').innerHTML=foot;
}

var cDailyChart=null, cCacheChart=null;
function computeCacheForSlice(slice){
  var create=0, read=0;
  slice.forEach(function(d){ create+=d.cacheCreate||0; read+=d.cacheRead||0; });
  return { create: create, read: read, ratio: create>0 ? parseFloat((read/create).toFixed(1)) : 0 };
}
function applyPeriod(nStr){
  var n=parseInt(nStr,10);
  var slice=D.allDays.slice(-n);
  var totalTok=0, totalReqs=0, activeDays=0;
  slice.forEach(function(d){ totalTok+=(d.input||0)+(d.output||0); totalReqs+=d.reqs||0; if((d.reqs||0)>0) activeDays++; });
  var avgPerActiveDay = activeDays>0 ? Math.round(totalTok/activeDays) : 0;
  var cache = computeCacheForSlice(slice);

  // All four cards share the same period-scoped slice (Björn, 01.09.2026 — spotted that only the
  // first card's label said "(N days)" even though all four numbers change together whenever the
  // period dropdown changes). Every label now states the period explicitly, not just the first.
  document.getElementById('summaryCards').innerHTML =
      '<div class="card"><div class="cv">'+fN(totalTok)+'</div><div class="cl">Tokens ('+n+' days)</div></div>'
    + '<div class="card"><div class="cv">'+totalReqs.toLocaleString('en-GB')+'</div><div class="cl">API calls ('+n+' days)</div></div>'
    + '<div class="card"><div class="cv">'+activeDays+' / '+n+'</div><div class="cl">Active days ('+n+' days)</div></div>'
    + '<div class="card"><div class="cv">'+fN(avgPerActiveDay)+'</div><div class="cl">Avg tokens / active day ('+n+' days)</div></div>';

  document.getElementById('dailyChartTitle').textContent = 'Daily token usage — '+n+' days (by model)';
  document.getElementById('cacheCardsTitle').innerHTML = 'Cache efficiency &amp; usage patterns <span class="live-note">('+n+' days)</span>';

  var ceColor = cache.ratio>=8?'#52B788':cache.ratio>=3?'#4A90D9':cache.ratio>=1?'#F59E0B':'#9B5DE5';
  var ceLabel = cache.ratio>=8?'Deep focus':cache.ratio>=3?'Balanced':cache.ratio>=1?'Exploratory':'Minimal reuse';
  var spark14c = slice.slice(-14).map(function(d){ return (d.cacheCreate>0)?(d.cacheRead/d.cacheCreate):0; });
  var kpiCache = document.getElementById('kpiCache');
  kpiCache.style.borderLeftColor=ceColor;
  // Same period-labeling fix as the summary cards above (Björn, 01.09.2026) — both KPI cards are
  // period-reactive (change with the dropdown) but only showed a static title before.
  kpiCache.innerHTML =
      '<div><div class="kpi-label">Cache Efficiency ('+n+' days)</div><div class="kpi-val">'+cache.ratio+'×</div>'
    + '<span class="kpi-badge" style="background:'+ceColor+'22;color:'+ceColor+'">'+ceLabel+'</span></div>'
    + sparklineSvg(spark14c,ceColor);

  var spark14v = slice.slice(-14).map(function(d){ return (d.input||0)+(d.output||0); });
  document.getElementById('kpiVelocity').innerHTML =
      '<div><div class="kpi-label">Daily Velocity ('+n+' days)</div><div class="kpi-val">'+fN(avgPerActiveDay)+'</div>'
    + '<div class="kpi-sub">tokens / active day</div></div>'
    + sparklineSvg(spark14v,'#F59E0B');

  var models=['Haiku','Sonnet','Opus','Fable','Other'];
  var used=models.filter(function(m){return slice.some(function(d){return d[m]>0;});});
  var dailyData={labels:slice.map(function(d){return d.label;}),datasets:used.map(function(m){return{label:m,data:slice.map(function(d){return d[m]||0;}),backgroundColor:C[m],stack:'s'};})};
  if(cDailyChart){ cDailyChart.data=dailyData; cDailyChart.update(); }
  else { cDailyChart=new Chart(document.getElementById('cDaily'),{type:'bar',data:dailyData,options:{responsive:true,scales:{x:{stacked:true,grid:{color:'rgba(255,255,255,0.05)'}},y:{stacked:true,grid:{color:'rgba(255,255,255,0.05)'},ticks:{callback:function(v){return fN(v);}}}},plugins:{legend:{position:'top',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){return' '+ctx.dataset.label+': '+fN(ctx.raw);}}}}}}); }

  document.getElementById('ccCreate').textContent=fN(cache.create);
  document.getElementById('ccRead').textContent=fN(cache.read);
  document.getElementById('ccRatio').textContent=cache.ratio+'x';
  var rc=document.getElementById('ccRatioCard'); var r=cache.ratio;
  rc.style.borderColor = r>=8?'#52B788':r>=3?'#4A90D9':r>=1?'#F59E0B':r>0?'#9B5DE5':'#334155';
  var h='',t='';
  if(!cache.create&&!cache.read){h='No cache data.';t='No cache tokens recorded in the last '+n+' days.';}
  else if(r>=8){h='Deep focus mode.';t='You work intensely with the same context. Docs, artifacts or long chats are reused heavily — the model reads from cache instead of reprocessing. Efficient and cost-effective.';}
  else if(r>=3){h='Balanced usage.';t='Focused phases alternate with fresh tasks. You bring new context regularly but also reuse existing material across multiple requests.';}
  else if(r>=1){h='Exploratory mode.';t='You bring new context frequently — many different projects, short sessions, or frequent topic switches. Cache is created but rarely reused intensively.';}
  else{h='Minimal cache reuse.';t='Almost every request brings fresh context. Highly exploratory or many independent short sessions without repeating the same source material.';}
  var hint='Cache Write costs ~1.25× regular input — you pay a premium to store the context. Cache Read costs ~0.10× — 10× cheaper to reuse than reprocess. The Reuse Factor (Read ÷ Write) shows whether your investment in caching is paying off.';
  document.getElementById('ccExplain').innerHTML='<strong>'+h+'</strong> '+t+'<div class="hint">'+hint+'</div>';

  var cacheChartData={labels:slice.map(function(d){return d.label;}),datasets:[{label:'Cache Write',data:slice.map(function(d){return d.cacheCreate||0;}),borderColor:'#9B5DE5',backgroundColor:'rgba(155,93,229,0.08)',tension:0.35,fill:true,pointRadius:2,pointHoverRadius:4},{label:'Cache Read',data:slice.map(function(d){return d.cacheRead||0;}),borderColor:'#F59E0B',backgroundColor:'rgba(245,158,11,0.08)',tension:0.35,fill:true,pointRadius:2,pointHoverRadius:4}]};
  if(cCacheChart){ cCacheChart.data=cacheChartData; cCacheChart.update(); }
  else { cCacheChart=new Chart(document.getElementById('cCache'),{type:'line',data:cacheChartData,options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'top',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){return' '+ctx.dataset.label+': '+fN(ctx.raw);}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'}},y:{beginAtZero:true,grid:{color:'rgba(255,255,255,0.05)'},ticks:{callback:function(v){return fN(v);}}}}}}); }

  renderProjects(n);
}

(function(){
  var note = '(live data, last '+D.liveWindowDays+' days)';
  document.getElementById('liveNote1').textContent=note;
  document.getElementById('liveNote2').textContent=note;
  document.getElementById('liveNote3').textContent=note;

  var dist=D.dist30.filter(function(m){return m.count>0;});
  new Chart(document.getElementById('cModel'),{type:'doughnut',data:{labels:dist.map(function(m){return m.name;}),datasets:[{data:dist.map(function(m){return m.count;}),backgroundColor:dist.map(function(m){return C[m.name]||C.Other;}),borderWidth:2,borderColor:'#0f172a'}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){var m=dist[ctx.dataIndex];return' '+m.name+': '+m.count+' calls ('+m.pct+'%)';}}}}}});
  new Chart(document.getElementById('cDist'),{type:'bar',data:{labels:D.hist.map(function(h){return h.label;}),datasets:[{data:D.hist.map(function(h){return h.count;}),backgroundColor:'#4A90D9',borderRadius:3}]},options:{responsive:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return' '+ctx.raw+' requests';}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'}},y:{beginAtZero:true,grid:{color:'rgba(255,255,255,0.05)'}}}}});
  var tbody=document.getElementById('tSess');
  D.sessions.forEach(function(s){var tr=document.createElement('tr');var col=C[s.primary]||C.Other;tr.innerHTML='<td style="font-family:monospace;color:#64748b">'+s.id+'…</td><td>'+s.start+'</td><td style="color:#f1f5f9;font-weight:600">'+fN(s.tokens)+'</td><td>'+s.reqs+'</td><td><span class="badge" style="background:'+col+'22;color:'+col+'">'+s.primary+'</span></td>';tbody.appendChild(tr);});
}());

// ── Rate Limits section ──────────────────────────────────────────
(function(){
  var RL = D.rateLimit;
  if (!RL) return;
  var estEl = document.getElementById('rlEst');
  var estHtml = '';
  if (RL.sessionEst && RL.sessionEst.n > 0) {
    var se = RL.sessionEst;
    estHtml += '<strong>Session limit estimate: ~' + fN(se.min) + ' – ' + fN(se.max) + ' tokens / 5h</strong>'
      + ' &nbsp;·&nbsp; median ' + fN(se.median) + ' &nbsp;·&nbsp; ' + se.n + ' observed hits (last 30 days)';
  } else {
    estHtml += '<strong>Session limit estimate:</strong> not enough data yet (need observed hits with > 50 K tokens in 5h window)';
  }
  if (RL.weeklyEst) {
    estHtml += '<br><strong>Weekly limit estimate: ≥ ' + fN(RL.weeklyEst) + ' tokens / week</strong>'
      + ' (conservative lower bound from ' + RL.weeklyHits + ' weekly-limit event' + (RL.weeklyHits !== 1 ? 's' : '') + ')';
  }
  estHtml += '<br><span style="color:#64748b;font-size:11px">'
    + RL.totalSession + ' session-limit hit' + (RL.totalSession !== 1 ? 's' : '')
    + ' &nbsp;·&nbsp; ' + RL.totalWeekly + ' weekly-limit hit' + (RL.totalWeekly !== 1 ? 's' : '')
    + ' in last 30 days. Anthropic does not publish these limits — all values are empirical.'
    + ' Counted from Claude Code activity only (terminal, Obsidian, editors, desktop agent mode);'
    + ' plain chat in the desktop app or on claude.ai draws on the same plan limit but records no'
    + ' token counts locally, so a limit was likely reached at a higher total than shown here.</span>';
  estEl.innerHTML = estHtml;
  var tbody = document.getElementById('tRL');
  RL.events.forEach(function(ev) {
    var tr  = document.createElement('tr');
    var dt  = new Date(ev.timestamp);
    var dStr = dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
    var tStr = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    var col  = ev.type === 'weekly' ? '#F59E0B' : '#9B5DE5';
    var tok = ev.type === 'weekly'
      ? (ev.tokWeek > 0 ? fN(ev.tokWeek) + '<br><span style="font-size:10px;color:#64748b">billing week</span>' : '—')
      : (ev.tok5h  > 0 ? fN(ev.tok5h)   + '<br><span style="font-size:10px;color:#64748b">5h window</span>'   : '—');
    tr.innerHTML = '<td>' + dStr + '</td><td>' + tStr + '</td>'
      + '<td><span class="badge" style="background:' + col + '22;color:' + col + '">' + ev.type + '</span></td>'
      + '<td style="color:#f1f5f9;font-weight:600">' + tok + '</td>'
      + '<td style="color:#64748b">' + (ev.reset || '—') + '</td>';
    tbody.appendChild(tr);
  });
  if (RL.weeks && RL.weeks.length > 0) {
    new Chart(document.getElementById('cWeekly'), {
      type: 'bar',
      data: {
        labels: RL.weeks.map(function(w) { return w.label; }),
        datasets: [{
          label: 'Tokens (inp+out)',
          data: RL.weeks.map(function(w) { return w.tokens; }),
          backgroundColor: RL.weeks.map(function(w) { return w.hitWeekly ? '#F59E0B' : '#4A90D9'; }),
          borderRadius: 3,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function(ctx) {
            var w = RL.weeks[ctx.dataIndex];
            return ' ' + fN(ctx.raw) + (w.hitWeekly ? '  ⚠ weekly limit hit' : '');
          }}}
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { callback: function(v) { return fN(v); } } }
        }
      }
    });
  }
}());

// ── Reports tab ────────────────────────────────────────────────
// table-layout:auto (the default) stretches every column proportionally to fill width:100% —
// fine for the multi-column tables elsewhere on the dashboard, but for a 2-column key/value
// table it drags the label column out to roughly half the container width, leaving a big gap
// before the value. "width:1%" + "white-space:nowrap" on the first cell is the standard trick
// to force that column to shrink to its content instead, so label and value sit close together.
function simpleTable(rows){ return '<table><tbody>'+rows.map(function(r){return '<tr><td style="color:#94a3b8;width:1%;white-space:nowrap;padding-right:28px">'+r[0]+'</td><td style="color:#f1f5f9;font-weight:600">'+r[1]+'</td></tr>';}).join('')+'</tbody></table>'; }
function reportTable(title, rows){ return '<div class="cb report-section"><h2>'+title+'</h2>'+simpleTable(rows)+'</div>'; }
function renderReports(){
  var R=D.report;
  var html='';
  if(R.lastAction){
    html+=reportTable('Last Action',[['Model',R.lastAction.model],['Timestamp',R.lastAction.timestamp],['Input',R.lastAction.input],['Output',R.lastAction.output],['Cache Write',R.lastAction.cacheCreate],['Cache Read',R.lastAction.cacheRead]]);
  }
  html+='<div class="cb report-section"><h2>5h Window</h2>';
  if(R.window5h){
    var rows=[['Input',R.window5h.input],['Output',R.window5h.output],['Cache Write',R.window5h.cacheCreate],['Cache Read',R.window5h.cacheRead],['Total (In+Out)',R.window5h.total]];
    if(R.window5h.resetsIn) rows.push(['Window resets in', R.window5h.resetsIn]);
    html+=simpleTable(rows);
  } else { html+='<div style="color:#94a3b8;font-size:12px">No activity in the last 5 hours.</div>'; }
  html+='</div>';
  R.periods.forEach(function(p){
    html+=reportTable(p.title,[['Input',p.input],['Output',p.output],['Cache Write',p.cacheCreate],['Cache Read',p.cacheRead],['API Calls',p.calls]]);
  });
  if(R.models7.length){
    var rows7h=R.models7.map(function(m){return '<tr><td>'+m.name+'</td><td>'+m.count+'</td><td>'+m.pct+'%</td><td>'+m.tokens+'</td></tr>';}).join('');
    html+='<div class="cb report-section"><h2>Models (7 Days)</h2><table><thead><tr><th>Model</th><th>Calls</th><th>%</th><th>Tokens</th></tr></thead><tbody>'+rows7h+'</tbody></table></div>';
  }
  var cacheNote = R.cache.activeInPeriod!==null
    ? ('<div style="font-size:11px;color:#64748b;line-height:1.6;margin-top:10px">'+R.cache.activeInPeriod+' of '+R.cache.periodDays+' days had activity — the rest were quiet days (weekends, time off) or predate what is archived.</div>')
    : '';
  html+='<div class="cb report-section"><h2>Cache Efficiency ('+R.cache.periodDays+' Days)</h2>'
    +simpleTable([['Cache Write',R.cache.write],['Cache Read',R.cache.read],['Reuse Factor (Read/Write)',R.cache.reuse+'x']])
    +cacheNote+'</div>';
  if(R.chart7.length){
    var rows7=R.chart7.map(function(d){return '<tr><td>'+d.date+(d.isToday?' (today)':'')+'</td><td>'+d.input+'</td><td>'+d.output+'</td><td>'+d.total+'</td></tr>';}).join('');
    html+='<div class="cb report-section"><h2>7-Day Overview</h2><table><thead><tr><th>Date</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>'+rows7+'</tbody></table></div>';
  }
  document.getElementById('paneReports').innerHTML=html;
}

// Vault/project breakdown (01.09.2026) — D.projects (overview, one row per vault, already
// collision-safe-labeled server-side) + a day×vault matrix re-derived from D.allDays for
// whichever period is currently selected (n), same "re-slice from the one embedded allDays array"
// approach applyPeriod() already uses for the daily chart/model cards/cache KPIs, so no second
// payload is needed just for this tab. Called once at startup (via applyPeriod(D.defaultPeriod)
// below) and again every time the period dropdown changes (from inside applyPeriod() itself).
// Sortable Projects Overview (Björn, 01.09.2026) — click a column header to sort by it, click
// again to flip direction. State persists across re-renders (period dropdown changes, sort
// clicks) since it lives outside renderProjects() itself, same pattern as cDailyChart/cCacheChart
// persisting across applyPeriod() calls.
var PROJECT_COLS = [
  { key: 'label',      title: 'Vault / root',  type: 'string' },
  { key: 'tokens',      title: 'Tokens',        type: 'number' },
  { key: 'pct',         title: '%',             type: 'number' },
  { key: 'activeDays',  title: 'Active Days',   type: 'number' },
  { key: 'firstTs',     title: 'First Active',  type: 'number' },
  { key: 'lastTs',      title: 'Last Active',   type: 'number' },
];
var projectSort = { key: 'tokens', dir: 'desc' };
// Sub-project detail toggle (Björn, v1.8) — off by default, so the Projects Overview stays a
// clean one-row-per-vault table. When switched ON it is a real "show me the detail" mode:
// every vault with sub-folder drift (p.projects, already computed server-side by
// _computeProjectOverview() and embedded in D.projects — no second data path) is expanded
// immediately to its indented sub-rows, styled distinctly (tinted, tree connector, "N sub"
// badge on the vault) so the two states are visibly different. The per-vault caret then only
// collapses individual vaults again (opt-out via projCollapsed, not opt-in). Sorting still
// applies to vault rows only; sub-rows hang off their vault in server-sorted order. State
// lives outside renderProjects() so it survives re-renders — same pattern as projectSort.
var projSubDetail = false;
var projCollapsed = {}; // label -> true: this vault's sub-rows are hidden while detail mode is on

function toggleProjectSort(key){
  if (projectSort.key === key) { projectSort.dir = projectSort.dir === 'asc' ? 'desc' : 'asc'; }
  else { projectSort.key = key; projectSort.dir = 'desc'; }
  renderProjects();
}

function setProjSubDetail(on){ projSubDetail = on; projCollapsed = {}; renderProjects(); }
function toggleProjVault(label){ projCollapsed[label] = !projCollapsed[label]; renderProjects(); }

function projectsOverviewTable(){
  var all = (D.projects || []).slice();
  if (!all.length) return '<div style="color:#94a3b8;font-size:12px">No vault data recorded yet.</div>';
  var grand = all.reduce(function(s, p){ return s + (p.tokens || 0); }, 0);

  var col = PROJECT_COLS.filter(function(c){ return c.key === projectSort.key; })[0];
  function sortRows(arr){
    return arr.sort(function(a, b){
      var cmp = col.type === 'string'
        ? String(a[col.key]).localeCompare(String(b[col.key]))
        : (a[col.key] || 0) - (b[col.key] || 0);
      return projectSort.dir === 'asc' ? cmp : -cmp;
    });
  }

  // "Vault" is really "the folder each session started in" — a real Obsidian vault in the
  // common case, but also your home folder, a scratch dir, or the Claude-Desktop agent-mode
  // bucket. Fold folders below 1% of total into one "Other" summary row so the overview stays
  // readable (display only — D.projects, the export and the Daily Detail table are untouched).
  // Only folds when it actually removes clutter (>= 2 such folders).
  var minor = all.filter(function(p){ return grand > 0 && (p.tokens || 0) / grand < 0.01; });
  var shown = all, otherRow = null;
  if (minor.length >= 2) {
    var folded = {};
    minor.forEach(function(p){ folded[p.label] = true; });
    shown = all.filter(function(p){ return !folded[p.label]; });
    var oTok = minor.reduce(function(s, p){ return s + (p.tokens || 0); }, 0);
    otherRow = {
      label: 'Other (' + minor.length + ' folders)',
      tokens: oTok,
      pct: grand > 0 ? Math.round(oTok / grand * 100) : 0,
      activeDays: '—',
      firstTs: Math.min.apply(null, minor.map(function(p){ return p.firstTs; })),
      lastTs:  Math.max.apply(null, minor.map(function(p){ return p.lastTs; })),
      projects: [],
      _isOther: true,
    };
  }
  sortRows(shown);

  var subVaults = shown.filter(function(p){ return p.projects && p.projects.length; });
  var anySub = subVaults.length > 0;
  var toggleBar = anySub
    ? '<label class="proj-toggle"><input type="checkbox" class="proj-subdetail-cb"' + (projSubDetail ? ' checked' : '') + '>Show sub-project detail</label>'
    : '';
  var caption = '<p class="proj-detail-note">One row per folder a Claude Code session started in. Your Obsidian vault is one such folder; <strong>Claude Desktop (Agent Mode)</strong> is the desktop app\\'s agent-mode sessions, not a folder'
    + (otherRow ? '; folders below 1% of the total are grouped into <strong>Other</strong>' : '')
    + '.'
    + (projSubDetail && anySub ? ' With sub-project detail on, a sub-row\\'s Tokens and % are that sub-folder\\'s share of its vault; the other columns apply at vault level only.' : '')
    + '</p>';

  var head = PROJECT_COLS.map(function(c){
    var arrow = c.key === projectSort.key ? (projectSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return '<th style="cursor:pointer;user-select:none" onclick="toggleProjectSort(\\''+c.key+'\\')" title="Click to sort">'+c.title+arrow+'</th>';
  }).join('');

  var render = (otherRow ? shown.concat([otherRow]) : shown);
  var body = render.map(function(p){
    var first = new Date(p.firstTs).toLocaleDateString('en-GB', {day:'2-digit',month:'2-digit',year:'numeric'});
    var last  = new Date(p.lastTs).toLocaleDateString('en-GB', {day:'2-digit',month:'2-digit',year:'numeric'});
    if (p._isOther) {
      return '<tr class="proj-other-row"><td>'+p.label+'</td><td style="color:#cbd5e1;font-weight:600">'+fN(p.tokens)+'</td><td>'+p.pct+'%</td><td>'+p.activeDays+'</td><td>'+first+'</td><td>'+last+'</td></tr>';
    }
    var hasSub = projSubDetail && p.projects && p.projects.length;
    var open = hasSub && !projCollapsed[p.label];
    var lead = hasSub
      ? '<span class="proj-caret" data-label="'+encodeURIComponent(p.label)+'">'+(open?'▾':'▸')+'</span> '
      : (projSubDetail && anySub ? '<span class="lead-spacer"></span> ' : '');
    var badge = hasSub ? '<span class="proj-subcount">'+p.projects.length+' sub</span>' : '';
    var rowCls = 'proj-vault-row' + (hasSub ? ' has-sub' : '');
    var labelCell = hasSub
      ? '<td data-label="'+encodeURIComponent(p.label)+'" class="proj-vault-label">'+lead+p.label+badge+'</td>'
      : '<td>'+lead+p.label+'</td>';
    var tr = '<tr class="'+rowCls+'">'+labelCell+'<td style="color:#f1f5f9;font-weight:600">'+fN(p.tokens)+'</td><td>'+p.pct+'%</td><td>'+p.activeDays+'</td><td>'+first+'</td><td>'+last+'</td></tr>';
    if (open) {
      tr += p.projects.map(function(s){
        return '<tr class="proj-subrow"><td>'+s.label+'</td>'
          + '<td>'+fN(s.tokens)+'</td><td>'+s.pct+'%</td>'
          + '<td class="sub-muted">–</td><td class="sub-muted">–</td><td class="sub-muted">–</td></tr>';
      }).join('');
    }
    return tr;
  }).join('');
  return toggleBar + caption + '<table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table>';
}

// Sortable Daily Detail (Björn, 01.09.2026, bug/feature report against v1.7.0 testing) — same
// click-header-to-sort pattern as projectsOverviewTable() above, but columns are dynamic (one per
// vault label, varies per user) instead of a fixed set. Default sort is Date descending — the
// original ascending-by-date order buried today's row at the very bottom of a 60-day table, which
// read as "broken" at a glance; today-first matches how every other section in this plugin
// (sidebar, dashboard cards) already leads with the most recent data.
var dailySort = { key: 'ts', dir: 'desc' };

function toggleDailySort(key){
  if (dailySort.key === key) { dailySort.dir = dailySort.dir === 'asc' ? 'desc' : 'asc'; }
  else { dailySort.key = key; dailySort.dir = 'desc'; }
  renderProjects();
}

function dailyDetailTable(slice, labels){
  var cols = [{ key: 'ts', title: 'Date' }]
    .concat(labels.map(function(l){ return { key: l, title: l }; }))
    .concat([{ key: 'total', title: 'Total' }]);
  var col = cols.filter(function(c){ return c.key === dailySort.key; })[0] || cols[0];
  var rows = slice.slice().sort(function(a, b){
    var av = col.key === 'ts' ? a.ts : col.key === 'total' ? a.total : ((a.byRoot||{})[col.key] ? (a.byRoot||{})[col.key].total : 0);
    var bv = col.key === 'ts' ? b.ts : col.key === 'total' ? b.total : ((b.byRoot||{})[col.key] ? (b.byRoot||{})[col.key].total : 0);
    var cmp = av - bv;
    return dailySort.dir === 'asc' ? cmp : -cmp;
  });
  var head = cols.map(function(c){
    var arrow = c.key === dailySort.key ? (dailySort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return '<th style="cursor:pointer;user-select:none" onclick="toggleDailySort(\\''+c.key+'\\')" title="Click to sort">'+c.title+arrow+'</th>';
  }).join('');
  var body = rows.map(function(d){
    var cells = labels.map(function(l){ var r=(d.byRoot||{})[l]; return '<td>'+fN(r?r.total:0)+'</td>'; }).join('');
    return '<tr><td>'+d.label+'</td>'+cells+'<td style="color:#f1f5f9;font-weight:600">'+fN(d.total)+'</td></tr>';
  }).join('');
  return '<div style="overflow-x:auto"><table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div>';
}

function renderProjects(n){
  n = n || parseInt(document.getElementById('periodSel').value, 10);
  var slice = D.allDays.slice(-n);
  var html = '';

  html += '<div class="cb report-section"><h2>Projects Overview</h2>' + projectsOverviewTable() + '</div>';

  // Vault/Root level only (01.09.2026, revised) — deliberately NOT per sub-project/subfolder.
  // day.byRoot[label].total is the root's full daily total; the fine-grained sub-project split
  // (day.byRoot[label].projects) is intentionally not rendered here, only in the
  // Vault_Token_Usage_Projects.md export, since cwd drift within a session (a Bash tool call
  // temporarily cd'ing into a subfolder) is not a reliable "effort per topic" signal.
  var labels = [];
  slice.forEach(function(d){ Object.keys(d.byRoot||{}).forEach(function(l){ if(labels.indexOf(l)===-1) labels.push(l); }); });
  labels.sort();
  if (labels.length) {
    html += '<div class="cb report-section"><h2>Daily Detail ('+n+' days)</h2><div style="color:#94a3b8;font-size:11px;margin-bottom:8px">Vault level — see the Vault_Token_Usage_Projects.md export for the sub-project breakdown.</div>' + dailyDetailTable(slice, labels) + '</div>';
  }

  document.getElementById('paneProjects').innerHTML = html;

  // Sub-project detail (v1.8) — wire the checkbox + per-vault collapse after innerHTML. Handlers
  // (not inline onclick) so the vault label never has to be escaped into an attribute string;
  // it round-trips via encodeURIComponent/decodeURIComponent in a data- attribute instead.
  var subCb = document.querySelector('#paneProjects .proj-subdetail-cb');
  if (subCb) subCb.onchange = function(){ setProjSubDetail(subCb.checked); };
  Array.prototype.forEach.call(document.querySelectorAll('#paneProjects .proj-vault-label'), function(el){
    el.onclick = function(){ toggleProjVault(decodeURIComponent(el.getAttribute('data-label'))); };
  });
}

renderKpiRow();
renderWeekBar();
document.getElementById('periodSel').value=String(D.defaultPeriod);
applyPeriod(D.defaultPeriod);
renderReports();
<\/script>
</body>
</html>`;
  }
}

// ── Settings ──────────────────────────────────────────────────────
// Opens the OS file manager (Explorer/Finder) at a vault-relative path — Report/Dashboard/
// Archive settings all use this (Björn, 29.08.2026) so users who don't know what "vault-relative"
// means can just click through instead. Desktop-only (manifest.json: isDesktopOnly: true), so
// Electron's shell module is always available. adapter.getBasePath() is FileSystemAdapter's
// standard way to get the vault's absolute OS path — only ever missing on a mobile vault, which
// this plugin doesn't run on anyway; falls back to a Notice rather than throwing either way.
function revealInVault(app, relativePath) {
  try {
    const adapter  = app.vault.adapter;
    const basePath = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : null;
    if (!basePath) throw new Error('vault has no filesystem base path (mobile?)');
    require('electron').shell.showItemInFolder(path.join(basePath, relativePath));
  } catch (e) {
    new obsidian.Notice(t('settingShowInFolderFailed') + relativePath);
  }
}

// ── Shared settings UI builder (UI relaunch v2, Phase E) ─────────────────────────
// Used by BOTH the real Obsidian settings tab (AnthropicUsageSettingTab.display() below) and
// the NextGen sidebar's inline Settings page (AnthropicUsageView._renderSettingsPage) — same
// Setting objects, same behavior, defined once. `refreshUI` is called after a change that needs
// the settings UI itself to redraw (e.g. language switch changes every label's text) — each
// caller passes its own re-render method (`display()` for the tab, `render()` for the sidebar).
function buildSettingsUI(containerEl, app, plugin, refreshUI) {
  containerEl.empty();
  containerEl.createEl('h2', { text: 'Token Usage' });
  new obsidian.Setting(containerEl)
    .setName(t('settingLang'))
    .setDesc(t('settingLangDesc'))
    .addDropdown(dd => dd
      .addOption('en', 'English')
      .addOption('de', 'Deutsch')
      .addOption('fr', 'Français')
      .addOption('it', 'Italiano')
      .setValue(plugin.settings.language || 'en')
      .onChange(async v => {
        plugin.settings.language = v;
        _lang = v;
        await plugin.saveSettings();
        // Re-render any open sidebar view immediately
        app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => {
          if (l.view instanceof AnthropicUsageView) l.view.render();
        });
        refreshUI(); // refresh settings labels too
      }));
  new obsidian.Setting(containerEl)
    .setName(t('settingSidebarMode'))
    .setDesc(t('settingSidebarModeDesc'))
    .addDropdown(dd => dd
      .addOption('classic', 'Classic')
      .addOption('nextgen', 'NextGen')
      .setValue(plugin.settings.sidebarMode || 'classic')
      .onChange(async v => {
        plugin.settings.sidebarMode = v;
        await plugin.saveSettings();
        // Display only — no data changed, so render() (not refresh()) is enough, same
        // pattern as the language switch above.
        app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => {
          if (l.view instanceof AnthropicUsageView) l.view.render();
        });
      }));
  new obsidian.Setting(containerEl)
    .setName(t('settingCalendar'))
    .setDesc(t('settingCalendarDesc'))
    .addToggle(tg => tg.setValue(plugin.settings.calendarVisible !== false)
      .onChange(async v => {
        plugin.settings.calendarVisible = v;
        await plugin.saveSettings();
        // Display only — render() (not refresh()), same pattern as the two dropdowns above.
        app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => {
          if (l.view instanceof AnthropicUsageView) l.view.render();
        });
      }));
  new obsidian.Setting(containerEl)
    .setName(t('settingRefresh'))
    .setDesc(t('settingRefreshDesc'))
    .addText(txt => txt.setPlaceholder('30').setValue(String(plugin.settings.refreshSeconds))
      .onChange(async v => { const n = parseInt(v); if (!isNaN(n) && n >= 5) { plugin.settings.refreshSeconds = n; await plugin.saveSettings(); } }));
  new obsidian.Setting(containerEl)
    .setName(t('settingReportPeriod'))
    .setDesc(t('settingReportPeriodDesc'))
    .addDropdown(dd => dd
      .addOption('30', '30 days')
      .addOption('60', '60 days')
      .addOption('180', '6 months')
      .addOption('360', '12 months')
      .setValue(String(plugin.settings.reportPeriodDays || 30))
      .onChange(async v => { plugin.settings.reportPeriodDays = parseInt(v, 10); await plugin.saveSettings(); }));
  new obsidian.Setting(containerEl)
    .setName(t('settingArchiveEnabled'))
    .setDesc(t('settingArchiveEnabledDesc'))
    .addToggle(tg => tg.setValue(plugin.settings.archiveEnabled !== false)
      .onChange(async v => { plugin.settings.archiveEnabled = v; await plugin.saveSettings(); }));
  new obsidian.Setting(containerEl)
    .setName(t('settingCleanup'))
    .setDesc(t('settingCleanupDesc'))
    .addText(txt => txt.setPlaceholder('30').setValue(String(readCleanupPeriodDays()))
      .onChange(v => {
        // Debounced: writes Claude Code's own settings.json, so we wait for the user
        // to stop typing rather than committing on every keystroke (e.g. "1" → "12" → "120").
        clearTimeout(buildSettingsUI._cleanupDebounce);
        buildSettingsUI._cleanupDebounce = setTimeout(() => {
          const n = parseInt(v, 10);
          if (isNaN(n) || n < 1) return;
          const ok = writeCleanupPeriodDays(n);
          new obsidian.Notice(ok ? t('cleanupSaved', n) : (t('cleanupFailed') + CLAUDE_SETTINGS_PATH));
          if (ok) {
            // Force an immediate re-read of the session files with the new window —
            // without this, any open sidebar keeps showing the old retentionDays until
            // its next scheduled poll/file-watcher tick, or a full Obsidian restart.
            app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => {
              if (l.view instanceof AnthropicUsageView) l.view.refresh();
            });
          }
        }, 800);
      }));

  // Paths grouped separately at the bottom (Björn, 25.08.2026) — "where files go" is a
  // different kind of decision than "how the plugin behaves", worth its own visual block.
  containerEl.createEl('h3', { text: t('settingPathsHeading') });
  new obsidian.Setting(containerEl)
    .setName(t('settingReport'))
    .setDesc(t('settingReportDesc'))
    .addText(txt => txt.setPlaceholder('Token Usage Report.md').setValue(plugin.settings.reportPath || 'Token Usage Report.md')
      .onChange(async v => { if (v.trim()) { plugin.settings.reportPath = v.trim(); await plugin.saveSettings(); } }))
    .addExtraButton(btn => btn.setIcon('folder-open').setTooltip(t('settingShowInFolder'))
      .onClick(() => revealInVault(app, plugin.settings.reportPath || 'Token Usage Report.md')));
  new obsidian.Setting(containerEl)
    .setName(t('settingVaultReport'))
    .setDesc(t('settingVaultReportDesc'))
    .addText(txt => txt.setPlaceholder('Vault_Token_Usage_Projects.md').setValue(plugin.settings.vaultReportPath || 'Vault_Token_Usage_Projects.md')
      .onChange(async v => { if (v.trim()) { plugin.settings.vaultReportPath = v.trim(); await plugin.saveSettings(); } }))
    .addExtraButton(btn => btn.setIcon('folder-open').setTooltip(t('settingShowInFolder'))
      .onClick(() => revealInVault(app, plugin.settings.vaultReportPath || 'Vault_Token_Usage_Projects.md')));
  new obsidian.Setting(containerEl)
    .setName(t('settingDash'))
    .setDesc(t('settingDashDesc'))
    .addText(txt => txt.setPlaceholder('Token Usage Dashboard.html').setValue(plugin.settings.dashboardPath || 'Token Usage Dashboard.html')
      .onChange(async v => { if (v.trim()) { plugin.settings.dashboardPath = v.trim(); await plugin.saveSettings(); } }))
    .addExtraButton(btn => btn.setIcon('folder-open').setTooltip(t('settingShowInFolder'))
      .onClick(() => revealInVault(app, plugin.settings.dashboardPath || 'Token Usage Dashboard.html')));
  new obsidian.Setting(containerEl)
    .setName(t('settingArchive'))
    .setDesc(t('settingArchiveDesc'))
    .addText(txt => txt.setPlaceholder('Token Usage Archive').setValue(plugin.settings.archivePath || 'Token Usage Archive')
      .onChange(async v => { if (v.trim()) { plugin.settings.archivePath = v.trim(); await plugin.saveSettings(); } }))
    .addExtraButton(btn => btn.setIcon('folder-open').setTooltip(t('settingShowInFolder'))
      .onClick(() => revealInVault(app, plugin.settings.archivePath || 'Token Usage Archive')));

  containerEl.createEl('p', { cls: 'au-settings-info', text: t('settingSource', CLAUDE_DIR) });
}

class AnthropicUsageSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    buildSettingsUI(this.containerEl, this.app, this.plugin, () => this.display());
  }
}

// ── "What's new" popup ──────────────────────────────────────────
// English-only by deliberate decision (not translated via STRINGS/t()) — keeps per-release
// maintenance to a single short list instead of four. Add a new 'x.y.z': [...] entry here
// with each release that has user-facing highlights worth surfacing (skip pure bugfix
// releases — see AnthropicUsagePlugin._maybeShowWhatsNew()).
const WHATS_NEW_HIGHLIGHTS = {
  '1.8.0': [
    'Activity calendar (NextGen sidebar) — a month grid pinned to the bottom of every rail page, one colored dot per day sized against your own recent daily average. Navigate back through your history; toggle it off in Settings if you prefer',
    'Claude desktop app usage now counts — the agent mode built into the desktop app runs Claude Code and writes the same session logs; the plugin now reads those too, so that consumption no longer goes missing from your totals and estimates',
    'Dashboard: expandable sub-project detail — the Projects view stays one row per vault by default, but you can now expand any vault to see the per-subfolder breakdown inline, not just in the Markdown export',
    'Clearer scope — a new "What is measured" glossary entry and dashboard note spell out that the plugin covers Claude Code everywhere, but not ordinary Claude chat (which writes no local token counts)',
    'A proper manual is taking shape at langeatn.de/media/token-usage/manual/ — chapter outline is live, content fills in over the next releases',
  ],
  '1.7.1': [
    'NextGen sidebar (opt-in, Settings → Sidebar appearance) — icon rail navigation, a 7-day activity heatmap, and colored KPI tiles with trend sparklines',
    'Vault Token Usage Controlling — the Dashboard\'s new Projects view breaks token usage down by vault and sub-project, so you can track and compare consumption across multiple vaults (e.g. separate client workspaces) from one place, with a day-by-vault detail table and a standalone Markdown export for billing',
    'Redesigned Dashboard — KPI cards (weekly forecast, limit health, cache efficiency, daily velocity, focus score), a week status bar, and a new Reports tab',
    'Historical reporting beyond 30 days — daily usage is now archived directly in your vault, so 60/90+ day views keep working even after Claude Code rolls off its own local logs',
    'Configurable Claude data retention — control how long the original session log files are kept on disk, right from the plugin settings',
  ],
};

class WhatsNewModal extends obsidian.Modal {
  constructor(app, version, entries) {
    super(app);
    this.version = version;
    this.entries = entries;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('au-whats-new-modal');
    contentEl.createEl('h2', { text: `What's new in Token Usage v${this.version}` });
    const ul = contentEl.createEl('ul', { cls: 'au-whats-new-list' });
    this.entries.forEach(text => ul.createEl('li', { text }));
    const footer = contentEl.createDiv({ cls: 'au-whats-new-footer' });
    const btn = footer.createEl('button', { text: 'Got it', cls: 'mod-cta' });
    btn.addEventListener('click', () => this.close());
  }
  onClose() { this.contentEl.empty(); }
}

// ── Plugin ────────────────────────────────────────────────────────
class AnthropicUsagePlugin extends obsidian.Plugin {
  async onload() {
    const raw = await this.loadData();
    await this.loadSettings(raw);
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
    this.addCommand({
      id: 'generate-vault-project-report', name: 'Create Vault Token Usage Projects report',
      callback: () => { const l = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (l?.view instanceof AnthropicUsageView) l.view._generateVaultProjectReport(); }
    });
    this.addCommand({
      id: 'show-whats-new', name: "Show what's new",
      callback: () => {
        const version = this.manifest.version;
        const entries = WHATS_NEW_HIGHLIGHTS[version] || ['No highlights recorded for this version.'];
        new WhatsNewModal(this.app, version, entries).open();
      }
    });
    this.addSettingTab(new AnthropicUsageSettingTab(this.app, this));
    this.registerInterval(window.setInterval(
      () => this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => { if (l.view instanceof AnthropicUsageView) l.view.refresh(); }),
      (this.settings.refreshSeconds || 30) * 1000
    ));
    this._maybeShowWhatsNew(!raw);
  }
  // Shows a one-time "What's new" popup after a version upgrade. Skipped entirely on a true
  // fresh install (loadData() returned null — nothing to compare against yet) and whenever the
  // current version has no WHATS_NEW_HIGHLIGHTS entry (e.g. a pure bugfix release). Either way,
  // lastSeenVersion is brought up to date so the next real upgrade is detected correctly.
  _maybeShowWhatsNew(isFreshInstall) {
    const version = this.manifest.version;
    const entries = WHATS_NEW_HIGHLIGHTS[version];
    const alreadySeen = this.settings.lastSeenVersion === version;
    if (!isFreshInstall && !alreadySeen && entries && entries.length) {
      this.app.workspace.onLayoutReady(() => new WhatsNewModal(this.app, version, entries).open());
    }
    if (!alreadySeen) {
      this.settings.lastSeenVersion = version;
      this.saveSettings();
    }
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    workspace.revealLeaf(leaf);
  }
  async loadSettings(raw)  { this.settings = Object.assign({}, DEFAULT_SETTINGS, raw); _lang = this.settings.language || 'en'; }
  async saveSettings()  { await this.saveData(this.settings); _lang = this.settings.language || 'en'; }
}

module.exports = AnthropicUsagePlugin;
