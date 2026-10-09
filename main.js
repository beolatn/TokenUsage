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
// Optional feed of the OFFICIAL rate-limit percentages (09.10.2026). Claude Code keeps no local
// record of them, but hands them to a status line script on every refresh. A small user-installed
// status line (plus an optional scheduled poll) appends one JSON line per reading:
//   {"ts":<ms>,"h5":{"pct":71,"resets":<s>},"wk":{"pct":61,"resets":<s>}}
// When the file exists, the limits are anchored on these readings; without it the plugin falls
// back to its own estimates from observed limit hits, exactly as before.
const RATELIMIT_FEED_PATH    = path.join(os.homedir(), '.claude', 'ratelimit-log.jsonl');

// Claude Desktop "Agent Mode" (v1.8) — the desktop app runs Claude Code embedded and writes the
// exact same JSONL session format, but into its own isolated HOME instead of ~/.claude. Without
// this second source that usage is invisible to the plugin even though the data is right there.
// Layout below the anchor: <workspace>/<session>/local_<uuid>/.claude/projects/<cwd>/<id>.jsonl
const AGENT_MODE_DIRNAME = 'local-agent-mode-sessions';
// One-shot archive rebuild after adding the agent-mode source. Past archive files are treated as
// final (see _archiveDays), so days already archived would keep their old, too-low totals and the
// numbers would visibly drop again once such a day ages out of the live window. Bumping this tag
// re-writes every day still covered by live data, exactly once. See settings.archiveRebuildDone.
// Bumped for 2.1.0 (09.10.2026): two counting fixes change past days too. Responses written
// several times into the log were counted several times (now once), and subagent logs were never
// read (now included). Days older than the live window cannot be recomputed and keep their figures.
const ARCHIVE_REBUILD_TAG = '2.1.0-dedup-subagents';

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

// Models are the THIRD colour role (v2.0), next to token types and status. Four distinct hues
// rather than one ramp (Björn, 30.09.2026): model colours only ever appear inside clearly
// bounded, separately labelled figures — the model bar and the stacked daily chart — so the
// collision with token colours that a ramp was meant to avoid does not actually arise, and
// four hues stay far more legible in a stacked bar than four steps of one colour would.
// Hues picked from Björn's reference image; deliberately no green, yellow or red among them,
// so they can never be mistaken for a traffic-light verdict.
// The ORDER matters and is not cosmetic: these same four hues fail colour-blindness
// separation in other arrangements (blue beside violet measures ΔE 5.6 for deuteranopia —
// effectively the same colour). In this order every adjacent pair clears the gates.
const MODEL_COLORS = {
  Haiku:  '#0D9488',   // Teal
  Sonnet: '#4A90E2',   // Blue
  Opus:   '#EC4899',   // Pink
  Fable:  '#A855F7',   // Violet
  Other:  '#6B7280',   // Neutral
};

const DEFAULT_SETTINGS = {
  refreshSeconds: 30,
  reportPath:     'Token Usage Report.md',
  vaultReportPath: 'Vault_Token_Usage_Projects.md',
  dashboardPath:  'Token Usage Dashboard.html',
  archivePath:    'Token Usage Archive',
  csvPath:        'Token Usage Exports',
  archiveEnabled: true,
  reportPeriodDays: 30,
  language:       'en',
  // sidebarMode removed in v2.0 — Classic is gone, NextGen is the only sidebar. The stale
  // 'classic'/'nextgen' value in existing users' data.json is simply ignored from here on;
  // no migration needed because nothing reads the field any more.
  // Tracks the last plugin version the user has seen the "What's new" popup for.
  // null = never recorded yet. See AnthropicUsagePlugin._maybeShowWhatsNew().
  lastSeenVersion: null,
  // Which one-shot archive rebuild has already run. null = none yet.
  // Compared against ARCHIVE_REBUILD_TAG in _archiveDays().
  archiveRebuildDone: null,
  // calendarVisible removed in v2.0 — the calendar has its own rail page, so there is nothing
  // to toggle. A leftover `true`/`false` in an existing data.json is simply ignored.
  // Weekly reset calibration (v2.0). Anthropic sets the weekly reset per account; `/usage` in
  // Claude Code reports yours. null = never calibrated, in which case the plugin falls back to
  // Sunday 18:00 local and says so, rather than pretending the default is your actual schedule.
  weeklyResetDay:    null,  // 0 = Sunday … 6 = Saturday
  weeklyResetHour:   null,  // local hour, 0–23
  weeklyResetSetAt:  null,  // ISO timestamp of the calibration, shown back to the user
  weeklyResetSource: null,  // 'auto' = read from a weekly-limit message, 'manual' = user set it
  weeklyResetFrom:   null,  // timestamp of the hit it was read from (auto only)
  // Per-day free-text notes on the activity calendar (v1.9), keyed by 'YYYY-MM-DD'. Purely
  // local, never read by anything else in the plugin — a personal annotation layer only.
  dailyComments: {},
};

// Logo SVG — TU monogram (v2.0, Björn's design). Replaces the old bar-chart icon, which was a
// generic analytics symbol; the monogram is an actual mark of its own and stays recognisable
// down to 16px, which the rail needs. The T carries the "good" green, the U runs warning-yellow
// into critical-red: the traffic light IS the brand, so the logo says what the plugin measures.
// Drawn as strokes rather than filled letterforms so it needs no font and scales cleanly.
// The monogram LEADS the lockup and the wordmark is secondary — that is the hierarchy in
// Björn's logo design (30.09.2026), where a large TU sits above a smaller "Token Usage".
// So the mark is deliberately about twice the height of the text beside it (24 × 14.7 against
// a 10px wordmark), not sized down to match it. The exact value is tuned so it sits inside the
// lockup's border with a little air rather than filling it edge to edge.
//
// The viewBox is trimmed to the drawing itself (0.4 2.6 23.3 14.3) rather than a round
// 0 0 24 20: with the stroke width counted in, the glyphs span y 2.6–16.9, so the round box
// carried 2.6 of padding above and 3.1 below — a built-in, uneven margin that tilted the mark
// against anything placed next to it.
//
// display:block matters. An SVG defaults to inline, and an inline box sits on a text baseline
// with descender space reserved underneath it — which silently pushes the mark upward inside
// its container. As a block it has no baseline of its own, so the flex centring is the only
// thing positioning it.
const LOGO_SVG = `<svg width="24" height="14.7" viewBox="0.4 2.6 23.3 14.3" fill="none" aria-hidden="true" style="flex-shrink:0;display:block">
  <defs>
    <linearGradient id="tuU" x1="14.3" y1="3" x2="22.3" y2="16" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FAB219"/>
      <stop offset="1" stop-color="#D03B3B"/>
    </linearGradient>
  </defs>
  <path d="M1.8 4 H10.8 M6.3 4 V15.5" stroke="#0CA30C" stroke-width="2.8" stroke-linecap="round"/>
  <path d="M14.3 4 V11.5 A4 4 0 0 0 22.3 11.5 V4" stroke="url(#tuU)" stroke-width="2.8" stroke-linecap="round"/>
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
    body:  'When Claude processes a long context for the first time, it stores ("writes") it into a prompt cache. There are two kinds, priced differently: a 5-minute cache write costs 1.25× the input price, a 1-hour cache write costs 2×. In our own logs about 90% of the cache writes from Claude Code on a subscription were the 1-hour kind, while subagents wrote 5-minute caches. Hover over the C.Write row to see the split for that period. Cache writes also count toward the 5-hour limit (see "What counts toward a limit").',
  },
  {
    title: 'C.Read — Cache Read',
    body:  'Any follow-up request that reuses the same cached context is served at a fraction of the input price: 0.1× on most models, 0.05× on Opus 5.5 and Sonnet 5.5, 0.025× on Fable 5.1 (Anthropic pricing page, October 2026). A high C.Read value means you are working efficiently with the same material.',
  },
  {
    title: 'C.Write vs C.Read — what the ratio tells you',
    body:  'Reuse Factor = C.Read ÷ C.Write. High ratio → deep focus, same context across many requests. Low ratio → exploratory mode, constant context switches.\n\n≥ 8×  Deep focus — excellent cache return.\n3–8×  Balanced — focused work with some variety.\n1–3×  Exploratory — frequent new context.\n< 1×  Minimal reuse — mostly independent short sessions.',
  },
  {
    title: '5h Window',
    body:  'Anchored 5-hour window matching Claude\'s rate-limit period. It opens with your first message and runs exactly five hours. A new window only begins once that span has fully elapsed — windows are chained in fixed five-hour blocks; a pause in the middle of one does not start a fresh window, and working without a break does not keep one open past its five hours. It is not a rolling "last five hours". This is independent of the weekly reset: the weekly cap resets on its own schedule and does not force a new 5-hour window to start at the same time.\n"Claude 5h resets in: ~Xh Ym" counts down to the end of the open window.\n~ = approximation: session files are written after each response completes, not at session start. May lag 10–25 min. For the precise time, check Claude Code or claude.ai.',
  },
  {
    title: 'What counts toward a limit',
    // Rewritten 09.10.2026 (Björn): the old text said cache never counts and limits come from hits
    // only. Measurements against the official percentages contradict the first, the status line
    // feed changes the second. Same rewrite in all five languages.
    body:  'Anthropic enforces two limits and nothing else: the 5-hour window above, and a weekly cap that resets at a fixed weekday and hour. There is no daily limit, so the Today ring is not a quota (see "Today ring").\n\nInput and output tokens count. Cache is not free either: measurements against the official percentages (October 2026) indicate that cache writes clearly count and cache reads count a little. The figures in this plugin still count input and output only. When a long session has to rebuild its cache (a new 5-hour window after a pause, or a large context loaded for the first time), the official figure can therefore run ahead of the plugin. Long sessions with a large context use up the 5-hour window faster per answer than fresh, short ones.\n\nNeither limit is published in tokens. Without further setup, both estimates come from your own history, which is why the plugin can only show them once it has seen you hit a limit at least once. The weekly estimate from hits is the lowest week that ever reached the cap and can sit far too low, because cache use the plugin does not count also drives you into it. If a status line feed with the official percentages is present (~/.claude/ratelimit-log.jsonl), the plugin anchors both limits on it instead.',
  },
  {
    title: 'Today ring',
    body:  'There is no daily limit. Anthropic only limits the 5-hour window and the week. The Today ring compares what you have used today with your own average per active day, taken over every day Claude Code keeps on disk (your data retention setting). 200% means you are working twice as much as usual today, nothing more. That is why the ring stays grey: a busy day is a change in how you work, not a warning. How close you are to a limit is shown only by the rings for the 5-hour window and the week.',
  },
  {
    title: 'Activity heatmap',
    body:  'The grid on the Today page covers your current billing week. One row per calendar day, one cell per two hours, twelve cells a day.\n\nIt spans eight rows, not seven: a week running from Sunday 18:00 to Sunday 17:59 touches eight calendar dates, so the first and last rows are deliberately partial. Cells outside the window are drawn as empty outlines — that is what makes the boundary of your cycle visible.\n\nColour is pace, not volume. A 5-hour window holds two and a half 2-hour slots, so spending the whole window budget evenly means 40% of it per slot — the pace at which you arrive exactly at the wall as the window closes. Red marks that pace or faster; the bands below it are a quarter, a half and up to it. Shading within a band shows where inside it a cell sits.\n\nThree kinds of nothing are kept apart: outside the window (outline only), not yet reached (faint), and genuinely no activity (filled). Only the last one says anything about how your week went.\n\nBeside the grid, Active days counts the days of this billing week with any activity.',
  },
  {
    title: 'Exporting your data',
    body:  'Three CSV files: the project overview, the day-by-vault matrix, and the key figures. Two ways to get them, and they land in different places.\n\nCSV button in the sidebar header — the plugin writes the files into your vault, into the folder set under Settings → CSV export folder. The menu names that folder before you click. The same exports are in the command palette under "Export".\n\nCSV Export menu in the dashboard — the dashboard is a browser page, so it hands the file to your browser and the browser decides where it goes, usually your Downloads folder. A web page cannot choose a target folder; that is a browser rule, not a missing feature.\n\nBoth routes produce raw numbers and ISO dates, ready to calculate with. Everything is generated locally — no upload, no network, same as the rest of the plugin.',
  },
  {
    title: 'Weekly reset',
    body:  'The weekly limit resets at a fixed weekday and hour that differs per account. Everything week-shaped depends on it: the week ring, the forecast, the heatmap and the estimate itself.\n\nYou normally do not have to set this. When you hit a weekly limit, Claude writes the next reset time into the message, and the plugin reads it from there — Settings then shows a green check and the date of the hit it was taken from. Until that has happened at least once, it assumes Sunday 18:00 and says so.\n\nYou can set it by hand under Settings → Weekly reset. A manual setting wins: automatic detection will not overwrite it, it only confirms it. Worth re-checking after a daylight-saving change if your reset appears to have moved by an hour.',
  },
  {
    title: 'The three time views',
    body:  'Three independent cuts through the same data — they do not nest automatically.\n\nLast 5 Hour Session — the anchored window described above. Counts toward your usage limit.\n\nThis Session — all entries with the current session ID, regardless of calendar date. A Claude Code session can span multiple days. If you started a session yesterday and are still in it today, This Session will show more tokens than Today. That is expected — the session accumulates across calendar boundaries.\n\nToday — calendar day since midnight, regardless of which session the tokens came from.\n\nThe sub-label under each title shows its exact scope at a glance. Full explanation at langeatn.de/media/token-usage/',
  },
  {
    title: 'Rate limit estimates',
    body:  'Anthropic doesn\'t publish the actual token limit behind a rate-limit hit — it exists server-side and stays invisible. Token Usage makes it empirically visible instead: every detected rate-limit hit becomes a data point, and enough data points become an estimate of your own session and weekly limits (shown in the dashboard\'s budget banner and in the sidebar under Right Now, where the line beneath the three rings names the estimate and how many observed hits it rests on).\n\nBeneath it you also see a usual band, the middle half of your hits. The same limit is rarely reached at exactly the same total, because other Claude use that Token Usage cannot see (such as claude.ai in the browser) draws on the same limit, so one number alone would look more precise than it is.\n\nThe estimate isn\'t static — it quietly gets more precise the longer you use Claude Code. Every new rate-limit hit refines it further, so the number you see today is more reliable than the one from your first week.',
  },
  {
    title: 'The sidebar',
    body:  'An icon rail on the left switches between four pages.\n\nToday — three rings (5h window, today, this week), the activity heatmap for the current billing week, your last action, and the token breakdown. Everything here is from today or the current week; anything covering a longer span lives elsewhere by design.\n\nCalendar — the last two months as month grids.\n\nAnalytics — the 7-day and N-day summaries as colored KPI tiles with trend sparklines, plus the model distribution.\n\nSettings — the same settings as the Obsidian settings tab, without leaving the sidebar.\n\nIn the header: Dashboard and Report generate files, CSV exports into your vault, and the arrow forces an immediate refresh.\n\nEach of Today\'s four token rows carries a compact verdict marker — a green dot when close to your own recent average, an amber arrow when running noticeably higher. The comparison window follows your Claude data retention setting, not a fixed number of days.',
  },
  {
    title: 'Activity calendar',
    body:  'The Calendar page in the icon rail shows the last two months side by side. Two rather than one, because at the start of a month a single grid would show only a handful of usable days and hide exactly the run-up you are looking for. The arrows move the pair further back, as far as the archive reaches; the calendar never goes into the future.\n\nEach past day carries a colored dot sized against your own recent daily average: green below average, amber around it, red for a spike (2x or more). Days with no activity have no dot. Click any day to add a private note — it is stored in the plugin settings, never in your session data.',
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
    body:  'Input:        ~$3 / 1M tokens (Sonnet)\nOutput:       ~$15 / 1M tokens\nCache Write:  ~$3.75 / 1M tokens (+25%)\nCache Read:   ~$0.30 / 1M tokens (−90%)\n\nActual pricing depends on your plan and model. These figures illustrate why a high Reuse Factor reduces costs significantly.\n\nNote that cost and limits are two different things. Cache tokens cost money but do not move you toward the 5-hour or weekly limit — see "What counts toward a limit".',
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
    heatmapTitle:     'Activity Heatmap',
    heatmapCycle:     (range) => `Your billing week · ${range}`,
    timelineSub:      'One cell = 2 hours. Red is the pace that would empty a 5-hour window exactly as it closes.',
    heatLegendVhigh:  'Very high',
    heatLegendHigh:   'High',
    heatLegendMedium: 'Medium',
    heatLegendLow:    'Low',
    heatLegendEmpty:  'No activity',
    models:           'Models (last 7 days)',
    last5h:           'Current 5h Window',
    waiting:          'Waiting for next request...',
    anchoredWindow:   'Anchored window · counts toward rate limit',
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
    cwSplitTip:       (h1, m5) => `Cache writes: ${h1} for 1 hour (2x input price), ${m5} for 5 minutes (1.25x)`,
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
    activeDaysTitle:  'Active days',
    activeDaysSub:    'this billing week',
    csvBtnTitle:      'Export CSV files into your vault',
    csvMenuTarget:    (f) => `Writes into: ${f}`,
    csvMenuAll:       'All three files',
    csvMenuProjects:  'Projects overview',
    csvMenuDaily:     'Daily detail',
    csvMenuKpis:      'Key figures',
    settingCsv:       'CSV export folder in vault',
    settingCsvDesc:   'Vault-relative folder for CSV exports. Run one of the "Export … CSV" commands from the command palette and the files land here. The Dashboard also offers the same exports, but those are browser downloads and go wherever your browser puts them — a web page cannot choose a folder.',
    csvNoData:        'No data to export yet — open the Token Usage sidebar first.',
    csvFolderFailed:  (f) => `Could not create the export folder: ${f}`,
    csvWritten:       (n, f) => `${n} CSV file(s) written to ${f}`,
    settingArchiveEnabled:     'Enable daily archive',
    settingArchiveEnabledDesc: 'Writes a daily summary file automatically. Turn off if you don\'t want the plugin creating files in your vault.',
    settingReportPeriod:     'Report period',
    settingReportPeriodDesc: 'How far back the dashboard and report look. Beyond your Claude data retention, this is filled in from the daily archive — recent days stay live, older ones come from Token Usage Archive/.',
    verdictHigh:      (d) => `Higher than your ${d}-day average for this type — worth a glance.`,
    verdictNormal:    (d) => `Close to your ${d}-day average for this type.`,
    tileTotal:        'Total',
    tileCalls:        'Calls',
    tileActiveDays:   'Active days',
    tileAvgPerDay:    'Avg / active day',
    railOverview:     'Overview',
    railAnalytics:    'Analytics',
    railCalendar:     'Calendar',
    railSettings:     'Settings',
    settingReset:     'Weekly reset',
    settingResetDesc: 'One-off setup: run /usage in Claude Code, read when your weekly limit resets, and set it here. Anthropic assigns this per account — it is not the same for everyone. Until you do, the plugin assumes Sunday 18:00 and every week-based figure may be off.',
    settingResetAuto: (d) => `Detected automatically from your weekly-limit hit on ${d} — no setup needed. Change it below only if it looks wrong.`,
    settingResetDone: (d) => `Set manually on ${d}. Update it if your reset ever moves (for example after a daylight-saving change).`,
    calSun: 'Sunday', calMon: 'Monday', calTue: 'Tuesday', calWed: 'Wednesday',
    calThu: 'Thursday', calFri: 'Friday', calSat: 'Saturday',
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
    calNoteTitle:     (d) => `Note — ${d}`,
    calNotePlaceholder: 'Add a note about this day\'s usage (optional)...',
    calNoteSave:      'Save',
    calNoteDelete:    'Delete note',
    calNoteCancel:    'Cancel',
    calNoteAdd:       'Click to add a note',
    calNoteEdit:      'Click to edit note',
    limitPulseTitle:    'Right Now',
    limitPulse5h:       '5h Window',
    limitPulseOf5h:     (p) => `${p}% of est. 5h limit`,
    limitPulseBasis:    (n) => `5h limit estimated at {v} — median of ${n} observed limit hits in your own data.`,
    limitPulseBand:      (lo, hi) => `Usually between ${lo} and ${hi} (middle half of hits).`,
    limitPulseBasisFeed: `5h limit {v}, derived from the official percentage in your status line feed.`,
    limitPulseWeekFeed:  `Weekly limit {v}, derived from the official percentage in your status line feed.`,
    limitPulseToday:    'Today',
    limitPulseWeek:     'This Week',
    limitPulseOfDaily:  (p) => `${p}% of your usual day`,
    limitPulseOfWeekly: (p) => `${p}% of est. weekly limit`,
    limitPulseNoWeekly: 'Weekly limit not yet estimated — needs one observed weekly-limit hit.',
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
    heatmapTitle:     'Aktivitäts-Heatmap',
    heatmapCycle:     (range) => `Dein Abrechnungszyklus · ${range}`,
    timelineSub:      'Eine Zelle = 2 Stunden. Rot ist das Tempo, das ein 5-Stunden-Fenster genau zum Ablauf leer macht.',
    heatLegendVhigh:  'Sehr hoch',
    heatLegendHigh:   'Hoch',
    heatLegendMedium: 'Mittel',
    heatLegendLow:    'Niedrig',
    heatLegendEmpty:  'Keine Aktivität',
    models:           'Modelle (in den letzten 7 Tagen)',
    last5h:           'Aktuelles 5-Stunden-Fenster',
    waiting:          'Warte auf nächste Anfrage...',
    anchoredWindow:   'Verankertes Fenster · zählt zum Rate-Limit',
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
    cwSplitTip:       (h1, m5) => `Cache Writes: ${h1} für 1 Stunde (2x Input-Preis), ${m5} für 5 Minuten (1,25x)`,
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
    activeDaysTitle:  'Aktive Tage',
    activeDaysSub:    'in dieser Abrechnungswoche',
    csvBtnTitle:      'CSV-Dateien in deinen Vault exportieren',
    csvMenuTarget:    (f) => `Schreibt nach: ${f}`,
    csvMenuAll:       'Alle drei Dateien',
    csvMenuProjects:  'Projektübersicht',
    csvMenuDaily:     'Tagesdetail',
    csvMenuKpis:      'Kennzahlen',
    settingCsv:       'CSV-Export-Ordner im Vault',
    settingCsvDesc:   'Vault-relativer Ordner für CSV-Exporte. Einen der "Export … CSV"-Befehle aus der Befehlspalette ausführen, dann landen die Dateien hier. Das Dashboard bietet dieselben Exporte ebenfalls an, das sind aber Browser-Downloads und landen dort, wo dein Browser sie ablegt — eine Webseite kann keinen Ordner wählen.',
    csvNoData:        'Noch keine Daten zum Exportieren — öffne zuerst die Token-Usage-Seitenleiste.',
    csvFolderFailed:  (f) => `Export-Ordner konnte nicht angelegt werden: ${f}`,
    csvWritten:       (n, f) => `${n} CSV-Datei(en) geschrieben nach ${f}`,
    settingArchiveEnabled:     'Tägliches Archiv aktivieren',
    settingArchiveEnabledDesc: 'Schreibt automatisch eine tägliche Zusammenfassungsdatei. Ausschalten, wenn das Plugin keine Dateien im Vault anlegen soll.',
    settingReportPeriod:     'Berichtszeitraum',
    settingReportPeriodDesc: 'Wie weit Dashboard und Report zurückblicken. Über die eingestellte Claude-Datenaufbewahrung hinaus wird aus dem täglichen Archiv aufgefüllt — aktuelle Tage bleiben live, ältere kommen aus Token Usage Archive/.',
    verdictHigh:      (d) => `Höher als dein ${d}-Tage-Durchschnitt für diesen Typ — einen Blick wert.`,
    verdictNormal:    (d) => `Nahe an deinem ${d}-Tage-Durchschnitt für diesen Typ.`,
    tileTotal:        'Gesamt',
    tileCalls:        'Aufrufe',
    tileActiveDays:   'Aktive Tage',
    tileAvgPerDay:    'Ø / aktivem Tag',
    railOverview:     'Übersicht',
    railAnalytics:    'Auswertung',
    railCalendar:     'Kalender',
    railSettings:     'Einstellungen',
    settingReset:     'Wöchentlicher Reset',
    settingResetDesc: 'Einmalige Einrichtung: Führe /usage in Claude Code aus, lies ab, wann dein Wochenlimit zurückgesetzt wird, und trag es hier ein. Anthropic legt das pro Konto fest — es ist nicht für alle gleich. Bis dahin nimmt das Plugin Sonntag 18:00 an, und jede wochenbezogene Zahl kann daneben liegen.',
    settingResetAuto: (d) => `Automatisch erkannt aus deinem Wochenlimit-Treffer vom ${d} — keine Einrichtung nötig. Nur ändern, falls es falsch aussieht.`,
    settingResetDone: (d) => `Am ${d} manuell gesetzt. Anpassen, falls sich dein Reset verschiebt (etwa nach einer Zeitumstellung).`,
    calSun: 'Sonntag', calMon: 'Montag', calTue: 'Dienstag', calWed: 'Mittwoch',
    calThu: 'Donnerstag', calFri: 'Freitag', calSat: 'Samstag',
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
    calNoteTitle:     (d) => `Notiz — ${d}`,
    calNotePlaceholder: 'Notiz zum Tagesverbrauch hinzufügen (optional)...',
    calNoteSave:      'Speichern',
    calNoteDelete:    'Notiz löschen',
    calNoteCancel:    'Abbrechen',
    calNoteAdd:       'Klicken, um eine Notiz hinzuzufügen',
    calNoteEdit:      'Klicken, um die Notiz zu bearbeiten',
    limitPulseTitle:    'Aktueller Stand',
    limitPulse5h:       '5h-Fenster',
    limitPulseOf5h:     (p) => `${p}% des geschätzten 5h-Limits`,
    limitPulseBasis:    (n) => `5h-Limit geschätzt auf {v} — Median aus ${n} beobachteten Limit-Treffern in deinen eigenen Daten.`,
    limitPulseBand:      (lo, hi) => `Meist zwischen ${lo} und ${hi} (mittlere Hälfte der Treffer).`,
    limitPulseBasisFeed: `5h-Limit {v}, abgeleitet aus dem offiziellen Prozentwert in deinem Statusline-Feed.`,
    limitPulseWeekFeed:  `Wochenlimit {v}, abgeleitet aus dem offiziellen Prozentwert in deinem Statusline-Feed.`,
    limitPulseToday:    'Heute',
    limitPulseWeek:     'Diese Woche',
    limitPulseOfDaily:  (p) => `${p}% deines üblichen Tages`,
    limitPulseOfWeekly: (p) => `${p}% des geschätzten Wochenlimits`,
    limitPulseNoWeekly: 'Wochenlimit noch nicht geschätzt — braucht mindestens einen beobachteten Weekly-Limit-Hit.',
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
        body:  'Wenn Claude einen langen Kontext zum ersten Mal verarbeitet, speichert ("schreibt") er ihn in einen Prompt-Cache. Es gibt zwei Arten mit unterschiedlichem Preis: Ein 5-Minuten-Cache-Write kostet 1,25× des Input-Preises, ein 1-Stunden-Cache-Write 2×. In unseren eigenen Logs waren rund 90 % der Cache Writes von Claude Code im Abo die 1-Stunden-Art, Subagenten schrieben 5-Minuten-Caches. Fahr mit der Maus über die C.Write-Zeile, dann siehst du die Aufteilung für den Zeitraum. Cache Writes zählen außerdem auf das 5-Stunden-Limit (siehe "Was auf ein Limit einzahlt").',
      },
      {
        title: 'C.Read — Cache Read',
        body:  'Jede Folgeanfrage, die denselben gecachten Kontext wiederverwendet, kostet nur einen Bruchteil des Input-Preises: 0,1× bei den meisten Modellen, 0,05× bei Opus 5.5 und Sonnet 5.5, 0,025× bei Fable 5.1 (Preisseite von Anthropic, Oktober 2026). Ein hoher C.Read-Wert bedeutet effizientes Arbeiten mit gleichbleibendem Material.',
      },
      {
        title: 'C.Write vs. C.Read — was das Verhältnis aussagt',
        body:  'Wiederverwendungsfaktor = C.Read ÷ C.Write. Hoher Faktor → Tiefenfokus, gleicher Kontext über viele Anfragen. Niedriger Faktor → Erkundungsmodus, häufige Kontextwechsel.\n\n≥ 8×  Tiefenfokus — ausgezeichnete Cache-Rendite.\n3–8×  Ausgewogen — fokussiertes Arbeiten mit etwas Abwechslung.\n1–3×  Erkundend — häufig neuer Kontext.\n< 1×  Minimale Wiederverwendung — meist unabhängige Kurzsessions.',
      },
      {
        title: '5-Stunden-Fenster',
        body:  'Ein verankertes 5-Stunden-Fenster passend zu Claudes Rate-Limit-Zeitraum. Es öffnet mit deiner ersten Nachricht und läuft dann exakt fünf Stunden. Ein neues Fenster beginnt erst, wenn diese Zeitspanne vollständig abgelaufen ist — die Fenster sind in festen Fünf-Stunden-Blöcken verkettet; eine Pause mittendrin startet kein neues, und durchgängiges Arbeiten hält eines nicht über seine fünf Stunden hinaus offen. Es ist kein gleitendes "die letzten fünf Stunden". Das ist unabhängig vom Wochen-Reset: Das Wochenlimit setzt sich nach seinem eigenen Zeitplan zurück und erzwingt dabei kein neues 5-Stunden-Fenster.\n"Claude 5h-Fenster wird zurückgesetzt in: ~Xh Ym" zählt bis zum Ende des offenen Fensters herunter.\n~ = Näherungswert: Session-Dateien werden nach jeder abgeschlossenen Antwort geschrieben, nicht beim Start. Kann 10–25 Min. verzögert sein. Den genauen Zeitpunkt findest du in Claude Code oder auf claude.ai.',
      },
      {
        title: 'Was auf ein Limit einzahlt',
        body:  'Anthropic setzt zwei Limits durch und sonst keins: das 5-Stunden-Fenster oben und ein Wochenlimit, das an einem festen Wochentag zu einer festen Uhrzeit zurückgesetzt wird. Ein Tageslimit gibt es nicht, der Heute-Ring ist deshalb kein Kontingent (siehe "Der Heute-Ring").\n\nInput- und Output-Tokens zählen. Cache ist aber nicht umsonst: Messungen gegen die offiziellen Prozentwerte (Oktober 2026) deuten darauf hin, dass Cache Writes deutlich mitzählen und Cache Reads ein wenig. Die Zahlen im Plugin zählen weiterhin nur Input und Output. Muss eine lange Session ihren Cache neu aufbauen (neues 5-Stunden-Fenster nach einer Pause, großer Kontext zum ersten Mal geladen), kann der offizielle Wert dem Plugin deshalb vorauslaufen. Lange Sessions mit großem Kontext verbrauchen das 5-Stunden-Fenster pro Antwort schneller als frische, kurze.\n\nKeines der beiden Limits ist in Tokens veröffentlicht. Ohne weitere Einrichtung stammen beide Schätzungen aus deiner eigenen Historie, deshalb kann das Plugin sie erst zeigen, wenn es dich mindestens einmal in ein Limit laufen gesehen hat. Die Wochenschätzung aus Treffern ist die niedrigste Woche, die je ans Limit kam, und kann deutlich zu niedrig liegen, weil auch Cache, den das Plugin nicht zählt, dich ans Limit bringt. Liegt ein Statusline-Feed mit den offiziellen Prozentwerten vor (~/.claude/ratelimit-log.jsonl), verankert das Plugin beide Limits stattdessen daran.',
      },
      {
        title: 'Der Heute-Ring',
        body:  'Für den Tag gibt es kein Limit. Anthropic begrenzt nur das 5-Stunden-Fenster und die Woche. Der Heute-Ring vergleicht deinen heutigen Verbrauch mit deinem eigenen Schnitt pro aktivem Tag, gerechnet über alle Tage, die Claude Code aufbewahrt (deine Einstellung zur Datenaufbewahrung). 200 % heißt, dass du heute doppelt so viel arbeitest wie sonst, mehr nicht. Deshalb bleibt der Ring grau: Ein voller Tag ist eine geänderte Arbeitsweise, keine Warnung. Wie nah du an einem Limit bist, zeigen nur die Ringe für das 5-Stunden-Fenster und die Woche.',
      },
      {
        title: 'Aktivitäts-Heatmap',
        body:  'Das Raster auf der Today-Seite zeigt deine laufende Abrechnungswoche. Eine Zeile je Kalendertag, eine Zelle je zwei Stunden, zwölf Zellen pro Tag.\n\nEs hat acht Zeilen, nicht sieben: Eine Woche von Sonntag 18:00 bis Sonntag 17:59 berührt acht Kalendertage, die erste und die letzte Zeile sind deshalb bewusst Teiltage. Zellen außerhalb des Fensters sind nur als leere Rahmen gezeichnet — genau das macht die Grenze deines Zyklus sichtbar.\n\nDie Farbe zeigt das Tempo, nicht die Menge. Ein 5-Stunden-Fenster fasst zweieinhalb 2-Stunden-Abschnitte; das Budget gleichmäßig verbraucht sind also 40 % davon je Abschnitt — das Tempo, bei dem du exakt mit Ablauf des Fensters an die Wand kommst. Rot markiert dieses Tempo oder schneller, die Stufen darunter sind ein Viertel, die Hälfte und bis dahin. Die Tonabstufung innerhalb einer Stufe zeigt, wo darin ein Wert sitzt.\n\nDrei Arten von Nichts bleiben getrennt: außerhalb des Fensters (nur Rahmen), noch nicht erreicht (blass) und wirklich keine Aktivität (gefüllt). Nur das Letzte sagt etwas darüber aus, wie deine Woche lief.\n\nNeben dem Raster zählt "Aktive Tage" die Tage dieser Abrechnungswoche mit Aktivität.',
      },
      {
        title: 'Daten exportieren',
        body:  'Drei CSV-Dateien: die Projektübersicht, die Tag-mal-Vault-Matrix und die Kennzahlen. Zwei Wege dorthin, und sie landen an verschiedenen Orten.\n\nCSV-Button im Kopf der Seitenleiste — das Plugin schreibt die Dateien in deinen Vault, in den Ordner aus Settings → CSV-Export-Ordner. Das Menü nennt diesen Ordner, bevor du klickst. Dieselben Exporte liegen in der Befehlspalette unter "Export".\n\nCSV-Export-Menü im Dashboard — das Dashboard ist eine Browser-Seite, übergibt die Datei also dem Browser, und der entscheidet über den Ablageort, üblicherweise dein Download-Ordner. Eine Webseite kann keinen Zielordner wählen; das ist eine Browser-Regel, keine fehlende Funktion.\n\nBeide Wege liefern rohe Zahlen und ISO-Datumsangaben, direkt weiterrechenbar. Alles entsteht lokal — kein Upload, kein Netzwerk, wie im ganzen Plugin.',
      },
      {
        title: 'Wöchentlicher Reset',
        body:  'Das Wochenlimit wird an einem festen Wochentag zu einer festen Uhrzeit zurückgesetzt, und zwar je Konto unterschiedlich. Alles Wochenbezogene hängt daran: der Wochen-Ring, die Prognose, die Heatmap und die Schätzung selbst.\n\nNormalerweise musst du hier nichts einstellen. Wenn du in ein Wochenlimit läufst, schreibt Claude den nächsten Reset-Zeitpunkt in die Meldung, und das Plugin liest ihn von dort — die Einstellungen zeigen dann einen grünen Haken und das Datum des Treffers, aus dem der Wert stammt. Solange das noch nie passiert ist, nimmt es Sonntag 18:00 an und sagt das auch.\n\nVon Hand geht es unter Settings → Wöchentlicher Reset. Eine manuelle Einstellung gewinnt: Die automatische Erkennung überschreibt sie nicht, sie bestätigt sie nur. Nach einer Zeitumstellung lohnt ein Blick, falls dein Reset um eine Stunde verschoben wirkt.',
      },
      {
        title: 'Die drei unterschiedlichen Zeitansichten in der Übersicht',
        body:  'Es gibt drei unabhängige Ausschnitte aus denselben Daten — sie sind nicht automatisch ineinander verschachtelt.\n\nDie Letzte 5-Stunden-Session — das verankerte Fenster von oben. Zählt zu deinem Nutzungslimit.\n\nDiese Session — alle Einträge mit der aktuellen Session-ID, unabhängig vom Kalenderdatum. Eine Claude Code Session kann mehrere Tage umfassen. Wenn du eine Session gestern begonnen hast und heute noch darin weiterarbeitest, zeigt "Diese Session" mehr Tokens als "Heute". Das ist so gewollt und designt — die Session akkumuliert über Kalendergrenzen hinweg.\n\nHeute — Kalendertag seit Mitternacht, unabhängig davon, aus welcher Session die Token stammen.\n\nDie Beschreibung unter jedem Titel zeigt den genauen Geltungsbereich auf einen Blick. Du findest eine vollständige Erklärung auf langeatn.de/media/token-usage/',
      },
      {
        title: 'Empirische Limit-Schätzung',
        body:  'Anthropic veröffentlicht das tatsächliche Token-Limit hinter einem Rate-Limit-Hit nicht — es existiert serverseitig und bleibt unsichtbar. Token Usage macht es stattdessen empirisch sichtbar: jeder erkannte Rate-Limit-Hit wird zu einem Datenpunkt, und genug Datenpunkte ergeben eine Schätzung deines eigenen Session- und Wochenlimits (zu sehen im Budget-Banner des Dashboards und in der Seitenleiste unter "Aktueller Stand", wo die Zeile unter den drei Ringen die Schätzung nennt und auf wie vielen beobachteten Treffern sie beruht).\n\nDarunter siehst du außerdem ein übliches Band, die mittlere Hälfte deiner Treffer. Dasselbe Limit wird selten bei exakt derselben Summe erreicht, weil auch anderes Claude-Nutzen, das Token Usage nicht sehen kann (etwa claude.ai im Browser), am selben Limit zehrt. Eine einzelne Zahl würde genauer wirken, als sie ist.\n\nDie Schätzung ist nicht statisch — sie wird mit der Zeit ganz automatisch präziser, je länger du Claude Code nutzt. Jeder neue Rate-Limit-Hit verfeinert sie weiter, sodass die Zahl, die du heute siehst, verlässlicher ist als die aus deiner ersten Woche.',
      },
      {
        title: 'Die Seitenleiste',
        body:  'Eine Icon-Leiste links wechselt zwischen vier Seiten.\n\nToday — drei Ringe (5h-Fenster, Heute, diese Woche), die Aktivitäts-Heatmap der laufenden Abrechnungswoche, deine letzte Aktion und die Token-Aufschlüsselung. Alles hier stammt von heute oder aus der laufenden Woche; alles mit längerem Zeitraum liegt bewusst woanders.\n\nKalender — die letzten zwei Monate als Monatsraster.\n\nAnalytics — die 7-Tage- und N-Tage-Zusammenfassungen als farbige KPI-Kacheln mit Trend-Sparklines, dazu die Modellverteilung.\n\nSettings — dieselben Einstellungen wie im Obsidian-Einstellungstab, ohne die Seitenleiste zu verlassen.\n\nIm Kopfbereich: Dashboard und Report erzeugen Dateien, CSV exportiert in deinen Vault, der Pfeil aktualisiert sofort.\n\nJede der vier Token-Zeilen im Heute-Bereich trägt eine kompakte Verdict-Markierung — ein grüner Punkt, wenn der Wert nahe an deinem eigenen aktuellen Durchschnitt liegt, ein gelber Pfeil, wenn er deutlich darüber liegt. Das Vergleichsfenster richtet sich nach deiner eingestellten Claude-Datenaufbewahrung, nicht nach einer festen Anzahl Tage.',
      },
      {
        title: 'Aktivitätskalender',
        body:  'Die Kalender-Seite in der Icon-Leiste zeigt die letzten zwei Monate untereinander. Zwei statt einem, weil ein einzelnes Raster am Monatsanfang nur eine Handvoll brauchbarer Tage zeigt und genau den Anlauf verbirgt, den man dort sucht. Die Pfeile verschieben das Paar weiter zurück, so weit das Archiv reicht; in die Zukunft geht der Kalender nie.\n\nJeder vergangene Tag trägt einen farbigen Punkt, gewichtet gegen deinen eigenen jüngsten Tagesdurchschnitt: grün darunter, gelb um den Schnitt herum, rot bei einem Ausschlag (2x oder mehr). Tage ohne Aktivität haben keinen Punkt. Ein Klick auf einen Tag legt eine private Notiz an — sie liegt in den Plugin-Einstellungen, nie in deinen Session-Daten.',
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
        body:  'Input:        ~3 $ / 1M Token (Sonnet)\nOutput:       ~15 $ / 1M Token\nCache Write:  ~3,75 $ / 1M Token (+25 %)\nCache Read:   ~0,30 $ / 1M Token (−90 %)\n\nDie tatsächlichen Preise hängen von deinem Plan und Modell ab. Diese Werte verdeutlichen, warum ein hoher Wiederverwendungsfaktor die Kosten erheblich senkt.\n\nKosten und Limits sind zweierlei: Cache-Tokens kosten Geld, bringen dich aber dem 5-Stunden- oder Wochenlimit nicht näher — siehe "Was auf ein Limit einzahlt".',
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
    heatmapTitle:     "Carte d'activité",
    heatmapCycle:     (range) => `Votre cycle de facturation · ${range}`,
    timelineSub:      'Une case = 2 heures. Le rouge correspond au rythme qui épuise une fenêtre de 5 heures juste à sa fermeture.',
    heatLegendVhigh:  'Très élevé',
    heatLegendHigh:   'Élevé',
    heatLegendMedium: 'Moyen',
    heatLegendLow:    'Faible',
    heatLegendEmpty:  'Aucune activité',
    models:           'Modèles (7 derniers jours)',
    last5h:           'Fenêtre de 5 h en cours',
    waiting:          'En attente de la prochaine requête...',
    anchoredWindow:   'Fenêtre ancrée · prise en compte dans la limite de débit',
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
    cwSplitTip:       (h1, m5) => `Écritures de cache : ${h1} pour 1 heure (2x le prix d’entrée), ${m5} pour 5 minutes (1,25x)`,
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
    activeDaysTitle:  'Jours actifs',
    activeDaysSub:    'cette semaine de facturation',
    csvBtnTitle:      'Exporter les fichiers CSV dans votre vault',
    csvMenuTarget:    (f) => `Écrit dans : ${f}`,
    csvMenuAll:       'Les trois fichiers',
    csvMenuProjects:  'Vue des projets',
    csvMenuDaily:     'Détail quotidien',
    csvMenuKpis:      'Indicateurs clés',
    settingCsv:       'Dossier d\'export CSV dans le vault',
    settingCsvDesc:   'Dossier relatif au vault pour les exports CSV. Lancez une des commandes « Export … CSV » depuis la palette de commandes et les fichiers arrivent ici. Le tableau de bord propose les mêmes exports, mais ce sont des téléchargements du navigateur : ils vont là où votre navigateur les place, une page web ne peut pas choisir un dossier.',
    csvNoData:        'Aucune donnée à exporter pour le moment — ouvrez d\'abord la barre latérale Token Usage.',
    csvFolderFailed:  (f) => `Impossible de créer le dossier d'export : ${f}`,
    csvWritten:       (n, f) => `${n} fichier(s) CSV écrit(s) dans ${f}`,
    settingArchiveEnabled:     'Activer l\'archive quotidienne',
    settingArchiveEnabledDesc: 'Écrit automatiquement un fichier récapitulatif quotidien. Désactivez si vous ne souhaitez pas que le plugin crée des fichiers dans votre vault.',
    settingReportPeriod:     'Période du rapport',
    settingReportPeriodDesc: 'Jusqu\'où le tableau de bord et le rapport remontent. Au-delà de votre conservation des données Claude, la période est complétée depuis l\'archive quotidienne — les jours récents restent en direct, les plus anciens proviennent de Token Usage Archive/.',
    verdictHigh:      (d) => `Plus élevé que votre moyenne sur ${d} jours pour ce type — à surveiller.`,
    verdictNormal:    (d) => `Proche de votre moyenne sur ${d} jours pour ce type.`,
    tileTotal:        'Total',
    tileCalls:        'Appels',
    tileActiveDays:   'Jours actifs',
    tileAvgPerDay:    'Moy. / jour actif',
    railOverview:     'Aperçu',
    railAnalytics:    'Analyse',
    railCalendar:     'Calendrier',
    railSettings:     'Paramètres',
    settingReset:     'Réinitialisation hebdomadaire',
    settingResetDesc: 'Configuration unique : lancez /usage dans Claude Code, relevez le moment où votre limite hebdomadaire est réinitialisée et indiquez-le ici. Anthropic le définit par compte — ce n\'est pas le même pour tout le monde. En attendant, le plugin suppose dimanche 18:00 et toute valeur hebdomadaire peut être fausse.',
    settingResetAuto: (d) => `Détecté automatiquement à partir de votre dépassement hebdomadaire du ${d} — aucune configuration requise. À modifier seulement si cela semble incorrect.`,
    settingResetDone: (d) => `Défini manuellement le ${d}. À mettre à jour si votre réinitialisation change (par exemple après un changement d\'heure).`,
    calSun: 'Dimanche', calMon: 'Lundi', calTue: 'Mardi', calWed: 'Mercredi',
    calThu: 'Jeudi', calFri: 'Vendredi', calSat: 'Samedi',
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
    calNoteTitle:     (d) => `Note — ${d}`,
    calNotePlaceholder: 'Ajouter une note sur la consommation de ce jour (facultatif)...',
    calNoteSave:      'Enregistrer',
    calNoteDelete:    'Supprimer la note',
    calNoteCancel:    'Annuler',
    calNoteAdd:       'Cliquez pour ajouter une note',
    calNoteEdit:      'Cliquez pour modifier la note',
    limitPulseTitle:    'Situation actuelle',
    limitPulse5h:       'Fenêtre 5h',
    limitPulseOf5h:     (p) => `${p}% de la limite 5h estimée`,
    limitPulseBasis:    (n) => `Limite 5h estimée à {v} — médiane de ${n} dépassements observés dans vos propres données.`,
    limitPulseBand:      (lo, hi) => `En général entre ${lo} et ${hi} (moitié centrale des dépassements).`,
    limitPulseBasisFeed: `Limite 5h {v}, déduite du pourcentage officiel de votre flux de ligne d'état.`,
    limitPulseWeekFeed:  `Limite hebdomadaire {v}, déduite du pourcentage officiel de votre flux de ligne d'état.`,
    limitPulseToday:    'Aujourd\'hui',
    limitPulseWeek:     'Cette semaine',
    limitPulseOfDaily:  (p) => `${p}% de votre journée habituelle`,
    limitPulseOfWeekly: (p) => `${p}% de la limite hebdomadaire estimée`,
    limitPulseNoWeekly: 'Limite hebdomadaire pas encore estimée — nécessite au moins un dépassement hebdomadaire observé.',
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
        body:  'Lorsque Claude traite un long contexte pour la première fois, il le stocke (« écrit ») dans un cache de prompt. Il en existe deux types, facturés différemment : une écriture de cache de 5 minutes coûte 1,25× le prix d\'Input, une écriture de cache d\'1 heure coûte 2×. Dans nos propres journaux, environ 90 % des écritures de cache de Claude Code sur un abonnement étaient du type 1 heure, tandis que les sous-agents écrivaient des caches de 5 minutes. Survolez la ligne C.Write pour voir la répartition sur la période. Les écritures de cache comptent aussi pour la limite de 5 heures (voir « Ce qui compte pour une limite »).',
      },
      {
        title: 'C.Read — Cache Read',
        body:  'Toute requête de suivi qui réutilise le même contexte mis en cache ne coûte qu\'une fraction du prix d\'Input : 0,1× sur la plupart des modèles, 0,05× sur Opus 5.5 et Sonnet 5.5, 0,025× sur Fable 5.1 (page de tarifs d\'Anthropic, octobre 2026). Une valeur C.Read élevée indique que vous travaillez efficacement avec le même contenu.',
      },
      {
        title: 'C.Write vs C.Read — ce que le ratio indique',
        body:  'Facteur de réutilisation = C.Read ÷ C.Write. Ratio élevé → concentration approfondie, même contexte pour de nombreuses requêtes. Ratio faible → mode exploratoire, changements constants de contexte.\n\n≥ 8×  Concentration approfondie — excellent rendement du cache.\n3–8×  Équilibré — travail ciblé avec une certaine variété.\n1–3×  Exploratoire — nouveau contexte fréquent.\n< 1×  Réutilisation minimale — principalement de courtes sessions indépendantes.',
      },
      {
        title: 'Fenêtre de 5 h',
        body:  'Fenêtre ancrée de 5 heures correspondant à la période de limitation de débit de Claude. Elle s\'ouvre avec votre premier message et dure exactement cinq heures. Une nouvelle fenêtre ne commence qu\'une fois ce délai entièrement écoulé — les fenêtres s\'enchaînent par blocs fixes de cinq heures ; une pause au milieu n\'en déclenche pas une nouvelle, et travailler sans interruption n\'en maintient pas une ouverte au-delà de ses cinq heures. Ce n\'est pas une fenêtre glissante des « cinq dernières heures ». Ceci est indépendant de la réinitialisation hebdomadaire : le plafond hebdomadaire se réinitialise selon son propre calendrier et ne force pas le démarrage d\'une nouvelle fenêtre de 5 heures au même moment.\n« Réinitialisation des 5 h de Claude dans : ~Xh Ym » décompte jusqu\'à la fin de la fenêtre ouverte.\n~ = approximation : les fichiers de session sont écrits après la fin de chaque réponse, et non au début de la session. Un décalage de 10 à 25 min est possible. Pour l\'heure exacte, consultez Claude Code ou claude.ai.',
      },
      {
        title: 'Ce qui compte pour une limite',
        body:  'Anthropic applique deux limites et rien d\'autre : la fenêtre de 5 heures ci-dessus et un plafond hebdomadaire réinitialisé un jour et à une heure fixes. Il n\'existe pas de limite quotidienne, l\'anneau « Aujourd\'hui » n\'est donc pas un quota (voir « L\'anneau Aujourd\'hui »).\n\nLes tokens d\'entrée et de sortie comptent. Le cache n\'est pas gratuit pour autant : des mesures comparées aux pourcentages officiels (octobre 2026) indiquent que les écritures de cache comptent nettement et les lectures de cache un peu. Les chiffres du plugin ne comptent toujours que l\'entrée et la sortie. Lorsqu\'une longue session doit reconstruire son cache (nouvelle fenêtre de 5 heures après une pause, grand contexte chargé pour la première fois), le chiffre officiel peut donc devancer le plugin. Les longues sessions au contexte volumineux consomment la fenêtre de 5 heures plus vite par réponse que les sessions courtes et récentes.\n\nAucune des deux limites n\'est publiée en tokens. Sans configuration supplémentaire, les deux estimations proviennent de votre propre historique : le plugin ne peut donc les afficher qu\'après vous avoir vu atteindre une limite au moins une fois. L\'estimation hebdomadaire issue des dépassements correspond à la semaine la plus basse ayant atteint le plafond et peut être nettement trop basse, car le cache que le plugin ne compte pas vous y mène aussi. Si un flux de ligne d\'état contenant les pourcentages officiels est présent (~/.claude/ratelimit-log.jsonl), le plugin y ancre les deux limites.',
      },
      {
        title: 'L\'anneau Aujourd\'hui',
        body:  'Il n\'existe pas de limite quotidienne. Anthropic limite uniquement la fenêtre de 5 heures et la semaine. L\'anneau « Aujourd\'hui » compare votre consommation du jour à votre propre moyenne par jour actif, calculée sur tous les jours que Claude Code conserve (votre réglage de conservation des données). 200 % signifie que vous travaillez deux fois plus que d\'habitude aujourd\'hui, rien de plus. C\'est pourquoi l\'anneau reste gris : une journée chargée est un changement dans votre façon de travailler, pas un avertissement. Seuls les anneaux de la fenêtre de 5 heures et de la semaine indiquent à quel point vous êtes proche d\'une limite.',
      },
      {
        title: 'Carte thermique d\'activité',
        body:  'La grille sur la page Today couvre votre semaine de facturation en cours. Une ligne par jour calendaire, une case par tranche de deux heures, douze cases par jour.\n\nElle compte huit lignes et non sept : une semaine allant du dimanche 18:00 au dimanche 17:59 touche huit dates calendaires, les première et dernière lignes sont donc volontairement partielles. Les cases hors de la fenêtre sont dessinées en contour vide — c\'est ce qui rend visible la limite de votre cycle.\n\nLa couleur indique le rythme, pas le volume. Une fenêtre de 5 heures contient deux tranches et demie de 2 heures ; consommer tout le budget de façon régulière représente donc 40 % par tranche — le rythme qui vous amène exactement au mur à la fermeture de la fenêtre. Le rouge marque ce rythme ou plus rapide ; les paliers en dessous sont un quart, la moitié et jusqu\'à ce rythme. La nuance au sein d\'un palier indique où s\'y situe la valeur.\n\nTrois sortes de vide restent distinctes : hors fenêtre (contour seul), pas encore atteint (pâle) et réellement aucune activité (plein). Seule la dernière dit quelque chose sur le déroulement de votre semaine.\n\nÀ côté de la grille, « Jours actifs » compte les jours de cette semaine de facturation avec de l\'activité.',
      },
      {
        title: 'Exporter vos données',
        body:  'Trois fichiers CSV : la vue des projets, la matrice jour par vault et les indicateurs clés. Deux chemins pour les obtenir, et ils n\'aboutissent pas au même endroit.\n\nBouton CSV dans l\'en-tête de la barre latérale — le plugin écrit les fichiers dans votre vault, dans le dossier défini sous Réglages → Dossier d\'export CSV. Le menu nomme ce dossier avant que vous cliquiez. Les mêmes exports figurent dans la palette de commandes sous « Export ».\n\nMenu CSV Export du tableau de bord — le tableau de bord est une page web, il remet donc le fichier au navigateur, et c\'est le navigateur qui décide où il atterrit, généralement votre dossier de téléchargements. Une page web ne peut pas choisir un dossier cible ; c\'est une règle du navigateur, pas une fonction manquante.\n\nLes deux chemins produisent des nombres bruts et des dates ISO, directement exploitables. Tout est généré localement — aucun envoi, aucun réseau, comme le reste du plugin.',
      },
      {
        title: 'Réinitialisation hebdomadaire',
        body:  'La limite hebdomadaire se réinitialise un jour et à une heure fixes, qui diffèrent selon le compte. Tout ce qui concerne la semaine en dépend : l\'anneau hebdomadaire, la prévision, la carte thermique et l\'estimation elle-même.\n\nEn principe, vous n\'avez rien à régler. Lorsque vous atteignez une limite hebdomadaire, Claude inscrit la prochaine heure de réinitialisation dans le message, et le plugin la lit depuis là — les réglages affichent alors une coche verte et la date du dépassement dont la valeur provient. Tant que cela n\'est jamais arrivé, il suppose dimanche 18:00 et le dit.\n\nVous pouvez le définir à la main sous Réglages → Réinitialisation hebdomadaire. Un réglage manuel l\'emporte : la détection automatique ne l\'écrase pas, elle ne fait que le confirmer. Un coup d\'œil s\'impose après un changement d\'heure si votre réinitialisation semble avoir bougé d\'une heure.',
      },
      {
        title: 'Les trois vues temporelles',
        body:  'Trois découpages indépendants des mêmes données — ils ne sont pas automatiquement imbriqués.\n\nDernière session de 5 heures — la fenêtre ancrée décrite plus haut. Elle est prise en compte dans votre limite d\'utilisation.\n\nCette session — toutes les entrées portant l\'ID de la session actuelle, quelle que soit la date. Une session Claude Code peut s\'étendre sur plusieurs jours. Si vous avez commencé une session hier et la poursuivez aujourd\'hui, Cette session affichera plus de tokens qu\'Aujourd\'hui. C\'est normal — la session s\'accumule au-delà des limites calendaires.\n\nAujourd\'hui — jour calendaire depuis minuit, indépendamment de la session d\'origine des tokens.\n\nLe sous-libellé sous chaque titre indique immédiatement son périmètre exact. Explication complète sur langeatn.de/media/token-usage/',
      },
      {
        title: 'Estimation empirique des limites',
        body:  'Anthropic ne publie pas la limite de tokens réelle derrière un rate-limit hit — elle existe côté serveur et reste invisible. Token Usage la rend visible de façon empirique : chaque rate-limit hit détecté devient un point de données, et suffisamment de points de données donnent une estimation de vos propres limites de session et hebdomadaire (visibles dans la bannière budget du tableau de bord et dans la barre latérale sous « Situation actuelle », où la ligne sous les trois anneaux indique l\'estimation et le nombre de dépassements observés sur lesquels elle repose).\n\nEn dessous, vous voyez aussi une plage habituelle, la moitié centrale de vos dépassements. La même limite est rarement atteinte au même total exact, car d\'autres usages de Claude que Token Usage ne voit pas (par exemple claude.ai dans le navigateur) puisent dans la même limite. Un chiffre seul paraîtrait plus précis qu\'il ne l\'est.\n\nCette estimation n\'est pas statique — elle devient discrètement plus précise à mesure que vous utilisez Claude Code. Chaque nouveau rate-limit hit l\'affine davantage, si bien que le chiffre affiché aujourd\'hui est plus fiable que celui de votre première semaine.',
      },
      {
        title: 'La barre latérale',
        body:  'Une barre d\'icônes à gauche permet de passer entre quatre pages.\n\nToday — trois anneaux (fenêtre 5h, aujourd\'hui, cette semaine), la carte thermique d\'activité de la semaine de facturation en cours, votre dernière action et la répartition des tokens. Tout ici provient d\'aujourd\'hui ou de la semaine en cours ; ce qui couvre une période plus longue se trouve volontairement ailleurs.\n\nCalendrier — les deux derniers mois sous forme de grilles mensuelles.\n\nAnalytics — les résumés sur 7 jours et N jours en tuiles KPI colorées avec sparklines, ainsi que la répartition par modèle.\n\nSettings — les mêmes réglages que dans l\'onglet des paramètres d\'Obsidian, sans quitter la barre latérale.\n\nDans l\'en-tête : Dashboard et Report génèrent des fichiers, CSV exporte dans votre vault, et la flèche actualise immédiatement.\n\nChacune des quatre lignes de tokens d\'Aujourd\'hui porte un repère compact — un point vert lorsque la valeur est proche de votre moyenne récente, une flèche ambre lorsqu\'elle est nettement plus élevée. La fenêtre de comparaison suit votre réglage de conservation des données Claude, pas un nombre de jours fixe.',
      },
      {
        title: 'Calendrier d\'activité',
        body:  'La page Calendrier dans la barre d\'icônes affiche les deux derniers mois l\'un sous l\'autre. Deux plutôt qu\'un, car en début de mois une seule grille ne montre qu\'une poignée de jours utiles et masque précisément la montée en charge que l\'on cherche. Les flèches déplacent la paire vers le passé, aussi loin que l\'archive le permet ; le calendrier ne va jamais dans le futur.\n\nChaque jour passé porte une pastille colorée, pondérée par rapport à votre propre moyenne quotidienne récente : vert en dessous, ambre autour, rouge pour un pic (2x ou plus). Les jours sans activité n\'ont pas de pastille. Un clic sur un jour ajoute une note privée — elle est stockée dans les réglages du plugin, jamais dans vos données de session.',
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
        body:  'Input:        ~3 $ / 1 M de tokens (Sonnet)\nOutput:       ~15 $ / 1 M de tokens\nCache Write:  ~3,75 $ / 1 M de tokens (+25 %)\nCache Read:   ~0,30 $ / 1 M de tokens (−90 %)\n\nLe tarif réel dépend de votre forfait et du modèle. Ces chiffres illustrent pourquoi un facteur de réutilisation élevé réduit considérablement les coûts.\n\nCoût et limites sont deux choses distinctes : les tokens de cache coûtent de l\'argent mais ne vous rapprochent ni de la limite 5h ni de la limite hebdomadaire — voir « Ce qui compte pour une limite ».',
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
    heatmapTitle:     'Mappa di attività',
    heatmapCycle:     (range) => `Il tuo ciclo di fatturazione · ${range}`,
    timelineSub:      'Una cella = 2 ore. Il rosso è il ritmo che svuota una finestra di 5 ore esattamente alla sua chiusura.',
    heatLegendVhigh:  'Molto alto',
    heatLegendHigh:   'Alto',
    heatLegendMedium: 'Medio',
    heatLegendLow:    'Basso',
    heatLegendEmpty:  'Nessuna attività',
    models:           'Modelli (ultimi 7 giorni)',
    last5h:           'Finestra di 5 ore corrente',
    waiting:          'In attesa della prossima richiesta...',
    anchoredWindow:   'Finestra ancorata · conteggiata nel limite di utilizzo',
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
    cwSplitTip:       (h1, m5) => `Scritture di cache: ${h1} per 1 ora (2x il prezzo di input), ${m5} per 5 minuti (1,25x)`,
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
    activeDaysTitle:  'Giorni attivi',
    activeDaysSub:    'in questa settimana di fatturazione',
    csvBtnTitle:      'Esporta i file CSV nel tuo vault',
    csvMenuTarget:    (f) => `Scrive in: ${f}`,
    csvMenuAll:       'Tutti e tre i file',
    csvMenuProjects:  'Panoramica progetti',
    csvMenuDaily:     'Dettaglio giornaliero',
    csvMenuKpis:      'Indicatori chiave',
    settingCsv:       'Cartella di esportazione CSV nel vault',
    settingCsvDesc:   'Cartella relativa al vault per le esportazioni CSV. Esegui uno dei comandi «Export … CSV» dalla palette dei comandi e i file arrivano qui. Anche la dashboard offre le stesse esportazioni, ma sono download del browser e finiscono dove li mette il browser — una pagina web non può scegliere una cartella.',
    csvNoData:        'Nessun dato da esportare — apri prima la barra laterale Token Usage.',
    csvFolderFailed:  (f) => `Impossibile creare la cartella di esportazione: ${f}`,
    csvWritten:       (n, f) => `${n} file CSV scritti in ${f}`,
    settingArchiveEnabled:     'Abilita archivio giornaliero',
    settingArchiveEnabledDesc: 'Scrive automaticamente un file di riepilogo giornaliero. Disattiva se non vuoi che il plugin crei file nel tuo vault.',
    settingReportPeriod:     'Periodo del report',
    settingReportPeriodDesc: 'Fino a quando indietro guardano dashboard e report. Oltre la conservazione dei dati Claude impostata, il periodo viene completato dall\'archivio giornaliero — i giorni recenti restano live, quelli più vecchi provengono da Token Usage Archive/.',
    verdictHigh:      (d) => `Più alto della tua media di ${d} giorni per questo tipo — vale la pena controllare.`,
    verdictNormal:    (d) => `Vicino alla tua media di ${d} giorni per questo tipo.`,
    tileTotal:        'Totale',
    tileCalls:        'Chiamate',
    tileActiveDays:   'Giorni attivi',
    tileAvgPerDay:    'Media / giorno attivo',
    railOverview:     'Panoramica',
    railAnalytics:    'Analisi',
    railCalendar:     'Calendario',
    railSettings:     'Impostazioni',
    settingReset:     'Reset settimanale',
    settingResetDesc: 'Configurazione una tantum: esegui /usage in Claude Code, leggi quando viene azzerato il tuo limite settimanale e impostalo qui. Anthropic lo assegna per account — non è uguale per tutti. Fino ad allora il plugin presume domenica 18:00 e ogni valore settimanale può essere errato.',
    settingResetAuto: (d) => `Rilevato automaticamente dal tuo superamento settimanale del ${d} — nessuna configurazione necessaria. Modificalo solo se sembra sbagliato.`,
    settingResetDone: (d) => `Impostato manualmente il ${d}. Aggiornalo se il reset cambia (per esempio dopo il cambio dell\'ora).`,
    calSun: 'Domenica', calMon: 'Lunedì', calTue: 'Martedì', calWed: 'Mercoledì',
    calThu: 'Giovedì', calFri: 'Venerdì', calSat: 'Sabato',
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
    calNoteTitle:     (d) => `Nota — ${d}`,
    calNotePlaceholder: 'Aggiungi una nota sul consumo di oggi (facoltativo)...',
    calNoteSave:      'Salva',
    calNoteDelete:    'Elimina nota',
    calNoteCancel:    'Annulla',
    calNoteAdd:       'Clicca per aggiungere una nota',
    calNoteEdit:      'Clicca per modificare la nota',
    limitPulseTitle:    'Situazione attuale',
    limitPulse5h:       'Finestra 5h',
    limitPulseOf5h:     (p) => `${p}% del limite 5h stimato`,
    limitPulseBasis:    (n) => `Limite 5h stimato a {v} — mediana di ${n} limiti osservati nei tuoi dati.`,
    limitPulseBand:      (lo, hi) => `Di solito tra ${lo} e ${hi} (metà centrale dei limiti).`,
    limitPulseBasisFeed: `Limite 5h {v}, ricavato dalla percentuale ufficiale nel feed della tua status line.`,
    limitPulseWeekFeed:  `Limite settimanale {v}, ricavato dalla percentuale ufficiale nel feed della tua status line.`,
    limitPulseToday:    'Oggi',
    limitPulseWeek:     'Questa settimana',
    limitPulseOfDaily:  (p) => `${p}% della tua giornata tipica`,
    limitPulseOfWeekly: (p) => `${p}% del limite settimanale stimato`,
    limitPulseNoWeekly: 'Limite settimanale non ancora stimato — serve almeno un limite settimanale osservato.',
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
        body:  'Quando Claude elabora per la prima volta un contesto lungo, lo memorizza («scrive») in una cache del prompt. Ne esistono due tipi, con prezzi diversi: una scrittura di cache da 5 minuti costa 1,25 volte il prezzo dell\'input, una da 1 ora costa 2 volte. Nei nostri log, circa il 90 % delle scritture di cache di Claude Code in abbonamento era del tipo da 1 ora, mentre i subagenti scrivevano cache da 5 minuti. Passa il mouse sulla riga C.Write per vedere la ripartizione nel periodo. Le scritture di cache contano anche per il limite di 5 ore (vedi «Cosa conta per un limite»).',
      },
      {
        title: 'C.Read — Cache Read',
        body:  'Ogni richiesta successiva che riutilizza lo stesso contesto memorizzato nella cache costa solo una frazione del prezzo dell\'input: 0,1 volte sulla maggior parte dei modelli, 0,05 volte su Opus 5.5 e Sonnet 5.5, 0,025 volte su Fable 5.1 (pagina dei prezzi di Anthropic, ottobre 2026). Un valore C.Read elevato indica che stai lavorando in modo efficiente con lo stesso materiale.',
      },
      {
        title: 'C.Write vs C.Read — cosa indica il rapporto',
        body:  'Fattore di riutilizzo = C.Read ÷ C.Write. Rapporto elevato → concentrazione profonda, stesso contesto per molte richieste. Rapporto basso → modalità esplorativa, continui cambi di contesto.\n\n≥ 8×  Concentrazione profonda — rendimento eccellente della cache.\n3–8×  Bilanciato — lavoro mirato con una certa varietà.\n1–3×  Esplorativo — nuovo contesto frequente.\n< 1×  Riutilizzo minimo — perlopiù brevi sessioni indipendenti.',
      },
      {
        title: 'Finestra di 5 ore',
        body:  'Finestra ancorata di 5 ore, corrispondente al periodo di rate limit di Claude. Si apre con il primo messaggio e dura esattamente cinque ore. Una nuova finestra inizia solo quando questo intervallo è trascorso del tutto — le finestre sono concatenate in blocchi fissi di cinque ore; una pausa a metà non ne avvia una nuova, e lavorare senza interruzioni non ne mantiene una aperta oltre le sue cinque ore. Non è una finestra mobile delle «ultime cinque ore». Questo è indipendente dal reset settimanale: il tetto settimanale si azzera secondo il proprio calendario e non forza l\'avvio di una nuova finestra di 5 ore nello stesso momento.\n«Al prossimo reset mancano: ~Xh Ym» conta alla rovescia fino alla fine della finestra aperta.\n~ = approssimazione: i file di sessione vengono scritti dopo il completamento di ogni risposta, non all\'avvio della sessione. Può esserci un ritardo di 10–25 minuti. Per l\'orario preciso, controlla Claude Code o claude.ai.',
      },
      {
        title: 'Cosa conta per un limite',
        body:  'Anthropic applica due limiti e nient\'altro: la finestra di 5 ore qui sopra e un tetto settimanale che si azzera in un giorno e a un\'ora fissi. Non esiste un limite giornaliero, quindi l\'anello «Oggi» non è una quota (vedi «L\'anello Oggi»).\n\nContano i token di input e output. Ma la cache non è gratuita: misurazioni confrontate con le percentuali ufficiali (ottobre 2026) indicano che le scritture di cache contano chiaramente e le letture di cache un po\'. I numeri del plugin contano ancora solo input e output. Quando una sessione lunga deve ricostruire la sua cache (nuova finestra di 5 ore dopo una pausa, contesto ampio caricato per la prima volta), il valore ufficiale può quindi superare quello del plugin. Le sessioni lunghe con un contesto ampio consumano la finestra di 5 ore più in fretta per ogni risposta rispetto a quelle nuove e brevi.\n\nNessuno dei due limiti è pubblicato in token. Senza ulteriori configurazioni, entrambe le stime derivano dalla tua cronologia, per questo il plugin può mostrarle solo dopo averti visto raggiungere un limite almeno una volta. La stima settimanale dai limiti raggiunti è la settimana più bassa che abbia mai toccato il tetto e può risultare molto troppo bassa, perché anche la cache, che il plugin non conta, ti porta al limite. Se è presente un feed della status line con le percentuali ufficiali (~/.claude/ratelimit-log.jsonl), il plugin ancora entrambi i limiti a quello.',
      },
      {
        title: 'L\'anello Oggi',
        body:  'Non esiste un limite giornaliero. Anthropic limita solo la finestra di 5 ore e la settimana. L\'anello «Oggi» confronta il tuo consumo di oggi con la tua media per giorno attivo, calcolata su tutti i giorni che Claude Code conserva (la tua impostazione di conservazione dei dati). 200 % significa che oggi lavori il doppio del solito, niente di più. Per questo l\'anello resta grigio: una giornata intensa è un cambiamento nel modo di lavorare, non un avviso. Quanto sei vicino a un limite lo mostrano solo gli anelli della finestra di 5 ore e della settimana.',
      },
      {
        title: 'Mappa di attività',
        body:  'La griglia nella pagina Today copre la tua settimana di fatturazione in corso. Una riga per giorno di calendario, una cella ogni due ore, dodici celle al giorno.\n\nHa otto righe, non sette: una settimana che va da domenica 18:00 a domenica 17:59 tocca otto date di calendario, quindi la prima e l\'ultima riga sono volutamente parziali. Le celle fuori dalla finestra sono disegnate come contorni vuoti — è questo che rende visibile il confine del tuo ciclo.\n\nIl colore indica il ritmo, non il volume. Una finestra di 5 ore contiene due intervalli e mezzo da 2 ore; consumare tutto il budget in modo uniforme significa quindi il 40% per intervallo — il ritmo con cui arrivi al muro esattamente alla chiusura della finestra. Il rosso segna quel ritmo o superiore; i livelli sottostanti sono un quarto, la metà e fino a quel ritmo. La sfumatura all\'interno di un livello indica dove si colloca il valore.\n\nTre tipi di vuoto restano distinti: fuori dalla finestra (solo contorno), non ancora raggiunto (pallido) e davvero nessuna attività (pieno). Solo l\'ultimo dice qualcosa su come è andata la tua settimana.\n\nAccanto alla griglia, «Giorni attivi» conta i giorni di questa settimana di fatturazione con attività.',
      },
      {
        title: 'Esportare i dati',
        body:  'Tre file CSV: la panoramica progetti, la matrice giorno per vault e gli indicatori chiave. Due strade per ottenerli, e non finiscono nello stesso posto.\n\nPulsante CSV nell\'intestazione della barra laterale — il plugin scrive i file nel tuo vault, nella cartella impostata in Impostazioni → Cartella di esportazione CSV. Il menu indica quella cartella prima che tu clicchi. Le stesse esportazioni sono nella palette dei comandi sotto «Export».\n\nMenu CSV Export della dashboard — la dashboard è una pagina web, quindi consegna il file al browser, ed è il browser a decidere dove finisce, di solito la cartella dei download. Una pagina web non può scegliere una cartella di destinazione; è una regola del browser, non una funzione mancante.\n\nEntrambe le strade producono numeri grezzi e date ISO, pronti per essere elaborati. Tutto viene generato localmente — nessun caricamento, nessuna rete, come il resto del plugin.',
      },
      {
        title: 'Reset settimanale',
        body:  'Il limite settimanale si azzera in un giorno e a un\'ora fissi, diversi per ogni account. Tutto ciò che riguarda la settimana dipende da questo: l\'anello settimanale, la previsione, la mappa di calore e la stima stessa.\n\nNormalmente non devi impostare nulla. Quando raggiungi un limite settimanale, Claude scrive nel messaggio l\'orario del prossimo reset, e il plugin lo legge da lì — le impostazioni mostrano allora un segno di spunta verde e la data del limite da cui proviene il valore. Finché questo non è mai accaduto, assume domenica 18:00 e lo dichiara.\n\nPuoi impostarlo manualmente in Impostazioni → Reset settimanale. Un\'impostazione manuale prevale: il rilevamento automatico non la sovrascrive, si limita a confermarla. Vale la pena ricontrollare dopo un cambio dell\'ora, se il reset sembra essersi spostato di un\'ora.',
      },
      {
        title: 'Le tre viste temporali',
        body:  'Tre viste indipendenti sugli stessi dati — non sono automaticamente annidate.\n\nUltima sessione di 5 ore — la finestra ancorata descritta sopra. Conta ai fini del limite di utilizzo.\n\nQuesta sessione — tutte le voci con l\'ID della sessione corrente, indipendentemente dalla data di calendario. Una sessione di Claude Code può durare più giorni. Se hai iniziato una sessione ieri e la stai ancora usando oggi, Questa sessione mostrerà più token di Oggi. È previsto — la sessione si accumula oltre i confini del calendario.\n\nOggi — giorno di calendario da mezzanotte, indipendentemente dalla sessione da cui provengono i token.\n\nIl sottotitolo sotto ogni titolo mostra subito l\'ambito esatto. Spiegazione completa su langeatn.de/media/token-usage/',
      },
      {
        title: 'Stima empirica dei limiti',
        body:  'Anthropic non pubblica il limite di token reale dietro un rate-limit hit — esiste lato server e resta invisibile. Token Usage lo rende visibile in modo empirico: ogni rate-limit hit rilevato diventa un punto dati, e punti dati sufficienti diventano una stima dei tuoi limiti personali di sessione e settimanali (visibili nel banner del budget della dashboard e nella barra laterale sotto «Situazione attuale», dove la riga sotto i tre anelli indica la stima e su quanti limiti osservati si basa).\n\nSotto vedi anche una fascia abituale, la metà centrale dei tuoi limiti. Lo stesso limite raramente viene raggiunto allo stesso totale esatto, perché anche altro uso di Claude che Token Usage non può vedere (ad esempio claude.ai nel browser) attinge allo stesso limite. Un solo numero sembrerebbe più preciso di quanto sia.\n\nLa stima non è statica — diventa silenziosamente più precisa quanto più usi Claude Code. Ogni nuovo rate-limit hit la affina ulteriormente, quindi il numero che vedi oggi è più affidabile di quello della tua prima settimana.',
      },
      {
        title: 'La barra laterale',
        body:  'Una barra di icone a sinistra passa tra quattro pagine.\n\nToday — tre anelli (finestra 5h, oggi, questa settimana), la mappa di calore della settimana di fatturazione in corso, la tua ultima azione e la ripartizione dei token. Tutto qui proviene da oggi o dalla settimana in corso; ciò che copre un periodo più lungo si trova volutamente altrove.\n\nCalendario — gli ultimi due mesi come griglie mensili.\n\nAnalytics — i riepiloghi su 7 giorni e N giorni come riquadri KPI colorati con sparkline, più la distribuzione per modello.\n\nSettings — le stesse impostazioni della scheda impostazioni di Obsidian, senza lasciare la barra laterale.\n\nNell\'intestazione: Dashboard e Report generano file, CSV esporta nel tuo vault, la freccia aggiorna subito.\n\nCiascuna delle quattro righe di token in Oggi porta un indicatore compatto — un punto verde quando il valore è vicino alla tua media recente, una freccia ambra quando è nettamente più alto. La finestra di confronto segue la tua impostazione di conservazione dei dati Claude, non un numero fisso di giorni.',
      },
      {
        title: 'Calendario attività',
        body:  'La pagina Calendario nella barra di icone mostra gli ultimi due mesi uno sotto l\'altro. Due invece di uno, perché a inizio mese una sola griglia mostrerebbe pochi giorni utili e nasconderebbe proprio la rincorsa che si sta cercando. Le frecce spostano la coppia più indietro, fin dove arriva l\'archivio; il calendario non va mai nel futuro.\n\nOgni giorno passato ha un punto colorato, ponderato rispetto alla tua media giornaliera recente: verde sotto la media, ambra intorno ad essa, rosso per un picco (2x o più). I giorni senza attività non hanno punto. Un clic su un giorno aggiunge una nota privata — è salvata nelle impostazioni del plugin, mai nei tuoi dati di sessione.',
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
        body:  'Input:        ~3 $ / 1 M di token (Sonnet)\nOutput:       ~15 $ / 1 M di token\nCache Write:  ~3,75 $ / 1 M di token (+25%)\nCache Read:   ~0,30 $ / 1 M di token (−90%)\n\nIl prezzo effettivo dipende dal tuo piano e dal modello. Questi valori mostrano perché un fattore di riutilizzo elevato riduce significativamente i costi.\n\nCosto e limiti sono due cose diverse: i token di cache costano denaro ma non ti avvicinano al limite di 5 ore né a quello settimanale — vedi «Cosa conta per un limite».',
      },
    ],
  },
  // Spanish (Björn, 03.10.2026) — machine-assisted translation, reviewed for the terms that
  // carry meaning rather than word-for-word: "ventana de 5 horas", "semana de facturación",
  // "token" stays English as it does in every other language here.
  es: {
    loading:          'Cargando...',
    lastAction:       'Última acción',
    chipIn:           'Ent',
    chipOut:          'Sal',
    chipCWr:          'C.Esc',
    chipCRd:          'C.Lec',
    startedYesterday: 'Comenzó ayer · abarca varios días',
    startedDate:      (d) => `Comenzó el ${d} · abarca varios días`,
    startedToday:     (t) => `Comenzó hoy a las ${t}`,
    thisSession:      'Esta sesión',
    today:            'Hoy',
    calendarDay:      'Día natural · desde medianoche',
    sevenDays:        '7 días',
    thirtyDays:       (n) => `${n} días`,
    resetsIn:         (d) => `La ventana de 5 h de Claude se reinicia en: ~${d}`,
    glossaryTitle:    'Glosario y conceptos',
    glossarySub:      'Qué significa cada valor y cómo se relacionan',
    helpLink:         '↗ Documentación completa en langeatn.de',
    heatmapTitle:     'Mapa de actividad',
    heatmapCycle:     (range) => `Tu ciclo de facturación · ${range}`,
    timelineSub:      'Una celda = 2 horas. El rojo es el ritmo que vaciaría una ventana de 5 horas justo al cerrarse.',
    heatLegendVhigh:  'Muy alto',
    heatLegendHigh:   'Alto',
    heatLegendMedium: 'Medio',
    heatLegendLow:    'Bajo',
    heatLegendEmpty:  'Sin actividad',
    models:           'Modelos (últimos 7 días)',
    last5h:           'Ventana de 5 h actual',
    waiting:          'Esperando la siguiente petición...',
    anchoredWindow:   'Ventana anclada · cuenta para el límite de uso',
    backBtn:          '← Volver',
    spikeAvg:         (r) => `↑ ${r}× media`,
    windowCleared:    'Ventana reiniciada · 5 h completas disponibles',
    noData:           'Token Usage: todavía no hay datos.',
    reportCreated:    'Informe de Token Usage creado.',
    reportFailed:     'Error al crear el informe: ',
    vaultReportCreated: 'Informe de proyectos de Token Usage creado.',
    vaultReportFailed:  'Error al crear el informe del vault: ',
    dashOpened:       'Panel abierto en el navegador.',
    dashFailed:       'Error al abrir el panel: ',
    rowInput:         'Entrada',
    rowOutput:        'Salida',
    rowCWrite:        'C.Escritura',
    cwSplitTip:       (h1, m5) => `Escrituras de caché: ${h1} durante 1 hora (2x el precio de entrada), ${m5} durante 5 minutos (1,25x)`,
    rowCRead:         'C.Lectura',
    settingLang:      'Idioma',
    settingLangDesc:  'Idioma de la interfaz del plugin. Se aplica de inmediato.',
    settingRefresh:   'Intervalo de actualización automática (segundos)',
    settingRefreshDesc: 'Intervalo de sondeo de reserva. El vigilante de archivos reacciona de inmediato a cada nueva respuesta de Claude — esto es solo el respaldo.',
    settingReport:    'Ruta del informe en el vault',
    settingReportDesc: 'Ruta relativa al vault — el archivo vive dentro de tu carpeta del vault, junto a tus notas, y se sobrescribe con cada clic. Usa el botón para abrir su ubicación.',
    settingVaultReport:    'Ruta del informe de proyectos en el vault',
    settingVaultReportDesc: 'Ruta relativa al vault para el desglose de uso por proyecto y vault — un archivo aparte del informe principal, útil para entregar a clientes como referencia de uso o facturación. Usa el botón para abrir su ubicación.',
    settingDash:      'Ruta del panel en el vault',
    settingDashDesc:  'Ruta relativa al vault — el archivo vive dentro de tu carpeta del vault, se regenera con cada clic y se abre en tu navegador predeterminado. Usa el botón para abrir su ubicación.',
    settingArchive:        'Carpeta de archivo en el vault',
    settingArchiveDesc:    'Carpeta relativa al vault — vive dentro de tu carpeta del vault y guarda resúmenes diarios de uso, un pequeño archivo Markdown por día (solo agregados, nunca el contenido de las sesiones). Permite conservar tendencias a largo plazo incluso después de que Claude Code borre los archivos de sesión originales. Usa el botón para abrir su ubicación.',
    activeDaysTitle:  'Días activos',
    activeDaysSub:    'en esta semana de facturación',
    csvBtnTitle:      'Exportar archivos CSV a tu vault',
    csvMenuTarget:    (f) => `Escribe en: ${f}`,
    csvMenuAll:       'Los tres archivos',
    csvMenuProjects:  'Resumen de proyectos',
    csvMenuDaily:     'Detalle diario',
    csvMenuKpis:      'Indicadores clave',
    settingCsv:       'Carpeta de exportación CSV en el vault',
    settingCsvDesc:   'Carpeta relativa al vault para las exportaciones CSV. Ejecuta uno de los comandos «Export … CSV» desde la paleta de comandos y los archivos acaban aquí. El panel ofrece las mismas exportaciones, pero esas son descargas del navegador y van donde el navegador las deje — una página web no puede elegir carpeta.',
    csvNoData:        'Todavía no hay datos para exportar — abre primero la barra lateral de Token Usage.',
    csvFolderFailed:  (f) => `No se pudo crear la carpeta de exportación: ${f}`,
    csvWritten:       (n, f) => `${n} archivo(s) CSV escritos en ${f}`,
    settingArchiveEnabled:     'Activar archivo diario',
    settingArchiveEnabledDesc: 'Escribe automáticamente un archivo de resumen diario. Desactívalo si no quieres que el plugin cree archivos en tu vault.',
    settingReportPeriod:     'Periodo del informe',
    settingReportPeriodDesc: 'Hasta dónde miran hacia atrás el panel y el informe. Más allá de tu retención de datos de Claude, esto se completa desde el archivo diario — los días recientes siguen en vivo, los antiguos vienen de Token Usage Archive/.',
    verdictHigh:      (d) => `Más alto que tu media de ${d} días para este tipo — merece un vistazo.`,
    verdictNormal:    (d) => `Cerca de tu media de ${d} días para este tipo.`,
    tileTotal:        'Total',
    tileCalls:        'Llamadas',
    tileActiveDays:   'Días activos',
    tileAvgPerDay:    'Media / día activo',
    railOverview:     'Resumen',
    railAnalytics:    'Analíticas',
    railCalendar:     'Calendario',
    railSettings:     'Ajustes',
    settingReset:     'Reinicio semanal',
    settingResetDesc: 'Configuración única: ejecuta /usage en Claude Code, mira cuándo se reinicia tu límite semanal e indícalo aquí. Anthropic lo asigna por cuenta — no es igual para todos. Hasta que lo hagas, el plugin supone domingo a las 18:00 y cualquier cifra semanal puede estar desviada.',
    settingResetAuto: (d) => `Detectado automáticamente a partir de tu límite semanal alcanzado el ${d} — no hace falta configurar nada. Cámbialo abajo solo si parece incorrecto.`,
    settingResetDone: (d) => `Establecido manualmente el ${d}. Actualízalo si tu reinicio cambia (por ejemplo tras un cambio de hora).`,
    calSun: 'Domingo', calMon: 'Lunes', calTue: 'Martes', calWed: 'Miércoles',
    calThu: 'Jueves', calFri: 'Viernes', calSat: 'Sábado',
    settingSource:    (p) => `Fuente: ${p} — no se necesita clave de API.`,
    settingCleanup:     'Retención de datos de Claude (días)',
    settingCleanupDesc: 'Controla cuánto tiempo conserva Claude Code los archivos de sesión. Por defecto: 30 días. Para control a largo plazo (tendencias de coste, comparación de contratos) se recomiendan 90–180 días. Escribe directamente en el settings.json de Claude Code; se crea automáticamente una copia (.bak) antes de cada cambio.',
    settingPathsHeading: 'Ubicaciones de archivos',
    settingShowInFolder: 'Mostrar en la carpeta',
    settingShowInFolderFailed: 'No se pudo abrir el explorador de archivos para esta ruta: ',
    cleanupSaved:  (n) => `Retención actualizada — Claude Code conservará ahora los archivos de sesión durante ${n} días.`,
    cleanupFailed: 'Error al actualizar la retención: ',
    archiveBackfilled: (n) => `Token Usage archivó ${n} días de historial.`,
    calPrev:          'Mes anterior',
    calNext:          'Mes siguiente',
    calNoteTitle:     (d) => `Nota — ${d}`,
    calNotePlaceholder: 'Añade una nota sobre el uso de este día (opcional)...',
    calNoteSave:      'Guardar',
    calNoteDelete:    'Eliminar nota',
    calNoteCancel:    'Cancelar',
    calNoteAdd:       'Haz clic para añadir una nota',
    calNoteEdit:      'Haz clic para editar la nota',
    limitPulseTitle:    'Situación actual',
    limitPulse5h:       'Ventana 5 h',
    limitPulseOf5h:     (p) => `${p}% del límite estimado de 5 h`,
    limitPulseBasis:    (n) => `Límite de 5 h estimado en {v} — mediana de ${n} límites observados en tus propios datos.`,
    limitPulseBand:      (lo, hi) => `Normalmente entre ${lo} y ${hi} (mitad central de los límites).`,
    limitPulseBasisFeed: `Límite de 5 h {v}, derivado del porcentaje oficial de tu feed de línea de estado.`,
    limitPulseWeekFeed:  `Límite semanal {v}, derivado del porcentaje oficial de tu feed de línea de estado.`,
    limitPulseToday:    'Hoy',
    limitPulseWeek:     'Esta semana',
    limitPulseOfDaily:  (p) => `${p}% de tu día habitual`,
    limitPulseOfWeekly: (p) => `${p}% del límite semanal estimado`,
    limitPulseNoWeekly: 'Límite semanal aún no estimado — hace falta al menos un límite semanal observado.',
    helpSections: [
      {
        title: 'Tokens',
        body:  'La unidad que Claude factura. Cada palabra, signo de puntuación y espacio de un mensaje se divide en tokens — aproximadamente 4 caracteres o 3/4 de palabra cada uno. Se cuentan por separado TANTO lo que envías COMO la respuesta de Claude.',
      },
      {
        title: 'Entrada y salida',
        body:  'Entrada = todo lo que envías (mensaje + historial de la conversación + prompt del sistema). Salida = todo lo que Claude escribe de vuelta. Los tokens de salida suelen costar entre 3 y 5 veces más que los de entrada.',
      },
      {
        title: 'C.Escritura — escritura en caché',
        body:  'Cuando Claude procesa por primera vez un contexto largo, lo guarda («escribe») en una caché de prompts. Hay dos tipos con precios distintos: una escritura de caché de 5 minutos cuesta 1,25× el precio de entrada, una de 1 hora cuesta 2×. En nuestros propios registros, cerca del 90 % de las escrituras de caché de Claude Code con suscripción fueron del tipo de 1 hora, mientras que los subagentes escribían cachés de 5 minutos. Pasa el ratón por la fila C.Escritura para ver el reparto del periodo. Las escrituras de caché también cuentan para el límite de 5 horas (ver «Qué cuenta para un límite»).',
      },
      {
        title: 'C.Lectura — lectura de caché',
        body:  'Cualquier petición posterior que reutilice el mismo contexto en caché cuesta solo una fracción del precio de entrada: 0,1× en la mayoría de los modelos, 0,05× en Opus 5.5 y Sonnet 5.5, 0,025× en Fable 5.1 (página de precios de Anthropic, octubre de 2026). Un valor alto de C.Lectura significa que estás trabajando de forma eficiente con el mismo material.',
      },
      {
        title: 'C.Escritura vs C.Lectura — qué dice la proporción',
        body:  'Factor de reutilización = C.Lectura ÷ C.Escritura. Proporción alta → concentración profunda, el mismo contexto en muchas peticiones. Proporción baja → modo exploratorio, cambios constantes de contexto.\n\n≥ 8×  Concentración profunda — excelente rendimiento de la caché.\n3–8×  Equilibrado — trabajo enfocado con algo de variedad.\n1–3×  Exploratorio — contexto nuevo con frecuencia.\n< 1×  Reutilización mínima — sobre todo sesiones cortas independientes.',
      },
      {
        title: 'Ventana de 5 horas',
        body:  'Ventana anclada de 5 horas que corresponde al periodo de límite de uso de Claude. Se abre con tu primer mensaje y dura exactamente cinco horas. Una nueva ventana empieza solo cuando ese plazo ha transcurrido por completo — las ventanas se encadenan en bloques fijos de cinco horas; una pausa a mitad de camino no abre una nueva, y trabajar sin interrupción no mantiene una abierta más allá de sus cinco horas. No es una ventana móvil de «las últimas cinco horas». Esto es independiente del reinicio semanal: el tope semanal se reinicia según su propio calendario y no obliga a que empiece una nueva ventana de 5 horas en ese mismo momento.\n«La ventana de 5 h de Claude se reinicia en: ~Xh Ym» cuenta atrás hasta el final de la ventana abierta.\n~ = aproximación: los archivos de sesión se escriben al completarse cada respuesta, no al iniciarse la sesión. Puede haber un retraso de 10 a 25 min. Para la hora exacta, consulta Claude Code o claude.ai.',
      },
      {
        title: 'Qué cuenta para un límite',
        body:  'Anthropic aplica dos límites y ninguno más: la ventana de 5 horas de arriba y un tope semanal que se reinicia un día y a una hora fijos. No existe un límite diario, por eso el anillo «Hoy» no es una cuota (ver «El anillo Hoy»).\n\nCuentan los tokens de entrada y salida. Pero la caché no es gratis: mediciones comparadas con los porcentajes oficiales (octubre de 2026) indican que las escrituras de caché cuentan claramente y las lecturas de caché un poco. Las cifras del plugin siguen contando solo entrada y salida. Cuando una sesión larga tiene que reconstruir su caché (nueva ventana de 5 horas tras una pausa, un contexto grande cargado por primera vez), la cifra oficial puede ir por delante del plugin. Las sesiones largas con mucho contexto gastan la ventana de 5 horas más deprisa por respuesta que las sesiones nuevas y cortas.\n\nNinguno de los dos límites se publica en tokens. Sin más configuración, ambas estimaciones salen de tu propio historial, por eso el plugin solo puede mostrarlas después de haberte visto alcanzar un límite al menos una vez. La estimación semanal a partir de límites alcanzados es la semana más baja que llegó al tope y puede quedar muy por debajo, porque la caché, que el plugin no cuenta, también te lleva al límite. Si existe un feed de la línea de estado con los porcentajes oficiales (~/.claude/ratelimit-log.jsonl), el plugin ancla ambos límites a él.',
      },
      {
        title: 'El anillo Hoy',
        body:  'No existe un límite diario. Anthropic solo limita la ventana de 5 horas y la semana. El anillo «Hoy» compara lo que has usado hoy con tu propia media por día activo, calculada sobre todos los días que Claude Code conserva (tu ajuste de retención de datos). 200 % significa que hoy trabajas el doble de lo habitual, nada más. Por eso el anillo se queda gris: un día intenso es un cambio en tu forma de trabajar, no un aviso. Lo cerca que estás de un límite solo lo muestran los anillos de la ventana de 5 horas y de la semana.',
      },
      {
        title: 'Mapa de actividad',
        body:  'La cuadrícula de la página Today cubre tu semana de facturación en curso. Una fila por día natural, una celda cada dos horas, doce celdas al día.\n\nTiene ocho filas, no siete: una semana que va de domingo 18:00 a domingo 17:59 toca ocho fechas del calendario, así que la primera y la última fila son parciales a propósito. Las celdas fuera de la ventana se dibujan solo con contorno — eso es lo que hace visible el límite de tu ciclo.\n\nEl color indica el ritmo, no el volumen. Una ventana de 5 horas contiene dos tramos y medio de 2 horas; gastar todo el presupuesto de forma uniforme son por tanto el 40% por tramo — el ritmo con el que llegas al muro justo al cerrarse la ventana. El rojo marca ese ritmo o más rápido; los niveles inferiores son un cuarto, la mitad y hasta ese ritmo. El matiz dentro de un nivel indica dónde se sitúa el valor.\n\nTres clases de vacío se mantienen separadas: fuera de la ventana (solo contorno), aún no alcanzado (pálido) y realmente sin actividad (relleno). Solo la última dice algo sobre cómo fue tu semana.\n\nJunto a la cuadrícula, «Días activos» cuenta los días de esta semana de facturación con actividad.',
      },
      {
        title: 'Exportar tus datos',
        body:  'Tres archivos CSV: el resumen de proyectos, la matriz día por vault y los indicadores clave. Dos caminos para obtenerlos, y acaban en sitios distintos.\n\nBotón CSV en la cabecera de la barra lateral — el plugin escribe los archivos en tu vault, en la carpeta configurada en Ajustes → Carpeta de exportación CSV. El menú indica esa carpeta antes de que hagas clic. Las mismas exportaciones están en la paleta de comandos bajo «Export».\n\nMenú CSV Export del panel — el panel es una página web, así que entrega el archivo al navegador y es el navegador quien decide dónde acaba, normalmente tu carpeta de descargas. Una página web no puede elegir carpeta de destino; es una regla del navegador, no una función que falte.\n\nAmbos caminos producen números en bruto y fechas ISO, listos para calcular. Todo se genera localmente — sin subidas, sin red, como el resto del plugin.',
      },
      {
        title: 'Reinicio semanal',
        body:  'El límite semanal se reinicia un día y a una hora fijos, distintos para cada cuenta. Todo lo relacionado con la semana depende de ello: el anillo semanal, la previsión, el mapa de actividad y la propia estimación.\n\nNormalmente no tienes que configurar nada. Cuando alcanzas un límite semanal, Claude escribe en el mensaje la hora del siguiente reinicio, y el plugin la lee de ahí — los ajustes muestran entonces una marca verde y la fecha del límite del que procede el valor. Mientras eso no haya ocurrido nunca, supone domingo a las 18:00 y lo indica.\n\nPuedes fijarlo a mano en Ajustes → Reinicio semanal. Un ajuste manual prevalece: la detección automática no lo sobrescribe, solo lo confirma. Conviene revisarlo tras un cambio de hora si tu reinicio parece haberse movido una hora.',
      },
      {
        title: 'Las tres vistas temporales',
        body:  'Tres cortes independientes de los mismos datos — no están anidados automáticamente.\n\nÚltima sesión de 5 horas — la ventana anclada descrita arriba. Cuenta para tu límite de uso.\n\nEsta sesión — todas las entradas con el ID de sesión actual, sin importar la fecha. Una sesión de Claude Code puede abarcar varios días. Si empezaste ayer y sigues en ella hoy, «Esta sesión» mostrará más tokens que «Hoy». Es lo esperado — la sesión acumula más allá de los límites del calendario.\n\nHoy — día natural desde medianoche, sin importar de qué sesión vengan los tokens.\n\nLa descripción bajo cada título muestra su alcance exacto de un vistazo. Explicación completa en langeatn.de/media/token-usage/',
      },
      {
        title: 'Estimación empírica de límites',
        body:  'Anthropic no publica el límite real de tokens que hay detrás de un rate-limit hit — existe en el servidor y permanece invisible. Token Usage lo hace visible de forma empírica: cada rate-limit hit detectado se convierte en un dato, y suficientes datos dan una estimación de tus propios límites de sesión y semanal (visibles en el banner de presupuesto del panel y en la barra lateral bajo «Situación actual», donde la línea bajo los tres anillos indica la estimación y sobre cuántos límites observados se basa).\n\nDebajo ves también una banda habitual, la mitad central de tus límites. El mismo límite rara vez se alcanza con exactamente el mismo total, porque otro uso de Claude que Token Usage no puede ver (por ejemplo claude.ai en el navegador) consume del mismo límite. Un solo número parecería más preciso de lo que es.\n\nLa estimación no es estática — se vuelve más precisa cuanto más usas Claude Code. Cada nuevo rate-limit hit la afina, de modo que la cifra que ves hoy es más fiable que la de tu primera semana.',
      },
      {
        title: 'La barra lateral',
        body:  'Una barra de iconos a la izquierda cambia entre cuatro páginas.\n\nToday — tres anillos (ventana 5 h, hoy, esta semana), el mapa de actividad de la semana de facturación en curso, tu última acción y el desglose de tokens. Todo aquí es de hoy o de la semana en curso; lo que abarca más tiempo está deliberadamente en otro sitio.\n\nCalendario — los dos últimos meses como cuadrículas mensuales.\n\nAnalíticas — los resúmenes de 7 y N días como tarjetas KPI con minigráficos de tendencia, más la distribución por modelo.\n\nAjustes — los mismos ajustes que en la pestaña de configuración de Obsidian, sin salir de la barra lateral.\n\nEn la cabecera: Dashboard e Report generan archivos, CSV exporta a tu vault, y la flecha actualiza de inmediato.\n\nCada una de las cuatro filas de tokens de Today lleva un marcador compacto — un punto verde cuando el valor está cerca de tu media reciente, una flecha ámbar cuando es claramente más alto. La ventana de comparación sigue tu ajuste de retención de datos de Claude, no un número fijo de días.',
      },
      {
        title: 'Calendario de actividad',
        body:  'La página Calendario de la barra de iconos muestra los dos últimos meses uno debajo del otro. Dos en vez de uno, porque a principios de mes una sola cuadrícula mostraría apenas unos días útiles y ocultaría justo el arranque que se busca. Las flechas desplazan el par hacia atrás, hasta donde llegue el archivo; el calendario nunca va al futuro.\n\nCada día pasado lleva un punto de color ponderado respecto a tu media diaria reciente: verde por debajo, ámbar alrededor, rojo en un pico (2× o más). Los días sin actividad no tienen punto. Un clic en un día añade una nota privada — se guarda en los ajustes del plugin, nunca en tus datos de sesión.',
      },
      {
        title: 'Modelos',
        body:  'Haiku, Sonnet, Opus y Fable tienen precios muy distintos. La barra de modelos muestra qué parte de tus tokens de los últimos 7 días corresponde a cada uno. Si Opus domina el gráfico, ahí está la mayor parte de tu gasto.',
      },
      {
        title: 'Sesiones',
        body:  'Cada sesión de un proyecto de Claude Code tiene un ID único. Una sesión = un contexto de conversación continuo. La tabla de sesiones principales del panel ordena las sesiones por volumen total de tokens dentro de tu ventana de lectura configurada (30 días por defecto).',
      },
      {
        title: 'Control de uso por vault y proyecto',
        body:  'Claude Code registra en cada petición el directorio de trabajo desde el que se ejecutó. A partir de ahí, el plugin agrupa el uso por vault y por subproyecto — útil para facturar a varios clientes o para ver qué área de trabajo consume realmente tu presupuesto.\n\nEl panel muestra la vista por vault; la exportación Markdown separada añade el detalle por subproyecto.',
      },
      {
        title: 'Detalle de subproyectos',
        body:  'Dentro de un vault, el plugin distingue además las subcarpetas desde las que se ejecutaron las peticiones. La casilla del panel controla solo la legibilidad en pantalla — las exportaciones CSV y Markdown incluyen siempre el detalle completo.',
      },
      {
        title: 'Qué se mide',
        body:  'Este plugin lee lo que Claude Code escribe en disco, así que cubre todas las formas de usar Claude Code: en una terminal, dentro de Obsidian, en un editor como VS Code y el modo agente integrado en la aplicación de escritorio de Claude. Todo acaba en los mismos números.\n\nLo que no puede mostrar es el chat normal — las conversaciones en la aplicación de escritorio de Claude o en claude.ai. Esas nunca escriben recuentos de tokens en tu máquina; la única señal de uso disponible allí es un porcentaje redondeado de tu límite actual, no los recuentos reales sobre los que se construye este plugin.\n\nAsí que si un día parece más intenso de lo que sugieren las cifras, esa suele ser la razón: tu uso del chat cuenta para el mismo límite del plan, pero no deja rastro local que medir. Conviene tenerlo en cuenta sobre todo para las estimaciones de límites, que solo pueden derivarse de la parte visible aquí.',
      },
      {
        title: 'Archivo y datos a largo plazo',
        body:  'Claude Code borra sus propios archivos de sesión automáticamente — 30 días por defecto, o lo que configures en cleanupPeriodDays en Ajustes. Sin una copia en otro sitio, todo lo anterior se pierde definitivamente.\n\nEl archivo resuelve esto: cada día que usas Claude Code, el plugin escribe un pequeño archivo de resumen en Token Usage Archive/ dentro de tu vault — solo totales agregados, nunca tus conversaciones. Cada vez que abres Obsidian, revisa todos los días todavía disponibles y rellena los que aún no tienen archivo, incluidos los huecos por haber estado cerrado un tiempo.\n\nEl límite honesto: el archivo solo puede guardar lo que todavía existe en el momento en que abres la aplicación. Si Obsidian permanece cerrado más tiempo que tu periodo de retención, los días intermedios desaparecen antes de que el plugin llegue a verlos — no hay forma de evitarlo sin ejecutarse de forma continua. Aumenta la retención (Ajustes → Retención de datos de Claude) si abres Obsidian menos de una vez al día, para darle un margen más amplio.',
      },
      {
        title: 'Resumen de costes (aproximado, USD)',
        body:  'Entrada:        ~3 $ / 1 M de tokens (Sonnet)\nSalida:         ~15 $ / 1 M de tokens\nC.Escritura:    ~3,75 $ / 1 M de tokens (+25 %)\nC.Lectura:      ~0,30 $ / 1 M de tokens (−90 %)\n\nEl precio real depende de tu plan y del modelo. Estas cifras muestran por qué un factor de reutilización alto reduce los costes de forma notable.\n\nCoste y límites son dos cosas distintas: los tokens de caché cuestan dinero pero no te acercan al límite de 5 horas ni al semanal — ver «Qué cuenta para un límite».',
      },
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────

// intensityColor() removed in v2.0 — its only caller was the Classic bar chart, which is gone.
// The dashboard's twin (intensityColorJs) went the same way once the billing-week bar stopped
// colouring by relative height. heatBandColor() followed on 01.10.2026 with the 4h-block heatmap
// it coloured, and dayHeatBand() on 02.10.2026 with the 30-day grid, when Björn had that removed
// from Analytics. The one surviving heatmap is the weekly 2h grid on Today; its bands live in
// slotHeatBand()/slotShade() and measure against the session-limit estimate, not a daily average.

// Compact progress ring for the sidebar (v2.0). The dashboard has its own ringSvg() inside the
// template literal; this is the Obsidian-side twin, deliberately a separate small function
// rather than a shared one — the two live in different worlds (Node-side DOM vs. browser
// template string) and the dashboard's version carries a glow filter this one does not need at
// 44px. Colour comes in as a CSS variable so the ring follows the theme like everything else.
function auRingSvg(pct, cssColor, size) {
  const s = size || 44;
  const stroke = 4.5;
  const r = (s - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, pct)) / 100) * c;
  const mid = s / 2;
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" style="display:block">`
    + `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--background-modifier-border)" stroke-width="${stroke}"/>`
    + `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${cssColor}" stroke-width="${stroke}"`
    + ` stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" stroke-linecap="round"`
    + ` transform="rotate(-90 ${mid} ${mid})"/>`
    + `<text x="${mid}" y="${mid + 3.6}" text-anchor="middle" font-size="11" font-weight="700"`
    + ` fill="var(--text-normal)">${Math.round(pct)}<tspan font-size="7.5">%</tspan></text>`
    + `</svg>`;
}

// Note on the heatmap colours, kept because it still governs the surviving weekly grid: the four
// active steps form an ordinal ramp (cold to hot), read by position in the sequence rather than
// identified in isolation — so they may sit closer together than the three-colour traffic light,
// where each colour has to be recognisable on its own.
const FIVE_H = 5 * 3_600_000;

// ── CSV, Node side (02.10.2026) ──────────────────────────────────────────────────────────
// Deliberate twins of csvCell()/csvFrom() inside the dashboard template literal, not shared
// with them — same reasoning as sparklineSvgNG vs sparklineSvg. The dashboard pair lives in a
// template string where every backslash needs doubling; these do not, and keeping them apart
// means neither has to carry the other's escaping rules.
//
// RFC 4180: quote a field only when it contains a quote, a comma or a line break, and escape
// an inner quote by doubling it.
function csvCellNode(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvFromNode(rows) {
  return rows.map(r => r.map(csvCellNode).join(',')).join('\r\n');
}
// Byte-order mark, so Excel reads the file as UTF-8 — vault and folder names routinely carry
// umlauts, which become mojibake without it.
const CSV_BOM = '﻿';
function csvIsoNode(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// Reconstructs Anthropic's anchored 5-hour windows from activity (02.10.2026).
// A window opens with the first entry that is not already inside an open window, and runs
// exactly five hours. Returns every window in the given entries, oldest first.
// `entries` may be in any order — it is sorted here rather than at every call site.
//
// `anchors` (optional, 09.10.2026): official windows from the status line feed, see
// feedWindowAnchors(). Where an entry falls inside one, that window's real start and end are used
// instead of the reconstruction. Windows opened outside the logs (a poll, claude.ai, another
// device) are invisible to the reconstruction, which then starts the window at the first LOGGED
// entry. On 09.10. that put the plugin's window six minutes late (11:56 instead of 11:50) and
// left 37K tokens out of the gauge.
function windows5h(entries, anchors) {
  const asc = (entries || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  const anc = anchors || [];
  const out = [];
  let cur = null;
  let ai = 0;
  for (const e of asc) {
    // Anchors are sorted and do not overlap, entries ascend: one pointer is enough.
    while (ai < anc.length && anc[ai].end <= e.timestamp) ai++;
    const a = (ai < anc.length && anc[ai].start <= e.timestamp) ? anc[ai] : null;
    if (a) {
      if (!cur || cur.start !== a.start) {
        // A reconstructed window cannot officially run into a known one; cut it where it starts.
        if (cur && !cur.official && cur.end > a.start) cur.end = a.start;
        cur = { start: a.start, end: a.end, tokens: 0, count: 0, official: true };
        out.push(cur);
      }
    } else if (!cur || e.timestamp >= cur.end) {
      cur = { start: e.timestamp, end: e.timestamp + FIVE_H, tokens: 0, count: 0 };
      out.push(cur);
    }
    cur.tokens += billedEntry(e);
    cur.count++;
  }
  return out;
}

// The window that is open right now, or null if the last one has already expired.
// With the feed, an official window can be open without a single logged entry in it yet (opened by
// a poll or on claude.ai). It is returned with 0 tokens, so the countdown shows the real reset.
function currentWindow5h(entries, now, anchors) {
  const all = windows5h(entries, anchors);
  const last = all[all.length - 1];
  const a = (anchors || []).find(x => x.start <= now && now < x.end);
  if (a) return (last && last.start === a.start) ? last : { start: a.start, end: a.end, tokens: 0, count: 0, official: true };
  return (last && now < last.end) ? last : null;
}

// Reads the optional feed of official percentages (see RATELIMIT_FEED_PATH). Never throws: a
// missing or broken file simply means "no feed", and every caller falls back to the estimates.
// `resets` is converted from seconds to milliseconds here, once, so nothing downstream mixes units.
function readRateLimitFeed(sinceMs) {
  try {
    if (!fs.existsSync(RATELIMIT_FEED_PATH)) return [];
    const conv = (w) => (w && typeof w.pct === 'number' && typeof w.resets === 'number' && w.resets > 0)
      ? { pct: w.pct, resets: w.resets < 1e12 ? w.resets * 1000 : w.resets } : null;
    const out = [];
    for (const line of fs.readFileSync(RATELIMIT_FEED_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o || typeof o.ts !== 'number' || o.session === 'test') continue;
      if (sinceMs && o.ts < sinceMs) continue;
      const r = { ts: o.ts, h5: conv(o.h5), wk: conv(o.wk) };
      if (r.h5 || r.wk) out.push(r);
    }
    return out.sort((a, b) => a.ts - b.ts);
  } catch (e) {
    return [];
  }
}

// One official 5h window per distinct reset moment in the feed, oldest first. Two resets within
// 15 minutes of each other are treated as the same window (guards against a reading that drifted).
function feedWindowAnchors(feed) {
  const resets = [...new Set((feed || []).filter(r => r.h5).map(r => r.h5.resets))].sort((a, b) => a - b);
  const out = [];
  for (const end of resets) {
    const prev = out[out.length - 1];
    if (prev && end - prev.end < 15 * 60_000) continue;
    out.push({ start: end - FIVE_H, end });
  }
  return out;
}

// Band for a 5h window against the observed session limit (02.10.2026). Different edges from
// dayHeatBand on purpose: there, 1x is an ordinary day and 2x is a spike. Here, 1x means the
// window hit the wall and work stopped — so the top band has to arrive at 100%, not at 200%.
function windowHeatBand(ratio) {
  if (ratio <= 0)  return 'empty';
  if (ratio < 0.5) return 'low';
  if (ratio < 0.8) return 'medium';
  if (ratio < 1)   return 'high';
  return             'veryhigh';
}

// Band for one 2-hour slot (02.10.2026, Björn's bubble grid).
//
// The thresholds are derived, not picked. A 5-hour window holds 2.5 slots of two hours, so
// spending the whole window budget at an even pace means 40% of it per slot — that is the pace
// at which you arrive exactly at the wall as the window closes. Call that "full burn" and the
// bands fall out of it: a quarter of that pace, half of it, up to it, and beyond it.
//
// This matters because the obvious alternative — colouring each slot relative to the busiest
// slot of the week — would make the busiest slot red every week, including a quiet one. Same
// trap as the week bar on 01.10.: relative height wearing traffic-light colours.
const SLOT_FULL_BURN = 0.40; // share of a 5h budget spent in one 2h slot at an even full burn

const SLOT_EDGES = [0.25, 0.5, 1];

function slotHeatBand(slotTokens, sessionLimit) {
  if (slotTokens <= 0 || !sessionLimit) return slotTokens > 0 ? 'low' : 'empty';
  const pace = slotTokens / (sessionLimit * SLOT_FULL_BURN);
  if (pace < SLOT_EDGES[0]) return 'low';
  if (pace < SLOT_EDGES[1]) return 'medium';
  if (pace < SLOT_EDGES[2]) return 'high';
  return                      'veryhigh';
}

// Shading INSIDE a band (02.10.2026, Björn: the mockup varies the tones within each colour).
// Returns 0.70–1.00: where the value sits between its band's own edges. The band still carries
// the meaning and is the thing the legend names; the shade adds resolution within it, which
// matters because a band is a wide bucket — two cells both called "high" can be 1.6x apart.
//
// Safe to add because it is monotonic and never crosses a band edge: more tokens always means
// more solid, and no shade of one band can be mistaken for another band. It would NOT be safe to
// map the shade to "share of the busiest cell this week", which is the relative-height trap the
// week bar fell into on 01.10.
function slotShade(slotTokens, sessionLimit) {
  if (slotTokens <= 0 || !sessionLimit) return 1;
  const pace = slotTokens / (sessionLimit * SLOT_FULL_BURN);
  const lo = pace < SLOT_EDGES[0] ? 0 : pace < SLOT_EDGES[1] ? SLOT_EDGES[0]
           : pace < SLOT_EDGES[2] ? SLOT_EDGES[1] : SLOT_EDGES[2];
  // The top band is open-ended; one further full-burn unit above the edge counts as its maximum.
  const hi = pace < SLOT_EDGES[0] ? SLOT_EDGES[0] : pace < SLOT_EDGES[1] ? SLOT_EDGES[1]
           : pace < SLOT_EDGES[2] ? SLOT_EDGES[2] : SLOT_EDGES[2] + 1;
  const k = Math.max(0, Math.min(1, (pace - lo) / (hi - lo)));
  return 0.70 + 0.30 * k;
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

// Soft word-wrap for plain-text tooltips (native `title` attributes do not wrap on their
// own): breaks the input into lines of at most maxLen chars, breaking on word boundaries
// where possible so a long day-note doesn't render as one unstructured line (Björn, 24.09.2026).
function wrapText(str, maxLen) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (candidate.length > maxLen && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
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
  return { en: 'en-GB', de: 'de-DE', fr: 'fr-FR', it: 'it-IT', es: 'es-ES' }[lang] || 'en-GB';
}

// When the weekly cap resets. Set by calibration (v2.0) — read from the plugin settings into
// these module-level values on load and on every settings change.
//
// Until 2.0 this was hard-wired to Sunday 16:00 UTC, which is Björn's own reset. That is NOT
// universal: Anthropic assigns the weekly reset per account, and `/usage` in Claude Code
// reports each user's own moment (Björn, 01.10.2026). Every user whose reset falls elsewhere
// was silently getting a billing-week bar, a forecast and a "resets in" countdown built on
// someone else's schedule — wrong without ever looking broken.
//
// Stored and computed in LOCAL time, because that is what `/usage` shows the user. A fixed UTC
// instant would drift against the displayed clock across daylight saving; keeping it local
// means what the user typed is what they see. If Anthropic's reset is UTC-fixed, the hour will
// appear to shift by one after a DST change — which is exactly when the calibration hint
// ("checked on …") should prompt a re-check.
let _resetDay  = 0;   // 0 = Sunday … 6 = Saturday
let _resetHour = 18;  // local hour, 0–23

function setBillingWeekReset(day, hour) {
  _resetDay  = (typeof day  === 'number' && day  >= 0 && day  <= 6)  ? day  : 0;
  _resetHour = (typeof hour === 'number' && hour >= 0 && hour <= 23) ? hour : 18;
}

const _RESET_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

// Reads the weekly reset straight out of a weekly-limit message, so the plugin calibrates
// itself (v2.0). Claude Code writes the moment in plain text when the cap is hit:
//
//   "You've hit your weekly limit · resets 6pm (Europe/Berlin)"
//   "You've hit your weekly limit · resets Aug 30, 6pm (Europe/Berlin)"
//
// That makes a manual /usage lookup unnecessary for anyone who has ever hit the weekly cap —
// the information was already in data the plugin parses anyway, it just was not being read.
// Verified against Björn's four recorded weekly hits (01.10.2026): all four resolve to Sunday
// 18:00, including a Saturday 23:56 hit whose bare "6pm" has to roll forward to Sunday.
//
// The timezone is captured but NOT used for conversion: the message already states the moment
// in the user's own zone, which is the zone the rest of this calculation works in. The old
// pattern hard-coded "(Europe/Berlin)" and therefore silently failed for every user elsewhere.
function parseWeeklyReset(text, eventTs) {
  const m = String(text || '').match(/resets\s+(.+?)\s*\(([^)]+)\)/i);
  if (!m) return null;
  const when = m[1].trim();

  const hm = when.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!hm) return null;
  let hour = parseInt(hm[1], 10);
  const ap = hm[3].toLowerCase();
  if (ap === 'pm' && hour !== 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;

  const dm = when.match(/^([A-Za-z]{3})\s+(\d{1,2})/);
  let reset;
  if (dm) {
    const mo = _RESET_MONTHS.indexOf(dm[1].toLowerCase());
    if (mo < 0) return null;
    reset = new Date(new Date(eventTs).getFullYear(), mo, parseInt(dm[2], 10), hour, 0, 0, 0);
  } else {
    // Bare time, no date: the reset is the next occurrence of that hour. A hit late on
    // Saturday saying "6pm" means Sunday 18:00, not the Saturday that has already passed.
    const at = new Date(eventTs);
    reset = new Date(at);
    reset.setHours(hour, 0, 0, 0);
    if (reset <= at) reset.setDate(reset.getDate() + 1);
  }
  return { day: reset.getDay(), hour, tz: m[2].trim(), at: reset.getTime() };
}

function billingWeekStart(tsMs) {
  const dt = new Date(tsMs);
  // How many days back to the most recent reset weekday.
  let dBack = (dt.getDay() - _resetDay + 7) % 7;
  // Standing exactly on the reset day but before the reset hour means the current week began
  // a full seven days earlier.
  if (dBack === 0 && dt.getHours() < _resetHour) dBack = 7;
  const s = new Date(dt);
  s.setDate(dt.getDate() - dBack);
  s.setHours(_resetHour, 0, 0, 0);
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
  // Status role (v2.0): the focus score is a verdict, so it wears the status palette, never a
  // token-type colour — the old scale mixed both (green, then the Input blue, then amber).
  // Four distinct steps for four distinct badges. The bottom step stays grey rather than red:
  // "Scattered" is less focus, not a problem to fix, and red would overstate it.
  const color = score >= 80 ? '#0CA30C' : score >= 60 ? '#FAB219' : score >= 40 ? '#EC835A' : '#6B7280';
  return {
    score, badge, color,
    components: { cache: Math.round(cache), continuity: Math.round(continuity), depth: Math.round(depth) },
  };
}

// ── Limit currency (01.10.2026, corrected by measurement 02.10.2026) ─────────────────────
// Every figure that is compared against a rate limit runs through here, so the currency is
// defined once instead of in nineteen scattered sums. That single chokepoint is the lasting
// part of this; the weights themselves took a wrong turn first and are worth recording.
//
// First attempt weighted cache tokens by Anthropic's PRICE ratios (write 1.25x, read 0.10x) on
// the assumption that the rate limit is measured in the same currency as the bill. Björn did
// not believe the resulting numbers — two requests were being reported as ~2M tokens — and he
// was right. The assumption was never tested, although the data to test it was already there.
//
// The test: take every deduplicated session-limit hit (81 of them across Björn's whole history —
// the plugin's own estimate counts fewer, because it only looks back as far as the retention
// window. That is why a hard-coded count must never appear in the UI: it cannot agree with the
// live figure for long, and for a few hours on 02.10. it visibly did not),
// reconstruct the anchored 5h window it happened in, and total that window in each candidate
// currency. The currency Anthropic actually enforces must give the MOST CONSISTENT total at the
// moment the wall is hit — so the one with the lowest coefficient of variation wins.
//
//   input + output          median  308 K   CV 0.464   <- winner
//   weighted 1.25 / 0.10    median 7.22 M   CV 0.726
//   raw, everything         median 38.3 M   CV 0.797
//   input + output + write  median 2.03 M   CV 0.949
//
// A grid search over both weights (0…2.0 for write, 0…0.5 for read) landed on exactly 0.00 and
// 0.00. Cache tokens do not count toward the 5-hour limit at all in this data, and 308 K matches
// the figure Björn remembered from the earlier analysis.
//
// So the weights are zero — kept as named constants rather than deleted, because they are an
// empirical result that could change if Anthropic changes its accounting. Re-run the test
// (Design/Waehrungstest.js) before touching them.
//
// Note this is the LIMIT currency, not a usage total. Cache volume is real and is shown in full
// in the per-type rows (Input / Output / C.Write / C.Read) — it just does not move you toward
// the wall, so it must not appear in a figure that claims to say how close the wall is.
const W_CACHE_WRITE = 0;
const W_CACHE_READ  = 0;

// For an aggregate/day object ({ input, output, cacheCreate, cacheRead }).
function billedOf(a) {
  if (!a) return 0;
  return Math.round(
      (a.input  || 0)
    + (a.output || 0)
    + (a.cacheCreate || 0) * W_CACHE_WRITE
    + (a.cacheRead   || 0) * W_CACHE_READ
  );
}

// For a single raw JSONL entry. Same formula, different field names — deliberately not
// routed through billedOf() via a temporary object, because this one runs inside hot
// reduce() loops over tens of thousands of entries.
function billedEntry(e) {
  const u = (e && e.usage) || {};
  return (u.input_tokens  || 0)
       + (u.output_tokens || 0)
       + (u.cache_creation_input_tokens || 0) * W_CACHE_WRITE
       + (u.cache_read_input_tokens     || 0) * W_CACHE_READ;
}

// Rate-limit estimates (extracted 14.09.2026 from what used to be inline-only in
// _buildDashboard(), so the Sidebar's new Limit Pulse widget can compute the exact same
// sessionEst/weeklyLimitEst numbers as the Dashboard's Limit Hero — one source of truth, the two
// can never drift apart). Dedupes raw rate-limit events (weekly: max 1 per billing week; session:
// 15-min window, since parallel sessions can fire within seconds of each other — oldest kept as
// the causal one each time), then derives the session-limit estimate (min/max/median of the
// anchored 5h-window totals, measured from the window's opening up to each session-limit hit)
// and the weekly-limit estimate (lowest observed
// billing-week total among weeks that actually hit the weekly limit — a conservative lower bound).
// `anchors` (optional, 09.10.2026): official windows from the feed, so a hit inside a window that
// opened outside the logs is measured from the real start, see windows5h().
function computeRateLimitEstimates(rateLimitEvents, entries30sorted, now, anchors) {
  const rlRaw = (rateLimitEvents || []).slice().sort((a, b) => a.timestamp - b.timestamp);
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
  // Anchored, not sliding (04.10.2026, Björn). Each hit is measured inside the real 5-hour
  // window it happened in: from the moment that window opened up to the hit. This used to look
  // back a flat five hours from the hit, which is the same mistake the gauge had until 02.10.:
  // whenever the previous window had only just closed, the look-back dragged its tail into the
  // sum. On Björn's own data that inflated the median from 290.2K to 341.5K (24 of 85 hits
  // differed by more than 10%), so the ring compared an anchored numerator against an inflated
  // denominator and read about 18% too low. Gauge and estimate must be measured the same way.
  const wins = windows5h(entries30sorted, anchors);
  const HIT_SLACK = 10 * 60_000; // a hit is stamped a little after the last response of its window
  const windowOfHit = (ts) => {
    for (let i = wins.length - 1; i >= 0; i--) {
      if (wins[i].start <= ts) return ts <= wins[i].end + HIT_SLACK ? wins[i] : null;
    }
    return null;
  };
  const rlEvents = rlDeduped.map(ev => {
    const w     = windowOfHit(ev.timestamp);
    // No window found means the hit has no activity behind it inside the retained data
    // (e.g. its window opened before the retention cut-off). Counting it as 0 drops it from the
    // estimate through the > 50K filter below, which is the honest outcome: no data, no vote.
    const tok5h = w
      ? entries30sorted
          .filter(e => e.timestamp >= w.start && e.timestamp <= ev.timestamp)
          .reduce((s, e) => s + billedEntry(e), 0)
      : 0;
    let tokWeek = 0;
    if (ev.type === 'weekly') {
      const wkStart = billingWeekStart(ev.timestamp);
      tokWeek = entries30sorted
        .filter(e => e.timestamp >= wkStart && e.timestamp <= ev.timestamp)
        .reduce((s, e) => s + billedEntry(e), 0);
    }
    return Object.assign({}, ev, { tok5h, tokWeek });
  });
  const sessHits = rlEvents.filter(r => r.type === 'session' && r.tok5h > 50_000);
  // Usual band (Björn, 04.10.2026): the middle half of the hits (25th to 75th percentile, the quartiles).
  // One number suggests a precision the data does not have: the same limit is reached at quite
  // different token totals, because the true budget also depends on model mix and server load.
  // Min and max would be the wrong band, since a single odd hit drags either end far out.
  // Needs a handful of hits to mean anything, so below 5 the band stays null and the UI falls
  // back to the single figure.
  const hitsSorted = sessHits.map(r => r.tok5h).sort((a, b) => a - b);
  const percentile = (p) => {
    const pos = (hitsSorted.length - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return hitsSorted[lo] + (hitsSorted[hi] - hitsSorted[lo]) * (pos - lo);
  };
  const sessionEst = sessHits.length > 0 ? {
    n:      sessHits.length,
    min:    hitsSorted[0],
    max:    hitsSorted[hitsSorted.length - 1],
    median: hitsSorted[Math.floor(sessHits.length / 2)],
    bandLow:  sessHits.length >= 5 ? Math.round(percentile(0.25)) : null,
    bandHigh: sessHits.length >= 5 ? Math.round(percentile(0.75)) : null,
  } : null;
  const curWkStart = billingWeekStart(now.getTime());
  const weekBuckets = [];
  for (let i = 5; i >= 0; i--) {
    const wStart = curWkStart - i * 7 * 86_400_000;
    const wEnd   = wStart + 7 * 86_400_000;
    const wTok   = entries30sorted
      .filter(e => e.timestamp >= wStart && e.timestamp < wEnd)
      .reduce((s, e) => s + billedEntry(e), 0);
    const hitWeekly = rlEvents.some(r => r.type === 'weekly' && r.timestamp >= wStart && r.timestamp < wEnd);
    const wLabel = new Date(wStart).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })
      + '–' + new Date(wEnd - 86_400_000).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
    weekBuckets.push({ label: wLabel, tokens: wTok, hitWeekly });
  }
  const weeklyHitWks = weekBuckets.filter(w => w.hitWeekly && w.tokens > 0);
  const weeklyLimitEst = weeklyHitWks.length > 0
    ? Math.min.apply(null, weeklyHitWks.map(w => w.tokens))
    : null;
  return {
    rlEvents, sessionEst, weeklyLimitEst, weekBuckets,
    weeklyHits:   weeklyHitWks.length,
    totalSession: rlEvents.filter(r => r.type === 'session').length,
    totalWeekly:  rlEvents.filter(r => r.type === 'weekly').length,
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
      .reduce((s, e) => s + billedEntry(e), 0);
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

// Limits anchored on the official percentages (09.10.2026, Björn's statusline test).
// Anthropic publishes no limit in tokens, but the feed says how full each window is. Tokens in the
// window up to a reading, divided by that reading's percentage, is the limit that window actually
// had. At the moment of the reading the gauge then shows exactly the official figure, and between
// readings it moves on with the logged tokens.
//
// Why this replaced the hit-based figures where a feed exists: on 09.10.2026 the plugin showed
// the week at 141% while /usage said 61%. The token count was right (1.61M), the denominator was
// not: the lowest week that ever hit the cap (about 1.14M) against about 2.6M from the feed, which
// stayed between 2.47M and 2.69M across every reading of that week.
//
// Readings below FEED_MIN_PCT are skipped: the feed carries whole percents, and at 5% the rounding
// alone is worth plus or minus ten percent of the result.
//
// Known limit: the 5h budget depends on the model. Opus took about 1.8K tokens per percent,
// Sonnet about 3.8K (Björn's data, 06. to 09.10.2026). The current window's own reading carries
// its own mix, so it is exact; the fallback median across recent windows is not model-aware.
const FEED_MIN_PCT = 10;
const FEED_WEEK_MS = 7 * 86_400_000;
function computeFeedCalibration(feed, entriesAsc, nowMs) {
  const res = { readings: (feed || []).length, lastReading: null,
    h5Limit: null, h5Source: null, h5Typical: null, h5Windows: 0, h5PctNow: null, weekLimit: null, weekSource: null };
  if (!feed || !feed.length) return res;
  res.lastReading = feed[feed.length - 1].ts;
  const sumBetween = (from, to) => {
    let s = 0;
    for (const e of entriesAsc) {
      if (e.timestamp < from) continue;
      if (e.timestamp > to) break;
      s += billedEntry(e);
    }
    return s;
  };
  // Last usable reading per window: the highest one, never several from the same window.
  const perWindow = (key, span) => {
    const by = new Map();
    for (const r of feed) {
      const x = r[key];
      if (!x || x.pct < FEED_MIN_PCT) continue;
      const c = by.get(x.resets);
      if (!c || r.ts > c.ts) by.set(x.resets, { ts: r.ts, pct: x.pct, resets: x.resets });
    }
    return [...by.values()].sort((a, b) => a.resets - b.resets).map(w => {
      const tok = sumBetween(w.resets - span, w.ts);
      return Object.assign(w, { tok, limit: tok > 0 ? tok / (w.pct / 100) : 0 });
    }).filter(w => w.limit > 0);
  };
  const h5 = perWindow('h5', FIVE_H);
  // Typical rate (tokens per 100%) from CLOSED windows only, so the open window cannot pull it.
  const recent = h5.filter(w => w.resets <= nowMs && w.resets > nowMs - 14 * 86_400_000).map(w => w.limit).sort((a, b) => a - b);
  res.h5Windows = recent.length;
  res.h5Typical = recent.length ? Math.round(recent[Math.floor(recent.length / 2)]) : null;
  // Current window: the official reading is the base, new tokens are added on top at the typical
  // rate (fixed 09.10.2026, 16:52). Scaling the reading by its own tokens instead broke at the start
  // of a window: after a pause the cache had expired, the session re-wrote 258.6K of context into
  // it, and the official figure jumped to 17% on just 4.4K input+output. Divided out, that is a
  // "limit" of about 26K, and every following answer would have counted several times over.
  // Cache writes are front-loaded and the plugin does not count them, so the reading carries them.
  let curR = null;
  for (const r of feed) {
    if (r.h5 && r.h5.resets - FIVE_H <= nowMs && nowMs < r.h5.resets && (!curR || r.ts > curR.ts)) curR = r;
  }
  if (curR) {
    const start = curR.h5.resets - FIVE_H;
    const ioAt  = sumBetween(start, curR.ts);
    const ioNow = sumBetween(start, nowMs);
    const rate  = res.h5Typical || (curR.h5.pct >= FEED_MIN_PCT && ioAt > 0 ? ioAt / (curR.h5.pct / 100) : null);
    if (rate) {
      const pctNow = curR.h5.pct + Math.max(0, ioNow - ioAt) / rate * 100;
      res.h5PctNow = pctNow;
      // Expressed as an effective limit so every display keeps computing value / limit unchanged.
      if (ioNow > 0 && pctNow > 0) { res.h5Limit = Math.round(ioNow / (pctNow / 100)); res.h5Source = 'feed-window'; }
    }
  }
  if (!res.h5Limit && res.h5Typical) { res.h5Limit = res.h5Typical; res.h5Source = 'feed-median'; }
  const wk = perWindow('wk', FEED_WEEK_MS).filter(w => w.resets > nowMs - 3 * FEED_WEEK_MS);
  const curW = wk.find(w => w.resets - FEED_WEEK_MS <= nowMs && nowMs < w.resets);
  const pickW = curW || wk[wk.length - 1];
  if (pickW) { res.weekLimit = Math.round(pickW.limit); res.weekSource = curW ? 'feed-week' : 'feed-lastweek'; }
  return res;
}

// Everything limit-shaped in one place, for the sidebar and the Dashboard alike, so the two can
// never show different numbers for the same thing. The feed wins where it has a value; otherwise
// the hit-based estimates apply unchanged.
function computeLimitState(rateLimitEvents, entriesAsc, nowDate, avgDailyFallback, feed) {
  const anchors      = feedWindowAnchors(feed);
  const rlEst        = computeRateLimitEstimates(rateLimitEvents, entriesAsc, nowDate, anchors);
  const cal          = computeFeedCalibration(feed, entriesAsc, nowDate.getTime());
  const hitMedian    = (rlEst.sessionEst && rlEst.sessionEst.median) || 0;
  const weeklyLimit  = cal.weekLimit || rlEst.weeklyLimitEst || null;
  const weeklySource = cal.weekLimit ? 'feed' : (rlEst.weeklyLimitEst ? 'hits' : null);
  const h5Limit      = cal.h5Limit || hitMedian || 0;
  const h5Source     = cal.h5Limit ? 'feed' : (hitMedian ? 'hits' : null);
  // The figure to SHOW as "the 5h limit" (basis line, heatmap pace). h5Limit is the effective limit
  // of the open window and can be small right after a cache re-write; this one is the usual size.
  const h5Typical    = cal.h5Typical || hitMedian || h5Limit || 0;
  const weekStatus   = computeWeekStatus(entriesAsc, nowDate, weeklyLimit, avgDailyFallback);
  return { anchors, rlEst, cal, weeklyLimit, weeklySource, h5Limit, h5Source, h5Typical, weekStatus };
}

function aggregate(entries) {
  const r = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0, count: 0 };
  for (const e of entries) {
    r.input       += e.usage.input_tokens                || 0;
    r.output      += e.usage.output_tokens               || 0;
    r.cacheCreate += e.usage.cache_creation_input_tokens || 0;
    r.cacheRead   += e.usage.cache_read_input_tokens     || 0;
    r.cacheCreate1h += e.usage.cache_creation_1h || 0;
    r.cacheCreate5m += e.usage.cache_creation_5m || 0;
    r.count++;
  }
  r.billed = billedOf(r);
  return r;
}

// Tooltip for a C.Write row (2.1.0): the split into 1-hour and 5-minute cache writes, which are
// priced differently. Only shown when the log carried the split at all (older logs do not).
function cacheWriteTip(agg) {
  if (!agg || !(agg.cacheCreate1h || agg.cacheCreate5m)) return '';
  return t('cwSplitTip', fmtTokens(agg.cacheCreate1h || 0), fmtTokens(agg.cacheCreate5m || 0));
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
      total:   agg.billed,
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
    tokens[f] = (tokens[f] || 0) + billedEntry(e);
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
          const full = path.join(projDir, entry);
          if (entry.endsWith('.jsonl')) {
            try { const s = fs.statSync(full); files.push({ path: full, mtime: s.mtimeMs, size: s.size }); } catch(e) {}
            continue;
          }
          // Subagent logs (2.1.0, found 09.10.2026). Claude Code writes the work of subagents
          // (Agent tool) into <session>/subagents/agent-<id>.jsonl, not into the session file.
          // The plugin never read that folder, so subagent tokens were missing everywhere, on
          // single limit hits by up to 47K. Entries there carry the PARENT's sessionId, so they
          // join their session automatically. Marked `sub` so the current-session detection,
          // which goes by file name, never picks an agent file.
          const subDir = path.join(full, 'subagents');
          try {
            if (!fs.statSync(subDir).isDirectory()) continue;
            for (const sf of fs.readdirSync(subDir)) {
              if (!sf.endsWith('.jsonl')) continue;
              const sp = path.join(subDir, sf);
              try { const s = fs.statSync(sp); files.push({ path: sp, mtime: s.mtimeMs, size: s.size, sub: true }); } catch(e) {}
            }
          } catch(e) {}
        }
      } catch(e) {}
    }
  } catch(e) {}
}

// Anchors under which Claude Desktop keeps its agent-mode sessions — a Windows-only concept.
// On Windows, the desktop app's embedded Claude Code runs inside an app-container/MSIX sandbox
// that virtualises the filesystem, so its agent-mode sessions physically land in a separate
// location instead of the ordinary ~/.claude/projects/ that CLAUDE_DIR already reads:
//   MSIX/Store  — %LOCALAPPDATA%\Packages\<Claude_hash>\LocalCache\Roaming\Claude\...
//                 (the app itself only ever sees the virtualised %APPDATA%\Claude path, so the
//                  cwd recorded inside the files does NOT match this physical location)
//   classic     — %APPDATA%\Claude\...
// The package folder is globbed rather than hardcoded so the publisher hash can change.
//
// macOS/Linux have no equivalent split (confirmed 13.09.2026 — no MSIX-style app-container layer
// exists there, and Claude Code — CLI, editor integrations, and the desktop app alike — is
// documented to write to the same ~/.claude/projects/ everywhere, see
// https://claude-dev.tools/docs/log-locations). CLAUDE_DIR already covers that location on every
// platform via os.homedir(), so no separate agent-mode root is needed outside Windows; this
// function intentionally returns an empty array there rather than guessing an unverified path.
function getAgentModeRoots() {
  const roots = [];
  if (process.platform !== 'win32') return roots;

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
  const seenResponses    = new Map(); // message.id|requestId → index in entries (dedup, see pass 2)
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
              // Any timezone, not just Europe/Berlin (fixed 01.10.2026). The old pattern was
              // hard-coded to one zone, so for every user outside it this field stayed empty —
              // and with it the self-calibration below would never have fired.
              const rm   = text.match(/resets\s+(.+?)\s*\([^)]+\)/);
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
          const entry = {
            timestamp: ts, model: msg.model || 'unknown', sessionId: sid,
            cwd: obj.cwd || '', root: rootCwd || obj.cwd || '',
            usage: {
              input_tokens:                msg.usage.input_tokens                || 0,
              output_tokens:               msg.usage.output_tokens               || 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens:     msg.usage.cache_read_input_tokens     || 0,
              // 1-hour vs 5-minute cache writes (2.1.0, forum hint from aicost_tools, 05.10.2026).
              // Priced differently (2x vs 1.25x input). Missing in older logs: then both stay 0
              // and the C.Write tooltip simply says nothing about the split.
              cache_creation_1h: (msg.usage.cache_creation && msg.usage.cache_creation.ephemeral_1h_input_tokens) || 0,
              cache_creation_5m: (msg.usage.cache_creation && msg.usage.cache_creation.ephemeral_5m_input_tokens) || 0,
            }
          };
          // One API response, one count (v2.1, 06.10.2026). Claude Code writes the SAME response
          // to the JSONL once per content block and, for long streamed output, up to ~75 times —
          // each line repeating the full usage object of that one response. Summing every line
          // inflated a single 7.7K-token reply to ~580K. In a measured 30-minute window the
          // plugin showed 1.31M tokens against a real 70K. Key = message.id + requestId; the
          // entry with the highest output_tokens wins (lines of one response can carry a growing
          // output count while it streams). Lines without an id cannot be deduplicated and are
          // kept as before. Verified on 2,474 ids over 14 days: none spans more than one file,
          // so a per-file map is sufficient and no cross-file pass is needed.
          const dedupKey = msg.id ? msg.id + '|' + (obj.requestId || '') : '';
          if (dedupKey) {
            const prevIdx = seenResponses.get(dedupKey);
            if (prevIdx !== undefined) {
              if (entry.usage.output_tokens >= entries[prevIdx].usage.output_tokens) entries[prevIdx] = entry;
              continue;
            }
            seenResponses.set(dedupKey, entries.length);
          }
          entries.push(entry);
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
    // Activity calendar — which month is on screen. Same "persists across rebuilds" pattern
    // as _activePage; only read while the Calendar page is open. Starts on the current month.
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
    // Watch the newest SESSION file; a subagent file goes quiet the moment its agent finishes.
    const latest = (files.find(f => !f.sub) || files[0]).path;
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
      // Newest SESSION file, never a subagent file (those are named agent-<id>, see collectFromProjectsDir).
      const curFile = files.find(f => !f.sub);
      const curId   = curFile ? path.basename(curFile.path, '.jsonl') : null;

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

      // Self-calibration (v2.0): derive the weekly reset from the most recent weekly-limit
      // message. Runs before anything week-shaped is computed below, so the corrected moment
      // applies to this very refresh rather than only the next one.
      // Only overwrites an automatic value, never a manual one — if the user has set the reset
      // by hand, that is a deliberate statement and wins over our parsing.
      this._autoCalibrateWeeklyReset(allRateLimitEvents);

      const d7       = all.filter(e => e.timestamp >= day7Ts);
      // Anchored, not sliding (fix 02.10.2026, Björn). Anthropic's 5-hour window OPENS with the
      // first message and runs exactly five hours. A new window only starts once that span has
      // fully elapsed — windows5h() below checks `e.timestamp >= cur.end`, i.e. "has the current
      // window's 5h run out", not "was there an idle gap". Corrected 04.10.2026 (Björn): earlier
      // comments and UI text said "after an idle gap of 5h or more", which is not what the code
      // checks and not what Björn's own data showed — a chain of continuous messages still gets
      // a fresh window exactly 5h after the previous one opened, with zero idle time at the seam.
      // It is not "the last five hours from now", and it is independent of the weekly reset:
      // the weekly cap resetting does not also start a new 5-hour window.
      //
      // The old sliding filter produced a number belonging to no real window whenever a reset
      // fell inside it. In Björn's own data, 30.09. had windows 18:02–23:02 and 23:02–04:02 — at
      // 23:30 the sliding version summed 18:30–23:30, the tail of the old window plus the head
      // of the new one. That is precisely the moment a user needs to see that their budget just
      // reset, and it was the moment the figure was most wrong.
      // Official windows from the status line feed, if the user has one (09.10.2026). Read once
      // per refresh; an empty list leaves every calculation below exactly as it was.
      const rlFeed   = readRateLimitFeed(day30Ts);
      const curWin   = currentWindow5h(all, now, feedWindowAnchors(rlFeed));
      const win5h    = curWin ? all.filter(e => e.timestamp >= curWin.start && e.timestamp < curWin.end) : [];
      const win5hAgg = aggregate(win5h);
      // Window has expired (or never opened) but there was recent activity — the budget is fresh.
      const win6hTs      = now - 6 * 3_600_000;
      const windowCleared = !curWin && all.some(e => e.timestamp >= win6hTs);

      const sessionEntries = curId ? all.filter(e => e.sessionId === curId) : [];

      // Spike detection — compare today vs personal baseline (active days only). NOTE (09.10.2026):
      // despite the old "29-day" wording in comments, day30Ts is the retention cut-off
      // (cleanupPeriodDays, e.g. 120), so the baseline covers ALL stored days. Björn chose to keep
      // that and fix the labels instead; the help text already said it follows retention.
      const todayAgg      = aggregate(all.filter(e => e.timestamp >= todayTs));
      const todayTotal    = todayAgg.billed;
      const past29        = all.filter(e => e.timestamp >= day30Ts && e.timestamp < todayTs);
      const activeDays    = new Set(past29.map(e => dayStart(new Date(e.timestamp)))).size;
      const past29Total   = past29.reduce((s, e) => s + billedEntry(e), 0);
      const avgDaily      = activeDays > 0 ? past29Total / activeDays : 0;
      const spikeRatio    = (avgDaily > 0 && todayTotal > 0) ? Math.round(todayTotal / avgDaily * 10) / 10 : 0;

      // Community-requested "outlier" signal (Obsidian Forum, shipped as the Today spike badge
      // in v1.6.0), extended to the 7-Days Overview tile (Björn, 01.09.2026, Nachschärfungsliste
      // Punkt 6) — same 29-day baseline (avgDaily) reused, not a second baseline concept. Compares
      // this week's average tokens per active day against that same baseline.
      const d7ActiveDays  = new Set(d7.map(e => dayStart(new Date(e.timestamp)))).size;
      const d7Total       = d7.reduce((s, e) => s + billedEntry(e), 0);
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

      // Weekly limit estimate + billing-week-so-far total (v1.9, Sidebar Limit Pulse) — same
      // computeRateLimitEstimates()/computeWeekStatus() the Dashboard's Limit Hero uses, so the
      // Sidebar and the Dashboard can never show two different numbers for the same thing.
      const nowDate      = new Date(now);
      const entries30Asc = all.slice().sort((a, b) => a.timestamp - b.timestamp);
      const limits       = computeLimitState(allRateLimitEvents, entries30Asc, nowDate, avgDaily, rlFeed);
      const rlEst        = limits.rlEst;
      const weekStatus   = limits.weekStatus;

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
        window5h: {
          agg:     win5hAgg,
          // The anchored window's own start and end, so the countdown below is the real reset
          // moment rather than "five hours after the oldest entry that happens to still be
          // inside a sliding window".
          oldest:  curWin ? curWin.start : null,
          start:   curWin ? curWin.start : null,
          end:     curWin ? curWin.end   : null,
          total:   win5hAgg.billed,
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
        // Sidebar Limit Pulse — today's total vs. the user's own average, and this billing
        // weekly limit, and this billing week's total vs. that same weekly-limit estimate.
        // weeklyLimitEst is null until at least one weekly-limit hit has ever been observed.
        // Exposed to the sidebar as well since 02.10.2026 — it was computed here all along but
        // only ever handed to the Dashboard, so the plugin-side CSV export would have written
        // empty cells for forecast and week share without noticing.
        weekStatus,
        weekPulse: {
          // Effective limits (09.10.2026): from the status line feed where it has a value,
          // otherwise the hit-based estimates. `*Source` says which ('feed' | 'hits' | null);
          // the hit-based weekly figure stays available as weeklyLimitHits for comparison.
          weeklyLimitEst:  limits.weeklyLimit,
          weeklySource:    limits.weeklySource,
          weeklyLimitHits: rlEst.weeklyLimitEst,
          h5Limit:         limits.h5Limit,
          h5Typical:       limits.h5Typical,
          h5Source:        limits.h5Source,
          feedCal:         limits.cal,
          weekSoFar:      weekStatus.soFar,
          remainingDays:  weekStatus.remainingDays,
          sessionEst:     rlEst.sessionEst,
          weeklyHits:     rlEst.weeklyHits,
          totalSession:   rlEst.totalSession,
          window5h:       win5hAgg.billed,
          // The calendar day, deliberately (Björn, 01.10.2026: "alle heute am 01.10. verbrauchten
          // Token"). This briefly used the current 24-hour slice of the billing week instead,
          // which was right while the tile was compared against a fair daily share of the weekly
          // limit — share and slice had to span the same hours. The share turned out to be
          // invented and is gone; the tile compares against the user's own daily average now, so
          // the honest span is the one the label promises: today.
          todayTotal:     todayTotal,
        },
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
      this.data.day30.billed = billedOf(this.data.day30);
      // NextGen sidebar tiles (Phase 2 iteration) — active-day count + tokens/active-day for
      // the N-Days period, same "productive days, not calendar days" principle as the
      // Dashboard's summary cards (Björn, 24.08.2026). Computed here (not in render()) because
      // periodSeries is already in hand; render() shouldn't redo _buildDayRange() on every draw.
      this.data.day30ActiveDays = periodSeries.filter(x => x.reqs > 0).length;
      this.data.day30AvgPerActiveDay = this.data.day30ActiveDays > 0
        ? Math.round(this.data.day30.billed / this.data.day30ActiveDays)
        : 0;

      if (curFile && curFile.path !== this._watchedFile) this._setupWatcher();
      this._archiveDays(); // fire-and-forget — never blocks the render path; backfills + updates today
    } catch(err) {
      console.error('AnthropicUsage refresh error:', err);
    }
    this.render();
  }

  // Reads the weekly reset out of the newest weekly-limit message and stores it, unless the
  // user has set it manually. Silent by design: nothing to confirm, nothing to click — the
  // settings page shows afterwards that it was detected and from which hit.
  _autoCalibrateWeeklyReset(events) {
    const s = this.plugin.settings;

    const weekly = (events || [])
      .filter(e => e.type === 'weekly' && e.message)
      .sort((a, b) => b.timestamp - a.timestamp);
    if (weekly.length === 0) return;

    const parsed = parseWeeklyReset(weekly[0].message, weekly[0].timestamp);
    if (!parsed) return;

    const sameAsStored = s.weeklyResetDay === parsed.day && s.weeklyResetHour === parsed.hour;

    // A manual setting that the data contradicts stays untouched — the user had a reason, and
    // one parsed message is not enough to overrule them. A manual setting the data *confirms*
    // is a different case: the value no longer rests on a guess, so it gets relabelled as
    // detected. Nothing the user chose changes, only where the plugin says the value comes from.
    if (s.weeklyResetSource === 'manual' && !sameAsStored) return;

    // Already detected and unchanged — nothing to write, no settings churn on every refresh.
    if (sameAsStored && s.weeklyResetSource === 'auto') return;

    s.weeklyResetDay    = parsed.day;
    s.weeklyResetHour   = parsed.hour;
    s.weeklyResetSource = 'auto';
    s.weeklyResetSetAt  = new Date().toISOString();
    s.weeklyResetFrom   = weekly[0].timestamp;  // which hit it came from, shown in settings
    setBillingWeekReset(parsed.day, parsed.hour);
    this.plugin.saveSettings();
  }

  render() {
    const el = this.containerEl.children[1];
    // Preserve scroll position across the render() cycle (Björn, 03.09.2026) — refresh() calls
    // render() unconditionally every refreshSeconds (default 30s), and render() always empties
    // and rebuilds the whole tree. Without this, any mid-scroll read (most noticeably the
    // inline Settings page) gets yanked back to the top every 30 seconds. Captured BEFORE
    // el.empty() below, from `.au-content` inside the rail shell (`el` itself is
    // overflow-y:hidden, see .au-container.au-nextgen in styles.css) — and since the whole
    // shell is torn down and rebuilt every render(), that's a brand-new element each time, not
    // the same node whose scrollTop would simply persist on its own.
    const prevScrollEl = el.querySelector('.au-content');
    const savedScroll   = prevScrollEl ? prevScrollEl.scrollTop : 0;

    el.empty();
    el.addClass('au-container');
    // Kept as a class rather than folded into .au-container (v2.0) — styles.css still keys the
    // rail shell's layout off it, and collapsing the two is a styling cleanup, not part of
    // removing the Classic render path.
    el.addClass('au-nextgen');

    // ── Header (always present)
    const hdr = el.createEl('div', { cls: 'au-header' });

    // Logo
    const logoEl = hdr.createEl('div', { cls: 'au-logo' });
    // "Usage" set apart in the brand yellow, matching the logo lockup (Björn, 30.09.2026).
    // A proper name, not a verdict — hence the one place a status hue is allowed outside its role.
    logoEl.innerHTML = LOGO_SVG + '<span class="au-logo-text">Token <span class="au-logo-accent">Usage</span></span>';

    // Button group
    const btnWrap = hdr.createEl('div', { cls: 'au-header-btns' });

    const dashBtn = btnWrap.createEl('button', { cls: 'au-dash-btn', text: 'Dashboard' });
    dashBtn.title   = 'Open BI dashboard in browser (HTML + charts)';
    dashBtn.onclick = () => this._generateDashboard();

    const reportBtn = btnWrap.createEl('button', { cls: 'au-report-btn', text: 'Report' });
    reportBtn.title   = 'Create Markdown report in vault and open it';
    reportBtn.onclick = () => this._generateReport();

    // CSV sits next to Dashboard and Report because it is the same kind of action — all three
    // produce a file. Added 02.10.2026 after Björn's verdict on the command-palette-only
    // version: "schön, selbsterklärend und einfach ist das nicht". A feature reachable only by
    // typing its name into a palette is a feature most users never find.
    //
    // The menu names its own destination in its first, non-clickable line, so you can see where
    // the files go BEFORE you click — rather than finding out afterwards by searching for them,
    // which is exactly what happened with the Dashboard's browser downloads.
    const csvBtn = btnWrap.createEl('button', { cls: 'au-csv-btn', text: 'CSV' });
    csvBtn.title = t('csvBtnTitle');
    csvBtn.onclick = (evt) => {
      const folder = this.plugin.settings.csvPath || 'Token Usage Exports';
      const menu = new obsidian.Menu();
      menu.addItem(i => i.setTitle(t('csvMenuTarget', folder)).setDisabled(true));
      menu.addSeparator();
      for (const [key, label] of [
        ['all',      t('csvMenuAll')],
        ['projects', t('csvMenuProjects')],
        ['daily',    t('csvMenuDaily')],
        ['kpis',     t('csvMenuKpis')],
      ]) {
        menu.addItem(i => i.setTitle(label).setIcon('download').onClick(() => this._exportCsv(key)));
      }
      menu.showAtMouseEvent(evt);
    };

    const refreshBtn = btnWrap.createEl('button', { cls: 'au-refresh-btn', text: '↻' });
    refreshBtn.title   = 'Refresh now';
    refreshBtn.onclick = () => this.refresh();

    // No ⚙ button here (v2.0): the rail has its own Settings icon, so a header button would
    // just be a redundant second entry point to the same page.
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

    // ── Shell: left icon rail + content area. See _renderRail()/_renderPages().
    const shell = el.createEl('div', { cls: 'au-shell' });
    this._renderRail(shell);
    const content = shell.createEl('div', { cls: 'au-content' });
    // Restoring `content.scrollTop` right here (synchronously) would be clamped straight back to
    // 0 — the element has no children yet, so its scrollHeight is 0. Every branch below finishes
    // populating `content` (or a container inside it) synchronously before render() returns, so a
    // single rAF callback scheduled here — after all of them, before the next paint — covers
    // every return path (help mode, loading state, rail pages) without having to duplicate the
    // restore call at each one.
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

    // Anchor block: pinned to the top of the scrolling content area on every rail page, so the
    // page-specific content below scrolls underneath it. Since the five-page rail (v2.0) only
    // the live-timestamp line stays here — the heatmap moved to the Calendar page and the model
    // bar to Analytics, where each has room instead of squeezing every page down.
    const anchor = content.createEl('div', { cls: 'au-content-anchor' });
    const meta = anchor.createEl('div', { cls: 'au-meta' });
    meta.createEl('span', { cls: 'au-live', text: `${this._watcher ? '● Live' : '○'} ${d.updatedAt.toLocaleTimeString('en-GB')}` });

    // Rest of the body goes through the rail's page dispatch.
    this._renderPages(content, d);
    this._renderFooter(content, d);
  }

  // ── Footer ────────────────────────────────────────────────────
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
    // Five pages (v2.0, from Björn's mockup). The landing page keeps the name "Today" rather
    // than "Dashboard" as the mockup had it: "Dashboard" already means the HTML dashboard that
    // opens in the browser, and one word for two different things would make every help text
    // and support answer ambiguous (Björn, 30.09.2026).
    // No Report page in the rail, deliberately (Björn, 30.09.2026): Dashboard and Report stay
    // as header buttons, so a rail entry would be a second door to the same two actions — the
    // same reason the ⚙ button left the header when the rail got its Settings page.
    const pages = [
      { key: 'today',     icon: 'bar-chart-2', label: t('today')         },
      { key: 'calendar',  icon: 'calendar',    label: t('railCalendar')  },
      { key: 'analytics', icon: 'activity',    label: t('railAnalytics') },
      { key: 'settings',  icon: 'settings',    label: t('railSettings')  },
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

  _renderPages(el, d) {
    switch (this._activePage) {
      // 'overview' is the pre-2.0 key for what is now 'analytics'. Existing users have it
      // persisted in memory from their last session, so it maps to the new page instead of
      // silently falling through to Today.
      case 'overview':
      case 'analytics': this._renderAnalyticsPage(el, d); break;
      case 'calendar':  this._renderCalendarPage(el, d);  break;
      case 'settings':  this._renderSettingsPage(el);     break;
      case 'today':
      default:          this._renderTodayPage(el, d);     break;
    }
  }

  // Today page (was "Overview" in the first revision, renamed) = Last Action + 5h Window +
  // This Session + Today — verbatim the same content and renderers Classic uses for these
  // (_renderWindow5h/_renderPeriod/_renderPeriodToday), just moved here so they only show on
  // this one page instead of always inline. Default landing page in NextGen mode.
  // Sidebar "Limit Pulse" — Today vs. the user own recent average, and this week vs. the
  // weekly limit, and this billing week's total vs. that same weekly-limit estimate. Deliberately
  // the very first thing on the Today page (Björn: "sofort mit einem Blick sehen"), reusing
  // computeRateLimitEstimates()/computeWeekStatus() so the numbers can never drift from the
  // Dashboard's Limit Hero — same source, same math, just a more compact presentation.
  _renderLimitPulse(parent, d) {
    const wp = d.weekPulse || {};
    const { body } = this._makeSection(parent, 'limitPulse', t('limitPulseTitle'));
    if (!wp.weeklyLimitEst) {
      body.createEl('div', { cls: 'au-section-sub', text: t('limitPulseNoWeekly') });
      return;
    }
    // No daily quota exists (Björn, 01.10.2026). Anthropic enforces an anchored 5-hour window and
    // a weekly cap — nothing in between. The old "fair daily share" (weeklyLimitEst / 7) was an
    // invention of ours, and measuring a real day against an imaginary budget produced a verdict
    // that looked authoritative while standing on nothing.
    // Today is therefore compared against the user's OWN 29-day average per active day — the
    // same baseline the heatmap, the calendar dots and the Today verdict glyphs already use. It
    // claims no limit; it says "busier or quieter than you usually are".
    const dailyBase  = d.avgDaily || 0;
    const todayTotal = wp.todayTotal || 0;
    // The 5h window is the limit that actually stops work mid-task, so it leads. Its target is
    // the median of the user's own observed session-limit hits — the same figure the Dashboard's
    // Limit Hero uses. Median rather than min, because the lowest hit ever seen is an outlier,
    // not a ceiling. Null until a hit has been observed; then the panel shows the raw figure and
    // claims nothing, same as the weekly one does before its first hit.
    // Since 09.10.2026 the status line feed wins where it has a value (wp.h5Source === 'feed'):
    // the limit then comes from the official percentage, not from the median of hits.
    const sessBase = wp.h5Limit || (wp.sessionEst && wp.sessionEst.median) || 0;
    const h5Feed   = wp.h5Source === 'feed';
    // Shown figure: the usual 5h limit. sessBase is the open window's effective limit and can be
    // far smaller right after a cache re-write, so it drives the ring but is not printed.
    const sessShow = (h5Feed && wp.h5Typical) ? wp.h5Typical : sessBase;
    const sessNote = sessBase <= 0 ? ''
      : h5Feed ? t('limitPulseBasisFeed').replace('{v}', fmtTokens(sessShow))
      : (wp.sessionEst ? t('limitPulseBasis', wp.sessionEst.n).replace('{v}', fmtTokens(sessBase)) : '');
    const weekNote = (wp.weeklySource === 'feed' && wp.weeklyLimitEst)
      ? t('limitPulseWeekFeed').replace('{v}', fmtTokens(wp.weeklyLimitEst)) : '';
    // The two panels need DIFFERENT bands, because they answer different questions.
    // Against a limit, 100% is the ceiling — 80% already deserves a warning.
    // Against your own average, 100% is a perfectly ordinary day. Applying the limit bands
    // there would paint every normal day red. 1.5x is "busier than usual", 2x is the spike
    // threshold the rest of the plugin already uses.
    const LIMIT_BANDS = [
      { upTo: 80,       key: 'good' },
      { upTo: 100,      key: 'warn' },
      { upTo: Infinity, key: 'bad'  },
    ];
    const AVERAGE_BANDS = [
      { upTo: 150,      key: 'good' },
      { upTo: 200,      key: 'warn' },
      { upTo: Infinity, key: 'bad'  },
    ];
    const items = [
      { lbl: t('limitPulse5h'),    val: wp.window5h,  target: sessBase,          subKey: 'limitPulseOf5h',     bands: LIMIT_BANDS,
        note: sessNote, plainTip: h5Feed },
      // Neutral colour (Björn, 09.10.2026): Today is no limit, a busy day is only a change in how
      // you work. Green/amber/red here read like a limit warning next to two real limits.
      { lbl: t('limitPulseToday'), val: todayTotal,   target: dailyBase,         subKey: 'limitPulseOfDaily',  bands: AVERAGE_BANDS, neutral: true },
      { lbl: t('limitPulseWeek'),  val: wp.weekSoFar, target: wp.weeklyLimitEst, subKey: 'limitPulseOfWeekly', bands: LIMIT_BANDS,
        note: weekNote },
    ];
    const row = body.createEl('div', { cls: 'au-pulse-row' });
    for (const it of items) {
      // No baseline yet (fresh install, no active days) — show the raw figure, claim nothing.
      if (!it.target) {
        const item0 = row.createEl('div', { cls: 'au-pulse-item' });
        item0.createEl('div', { cls: 'au-pulse-lbl', text: it.lbl });
        item0.createEl('div', { cls: 'au-pulse-val', text: fmtTokens(it.val) });
        continue;
      }
      const pct = Math.round((it.val / it.target) * 100);
      const verdict = it.neutral ? 'neutral' : bandedVerdict(pct, it.bands);
      const item = row.createEl('div', { cls: 'au-pulse-item' });
      item.createEl('div', { cls: 'au-pulse-lbl', text: it.lbl });
      // Compact ring (v2.0) — the sidebar's version of the dashboard's budget rings, scaled to
      // a 300px panel. Built as a plain SVG string via innerHTML, the same approach the sidebar
      // already uses for LOGO_SVG and the Overview sparklines.
      const ringWrap = item.createEl('div', { cls: 'au-pulse-ring' });
      ringWrap.innerHTML = auRingSvg(pct, verdict === 'neutral' ? 'var(--au-gray)' : `var(--au-${verdict === 'bad' ? 'crit' : verdict})`);
      item.createEl('div', { cls: `au-pulse-val au-pulse-val-${verdict}`, text: fmtTokens(it.val) });
      item.createEl('div', { cls: 'au-pulse-pct', text: t(it.subKey, pct) });
      // Name the denominator (Björn, 02.10.2026: "wo zeigen wir den gemessenen Median?"). The
      // panels printed a percentage of a number the sidebar never stated anywhere — fine as long
      // as you trust it, useless the moment you want to check it. Tooltip rather than a fourth
      // line, because three tiles in a 300px panel have no room for one.
      // plainTip: with the feed, the 5h target is an effective limit, not a figure worth printing.
      item.title = (it.plainTip ? `${fmtTokens(it.val)} · ${pct}%` : `${fmtTokens(it.val)} / ${fmtTokens(it.target)}`)
        + (it.note ? `\n${it.note}` : '');
    }
    // The long explanation that used to sit here moved into the glossary (Björn, 02.10.2026:
    // "das ist zuviel Text"). It also carried a hard-coded hit count from one analysis, which
    // contradicted the live figure on the line below — see the Limits section in the help panel.
    // The 5h estimate in full, in words: the number every ring and every heatmap cell on this
    // page is measured against. Only shown once a hit has actually been observed.
    //
    // The value is its own element so it can be styled (Björn, 02.10.2026: bold, the figure red
    // and underlined, centred). The translations carry a {v} placeholder rather than taking the
    // formatted number as an argument — the figure sits in a different position in each language,
    // and splitting on a placeholder survives that, while assuming a fixed position would not.
    if (sessBase > 0 && (h5Feed || wp.sessionEst)) {
      const parts = (h5Feed ? t('limitPulseBasisFeed') : t('limitPulseBasis', wp.sessionEst.n)).split('{v}');
      const basis = body.createEl('div', { cls: 'au-section-sub au-pulse-basis' });
      basis.createSpan({ text: parts[0] });
      basis.createSpan({ cls: 'au-pulse-basis-val', text: fmtTokens(sessShow) });
      if (parts[1]) basis.createSpan({ text: parts[1] });
      // The band underneath, in plain muted text: the median is the reference, this line says
      // how much that reference wobbles. Skipped while there are too few hits for a band, and
      // when the figure comes from the feed (the band describes hits, not that figure).
      const se = wp.sessionEst;
      if (!h5Feed && se && se.bandLow && se.bandHigh) {
        body.createEl('div', { cls: 'au-section-sub au-pulse-band',
          text: t('limitPulseBand', fmtTokens(se.bandLow), fmtTokens(se.bandHigh)) });
      }
    }
  }

  // Today page — strictly today or the last 7 days (Björn, 01.10.2026). Anything covering a
  // longer span belongs on Analytics or in the Dashboard, so the page has one honest timeframe.
  _renderTodayPage(el, d) {
    // Gauges first, heatmap below (Björn, 02.10.2026). The three rings answer "where do I stand
    // right now", which is the question the page exists for; the heatmap is the context for that
    // answer, so it reads better underneath it than above it.
    this._renderLimitPulse(el, d);
    this._renderWeekHeatmap(el, d, d.entries7);
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

  // Analytics page (v2.0, renamed from "Overview") = the 7 Days/N Days tile grids plus the
  // model distribution bar, which used to sit in the anchor above every page. Grouping both
  // here gives the page an actual subject — "how has usage behaved over time" — instead of
  // being a leftover tile grid.
  _renderAnalyticsPage(el, d) {
    const weekBadge = d.spikeRatioWeek >= 2
      ? { verdict: 'warn', text: `${d.spikeRatioWeek.toFixed(1)}×` }
      : null;
    this._renderPeriodTiles(el, '7-days',  t('sevenDays'), d.day7, 7,
      d.chart7.filter(x => x.total > 0).length, d.chart7, weekBadge);
    this._renderPeriodTiles(el, '30-days', t('thirtyDays', d.reportPeriodDays), d.day30,
      d.reportPeriodDays, d.day30ActiveDays, d.periodSeries);
    this._renderModelBar(el, d.entries7);
  }

  // Calendar page (v2.0, Björn 30.09.2026; reduced to two months 01.10.2026) — nothing but the
  // month grids now. The heatmap that used to share this page moved to Today in its new
  // day-level form, which left the calendar with a single subject: the months themselves.
  //
  // Two months instead of one, because a single month hides the thing people look for here —
  // what the run-up looked like. At the start of a month, one grid shows three usable days.
  // The arrows shift the pair, so the personal day notes stay reachable all the way back.
  _renderCalendarPage(el, d) {
    const loc  = localeFor(_lang);
    const cur  = new Date(this._calYear, this._calMonth, 1);
    const prev = new Date(this._calYear, this._calMonth - 1, 1);
    const now  = new Date();

    const minReached = this._calYear < 2020 || (this._calYear === 2020 && this._calMonth <= 0);
    const maxReached = this._calYear === now.getFullYear() && this._calMonth === now.getMonth();

    const wrap = el.createEl('div', { cls: 'au-calendar' });
    const head = wrap.createEl('div', { cls: 'au-cal-head' });
    const back = head.createEl('button', { cls: 'au-cal-nav', text: '‹' });
    back.title = t('calPrev');
    back.disabled = minReached;
    if (!minReached) back.onclick = () => this._calShift(-1);
    head.createEl('span', { cls: 'au-cal-title', text:
      prev.toLocaleDateString(loc, { month: 'short' })
      + ' – ' + cur.toLocaleDateString(loc, { month: 'short', year: 'numeric' }) });
    const fwd = head.createEl('button', { cls: 'au-cal-nav', text: '›' });
    fwd.title = t('calNext');
    fwd.disabled = maxReached;
    if (!maxReached) fwd.onclick = () => this._calShift(1);

    for (const m of [prev, cur]) {
      wrap.createEl('div', { cls: 'au-cal-month-lbl',
        text: m.toLocaleDateString(loc, { month: 'long', year: 'numeric' }) });
      this._renderMonthGrid(wrap, d, m.getFullYear(), m.getMonth());
    }
  }


  // Settings page (Phase E) — the exact same Setting objects the real Obsidian settings tab
  // uses (buildSettingsUI(), shared, defined once), rendered directly into the panel instead of
  // a separate modal. refreshUI here is this.render() (redraws the whole panel, cheap and
  // already the pattern every other rail click uses) rather than a settings-tab-only display().
  _renderSettingsPage(el) {
    const wrap = el.createEl('div', { cls: 'au-inline-settings' });
    buildSettingsUI(wrap, this.app, this.plugin, () => this.render());
  }

  // ── Activity calendar, one month grid ────────────────────────────
  // One dot per past active day, banded against the same 29-day avgDaily baseline the Today
  // spike badge and the heatmap use (no second baseline concept). Every cell is clickable for
  // a personal day note.
  //
  // No header and no navigation here — the page above owns both, because its two month grids
  // share one pair of arrows. Split out of _renderCalendar() on 01.10.2026 when the page went
  // from one month to two; the cell logic below is unchanged.
  _renderMonthGrid(parent, d, year, month) {
    const loc = localeFor(_lang);
    const grid = parent.createEl('div', { cls: 'au-cal-grid' });
    // Weekday header, Monday-first, localised short names (2024-01-01 is a Monday).
    const wkRef = new Date(2024, 0, 1);
    for (let i = 0; i < 7; i++) {
      const dd = new Date(wkRef); dd.setDate(wkRef.getDate() + i);
      grid.createEl('span', { cls: 'au-cal-dow', text: dd.toLocaleDateString(loc, { weekday: 'short' }) });
    }

    const avg = d.avgDaily || 0;
    const comments = this.plugin.settings.dailyComments || {};
    for (const c of this._buildMonthDays(year, month)) {
      const dateKey  = new Date(c.ts).toISOString().slice(0, 10);
      const noteText = comments[dateKey] || '';
      const cell = grid.createEl('span', {
        cls: 'au-cal-day'
          + (c.outside  ? ' is-outside' : '')
          + (c.isToday  ? ' is-today'   : '')
          + (c.isFuture ? ' is-future'  : '')
          + (noteText   ? ' has-comment' : ''),
      });
      cell.createEl('span', { cls: 'au-cal-dom', text: String(c.dom) });
      const total = c.billed || 0;
      let verdict = null;
      if (!c.isFuture && total > 0 && avg > 0) {
        verdict = bandedVerdict(total / avg, [
          { upTo: 1,        key: 'good' }, // below the recent daily average
          { upTo: 2,        key: 'warn' }, // roughly average up to 2×
          { upTo: Infinity, key: 'bad'  }, // 2× or more — a spike
        ]);
        cell.createEl('span', { cls: `au-cal-dot au-cal-dot-${verdict}` });
      }
      // Tooltip and click target are the WHOLE cell, not just the small dot — a 5px dot is
      // hard to hit precisely with a mouse, the ~22px cell is not. Every day is clickable to
      // add/edit a personal note, regardless of whether it has usage data.
      // Tooltip layout: line 1 is date + token usage, line 2+ is the note, wrapped at ~30
      // chars so a long personal note doesn't render as one unstructured strip (Björn, 24.09.2026).
      const dateLabel = new Date(c.ts).toLocaleDateString(loc);
      const usageLine = [dateLabel];
      if (verdict !== null) usageLine.push(fmtTokens(total));
      const lines = [usageLine.join(' · ')];
      if (noteText) lines.push(t('calNoteEdit') + ':', wrapText(noteText, 30));
      else lines.push(t('calNoteAdd'));
      cell.title = lines.join('\n');
      cell.addEventListener('click', () => {
        new DayCommentModal(this.app, c.ts, comments[dateKey], async (newText) => {
          const next = Object.assign({}, this.plugin.settings.dailyComments || {});
          if (newText) next[dateKey] = newText; else delete next[dateKey];
          this.plugin.settings.dailyComments = next;
          await this.plugin.saveSettings();
          this.render();
        }).open();
      });
    }
  }

  // ── CSV export from the plugin (Björn, 02.10.2026) ───────────────────────────
  // The Dashboard already exports the same three files, but as browser downloads — and a web
  // page cannot choose a target folder, only a filename. Björn wanted the folder configurable,
  // which is only honest if the plugin writes the files itself. So it does, into a vault folder
  // like the report and the archive, and the Dashboard download stays for the quick grab.
  //
  // Shared rows use the Dashboard's exact metric names on purpose — two routes to the same
  // figure must not label it differently. The two files are not byte-identical though: the
  // Dashboard additionally has the Focus Score, which is only computed while building the
  // Dashboard, and this side additionally has Today, the current 5h window and the counting
  // note, which the sidebar has and the Dashboard payload does not.
  async _exportCsv(which) {
    const d = this.data;
    if (!d) { new obsidian.Notice(t('csvNoData')); return; }

    const folder = (this.plugin.settings.csvPath || 'Token Usage Exports').replace(/^\/+|\/+$/g, '');
    try {
      if (folder && !(await this.app.vault.adapter.exists(folder))) {
        await this.app.vault.createFolder(folder);
      }
    } catch (err) {
      // Already exists as a race, or the name collides with a file — either way, report it
      // rather than writing the CSVs somewhere the user did not ask for.
      if (!(await this.app.vault.adapter.exists(folder))) {
        new obsidian.Notice(t('csvFolderFailed', folder));
        console.error('AnthropicUsage CSV folder error:', err);
        return;
      }
    }

    const kinds = which === 'all' ? ['projects', 'daily', 'kpis'] : [which];
    const stamp = csvIsoNode(Date.now());
    const written = [];
    for (const kind of kinds) {
      const rows = this._csvRows(kind);
      if (!rows || rows.length < 2) continue; // header only = nothing to say
      const path = (folder ? folder + '/' : '') + `token-usage-${kind}-${stamp}.csv`;
      await this.app.vault.adapter.write(path, CSV_BOM + csvFromNode(rows));
      written.push(path);
    }
    if (written.length === 0) { new obsidian.Notice(t('csvNoData')); return; }
    // Name the files, not just the count — "3 files written" still leaves the user hunting.
    // The folder is then one click away via the Settings button next to the path.
    new obsidian.Notice(
      t('csvWritten', written.length, folder || '/') + '\n'
      + written.map(p => '· ' + p.split('/').pop()).join('\n'),
      8000
    );
  }

  _csvRows(kind) {
    const d = this.data;
    const series = d.periodSeries || [];

    if (kind === 'projects') {
      const rows = [['Level', 'Vault / root', 'Sub-project', 'Tokens', '% of parent', 'Active days', 'First active', 'Last active']];
      for (const p of this._computeProjectOverview(series)) {
        rows.push(['vault', p.label, '', p.tokens || 0, p.pct || 0, p.activeDays || 0, csvIsoNode(p.firstTs), csvIsoNode(p.lastTs)]);
        for (const s of (p.projects || [])) {
          rows.push(['sub', p.label, s.label, s.tokens || 0, s.pct || 0, '', '', '']);
        }
      }
      return rows;
    }

    if (kind === 'daily') {
      const labels = [];
      for (const day of series) {
        for (const l of Object.keys(day.byRoot || {})) if (labels.indexOf(l) === -1) labels.push(l);
      }
      labels.sort();
      const rows = [['Date'].concat(labels).concat(['Total'])];
      for (const day of series.slice().sort((a, b) => a.ts - b.ts)) {
        const cells = labels.map(l => { const r = (day.byRoot || {})[l]; return r ? r.total : 0; });
        rows.push([csvIsoNode(day.ts)].concat(cells).concat([day.billed || 0]));
      }
      return rows;
    }

    // Key figures. Same metric names as the Dashboard export so the two files line up.
    const ws  = d.weekStatus || {};
    const wp  = d.weekPulse  || {};
    const per = (d.reportPeriodDays || 30) + ' days';
    const rows = [['Metric', 'Value', 'Unit', 'Scope']];
    const add = (m, v, u, s) => rows.push([m, (v === null || v === undefined) ? '' : v, u || '', s || '']);
    add('Total tokens',              d.day30 ? d.day30.billed : null, 'tokens', per);
    add('API calls',                 d.day30 ? d.day30.count  : null, 'calls',  per);
    add('Active days',               d.day30ActiveDays,       'days',   per);
    add('Period length',             d.reportPeriodDays,      'days',   per);
    add('Avg tokens per active day', d.day30AvgPerActiveDay,  'tokens', per);
    add('Cache write',               d.day30 ? d.day30.cacheCreate : null, 'tokens', per);
    add('Cache read',                d.day30 ? d.day30.cacheRead   : null, 'tokens', per);
    add('Cache efficiency', (d.day30 && d.day30.cacheCreate > 0)
      ? Math.round(d.day30.cacheRead / d.day30.cacheCreate * 10) / 10 : null, 'ratio (x)', per);
    add('Today',                     wp.todayTotal,           'tokens', 'calendar day');
    add('Avg per active day (all stored days)', Math.round(d.avgDaily || 0), 'tokens', 'baseline for Today, follows Claude data retention');
    add('Current 5h window',         wp.window5h,             'tokens', 'anchored window');
    add('Week so far',               ws.soFar,                'tokens', 'current billing week');
    add('Week forecast',             ws.forecast,             'tokens', 'current billing week');
    add('Week share of est. limit',  ws.pct,                  '%',      'current billing week');
    add('Estimated 5h limit',        wp.sessionEst ? wp.sessionEst.median : null, 'tokens', 'median of observed hits');
    add('5h limit range low',        wp.sessionEst ? wp.sessionEst.min : null,    'tokens', 'lowest observed hit');
    add('5h limit range high',       wp.sessionEst ? wp.sessionEst.max : null,    'tokens', 'highest observed hit');
    add('5h limit usual band low',   wp.sessionEst ? wp.sessionEst.bandLow : null,  'tokens', '25th percentile of observed hits');
    add('5h limit usual band high',  wp.sessionEst ? wp.sessionEst.bandHigh : null, 'tokens', '75th percentile of observed hits');
    add('5h limit hits observed', wp.totalSession ?? (wp.sessionEst ? wp.sessionEst.n : 0), 'hits', 'within retention window');
    add('Weekly limit hits observed', wp.weeklyHits,          'hits',   'within retention window');
    add('Estimated weekly limit',    wp.weeklyLimitEst,       'tokens', wp.weeklySource === 'feed' ? 'from official percentage (status line feed)' : 'empirical estimate');
    add('5h limit in use',           wp.h5Limit || null,      'tokens', wp.h5Source === 'feed' ? 'from official percentage (status line feed)' : 'median of observed hits');
    add('Weekly limit from hits',    wp.weeklyLimitHits,      'tokens', 'lowest week that hit the cap');
    add('Counting',                  'input + output',        '',       'plugin figures; officially cache writes appear to count as well');
    add('Exported at',               new Date().toISOString(), 'ISO 8601', '');
    return rows;
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

  // ── Activity heatmap, week strip (Today page) ────────────────
  // Seven cells, one per day, last 7 days ending today. Lives above the three gauges and spans
  // the same width, so the Today page reads as one block (Björn, 01.10.2026).
  //
  // Seven days rather than thirty because of Björn's rule for this page: everything on Today is
  // either from today or from the last 7 days — anything longer belongs in the Dashboard. The
  // 30-day grid still exists, it just moved to Analytics, which is the page about longer spans.
  //
  // Same five bands and the same avgDaily baseline as the month grid, so the two never
  // contradict each other for the days they share.
  _renderWeekHeatmap(parent, d, entries) {
    const loc  = localeFor(_lang);
    const now  = Date.now();
    // The user's own billing week, not the last 7 calendar days (Björn, 02.10.2026). His cycle
    // runs Sunday 18:00 to Sunday 17:59; other users have different ones, and the plugin already
    // knows each user's cycle from the weekly-reset calibration.
    //
    // Each row is a 24-hour SLICE of that week, not a "billing day" — Anthropic bills no day at
    // all, only the rolling 5h window and this weekly cap (Björn corrected the wording 02.10.).
    // The slices start at the reset hour purely so that seven of them tile the week exactly;
    // slicing at midnight would leave a part-row at each end and spread a single week across
    // eight rows.
    const wkStart = billingWeekStart(now);
    // End of the window computed by calendar arithmetic, not +7×86400000 — the week containing a
    // DST change is 23 or 25 hours longer, and adding fixed milliseconds would put the boundary
    // an hour off exactly when the countdown matters. Germany switches on 25.10.2026.
    const wkEndD = new Date(wkStart); wkEndD.setDate(wkEndD.getDate() + 7);
    const wkEnd  = wkEndD.getTime();
    // Same 5h limit as the ring above it (feed first since 09.10.2026), so cell colours and ring agree.
    const wpH = d.weekPulse || {};
    // Pace uses the usual 5h limit, not the open window's effective one (can be tiny after a cache re-write).
    const sessBase = wpH.h5Typical || wpH.h5Limit || (wpH.sessionEst && wpH.sessionEst.median) || 0;

    const hhmm = (ms) => new Date(ms).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    const dow  = (ms) => new Date(ms).toLocaleDateString(loc, { weekday: 'short' });
    // `content` is the collapsible part — everything below has to go inside it.
    const content = this._heatmapHeader(parent,
      t('heatmapCycle', `${dow(wkStart)} ${hhmm(wkStart)} → ${dow(wkEnd)} ${hhmm(wkEnd)}`));

    // Grid on the left, legend as a column on the right — the mockup's layout (Björn, 02.10.).
    const body = content.createEl('div', { cls: 'au-dheat-body' });
    const grid = body.createEl('div', { cls: 'au-tl' });

    // EIGHT rows, not seven (Björn, 02.10.2026). A week that runs Sunday 18:00 to Sunday 17:59
    // touches eight calendar days: Sunday evening, six whole days, and Sunday morning again.
    // Rows are therefore real calendar days, and the first and last are deliberately part-rows —
    // that is what makes the cycle boundary visible instead of hiding it inside 24-hour slices
    // that each straddle two dates. It also removes the naming problem those slices had: a row
    // called "Thu" now simply means Thursday.
    const SLOT_MS = 2 * 3_600_000;
    const day0 = new Date(wkStart); day0.setHours(0, 0, 0, 0);
    const dayAt = (r) => { const x = new Date(day0); x.setDate(day0.getDate() + r); return x; };

    // Bucket by local calendar day and 2h slot. Day index via rounded date difference so a DST
    // shift inside the week cannot push a day into its neighbour's row.
    const slots = new Map(); // (dayIndex * 12 + slotIndex) -> tokens
    for (const e of (entries || [])) {
      if (e.timestamp < wkStart || e.timestamp >= wkEnd) continue;
      const dt = new Date(e.timestamp);
      const ds = new Date(dt); ds.setHours(0, 0, 0, 0);
      const r  = Math.round((ds.getTime() - day0.getTime()) / 86_400_000);
      if (r < 0 || r > 7) continue;
      const key = r * 12 + Math.floor(dt.getHours() / 2);
      slots.set(key, (slots.get(key) || 0) + billedEntry(e));
    }

    const todayMid = dayStart(new Date());
    for (let r = 0; r < 8; r++) {
      const ds  = dayAt(r);
      const row = grid.createEl('div', { cls: 'au-tl-row' });
      const lbl = row.createEl('span', {
        cls:  'au-tl-dow' + (ds.getTime() === todayMid ? ' is-today' : ''),
        text: dow(ds.getTime()),
      });
      lbl.title = ds.toLocaleDateString(loc, { weekday: 'long', day: '2-digit', month: '2-digit' });

      const cells = row.createEl('div', { cls: 'au-tl-cells' });
      for (let c = 0; c < 12; c++) {
        const from = new Date(ds); from.setHours(c * 2, 0, 0, 0);
        const ft   = from.getTime();
        const cell = cells.createEl('span', { cls: 'au-tl-cell' });

        // Three different kinds of nothing, kept apart on purpose: outside the billing window,
        // still in the future, and genuinely no activity. Only the last one is a statement about
        // how the week went.
        if (ft < wkStart || ft >= wkEnd) { cell.addClass('is-outside'); continue; }
        if (ft > now) { cell.addClass('is-void'); continue; }

        const tok = slots.get(r * 12 + c) || 0;
        cell.addClass('au-dheat-' + slotHeatBand(tok, sessBase));
        // Shading within the band (mockup). The band carries the meaning and is what the legend
        // explains; the shade only says where inside the band the value sits, and it always runs
        // the same way — more tokens, more solid. No extra claim, just resolution.
        const sh = slotShade(tok, sessBase);
        if (sh < 1) cell.style.opacity = sh.toFixed(2);
        cell.title = `${hhmm(ft)}–${hhmm(ft + SLOT_MS)} · `
          + (tok > 0 ? fmtTokens(tok) : t('heatLegendEmpty'));
      }
    }

    // No hour ruler (Björn, 02.10.2026). Four numbers under twelve columns were more clutter
    // than orientation in a sidebar this narrow — the exact hour of a cell is in its tooltip,
    // and the shape of a day is readable without axis labels.

    // Active Days sits in the freed right-hand column, where the legend used to be
    // (Björn, 02.10.2026). The legend moved to a single line underneath, which buys the grid
    // and this panel the width they both needed.
    this._renderActiveDays(body, d);
    this._heatmapLegend(content, 'au-dheat-legend-row');
    content.createEl('div', { cls: 'au-section-sub', text: t('timelineSub') });
  }

  // Active days in the current billing week (Björn, 02.10.2026 — from his mockup).
  //
  // Counted in the SAME seven 24-hour slices the weekly gauge uses, not in calendar days. The
  // heatmap beside it is drawn in calendar days because that is how people read a clock, but
  // "how many days did I work this week" is a question about the billing window, and answering
  // it in a different unit than the weekly ring would invite comparing two figures that do not
  // share a denominator. Each dot names its exact span in the tooltip.
  //
  // Three dot states, same discipline as the heatmap cells: worked, elapsed-but-idle, and not
  // yet reached. The last one is not an idle day, it has simply not happened.
  _renderActiveDays(parent, d) {
    const ws   = (d.weekStatus && d.weekStatus.days) ? d.weekStatus.days : [];
    if (ws.length === 0) return;
    const loc  = localeFor(_lang);
    const wkStart = billingWeekStart(Date.now());
    const active  = ws.filter(x => x.tokens > 0).length;

    const box = parent.createEl('div', { cls: 'au-active' });
    const hdr = box.createEl('div', { cls: 'au-active-hdr' });
    const ico = hdr.createEl('div', { cls: 'au-active-ico' });
    obsidian.setIcon(ico, 'flame');
    hdr.createEl('span', { cls: 'au-active-title', text: t('activeDaysTitle') });

    const val = box.createEl('div', { cls: 'au-active-val' });
    val.createSpan({ cls: 'au-active-num', text: String(active) });
    val.createSpan({ cls: 'au-active-of',  text: ` / ${ws.length}` });

    const dots = box.createEl('div', { cls: 'au-active-dots' });
    const hhmm = (ms) => new Date(ms).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    const dow  = (ms) => new Date(ms).toLocaleDateString(loc, { weekday: 'short' });
    ws.forEach((day, i) => {
      const from = wkStart + i * 86_400_000;
      const state = day.tokens > 0 ? 'on' : (day.status === 'future' ? 'future' : 'off');
      const dot = dots.createEl('span', { cls: `au-active-dot is-${state}` });
      dot.title = `${dow(from)} ${hhmm(from)} → ${dow(from + 86_400_000)} ${hhmm(from)}`
        + ' · ' + (day.tokens > 0 ? fmtTokens(day.tokens) : t('heatLegendEmpty'));
    });

    box.createEl('div', { cls: 'au-active-sub', text: t('activeDaysSub') });
  }

  // Header for the heatmap — icon tile, title, caller-supplied subtitle, and collapsible
  // (Björn, 02.10.2026). It uses the same `this._collapsed` set as _makeSection(), so the state
  // survives every data refresh and the heatmap does not spring back open each time the sidebar
  // redraws. Its own markup rather than _makeSection() because that one has no room for the
  // icon tile and the two-line heading.
  //
  // Returns the CONTENT container, not the section: everything the caller appends has to land
  // inside the part that gets hidden, otherwise a collapsed heatmap would leave its grid behind.
  _heatmapHeader(parent, subText) {
    const KEY = 'heatmap';
    const isCollapsed = this._collapsed.has(KEY);
    const sec = parent.createEl('div', { cls: 'au-section au-dheat' });
    const hdr = sec.createEl('div', { cls: 'au-dheat-hdr' });
    const chev = hdr.createEl('span', { cls: 'au-chevron', text: isCollapsed ? '▶' : '▼' });
    const ico = hdr.createEl('div', { cls: 'au-dheat-ico' });
    obsidian.setIcon(ico, 'calendar-days');
    const txt = hdr.createEl('div', { cls: 'au-dheat-hdr-txt' });
    txt.createEl('div', { cls: 'au-section-title', text: t('heatmapTitle') });
    txt.createEl('div', { cls: 'au-section-sub',   text: subText });

    const content = sec.createEl('div', { cls: 'au-dheat-content' });
    if (isCollapsed) content.style.display = 'none';
    hdr.addEventListener('click', () => {
      if (this._collapsed.has(KEY)) {
        this._collapsed.delete(KEY);
        chev.textContent = '▼';
        content.style.display = '';
      } else {
        this._collapsed.add(KEY);
        chev.textContent = '▶';
        content.style.display = 'none';
      }
    });
    return content;
  }

  // Shared five-band legend. Both heatmaps use the same bands, so they must not drift apart.
  _heatmapLegend(parent, cls) {
    const legend = parent.createEl('div', { cls: `au-dheat-legend ${cls || ''}` });
    const legendDefs = [
      { band: 'empty',    label: t('heatLegendEmpty')  },
      { band: 'low',      label: t('heatLegendLow')    },
      { band: 'medium',   label: t('heatLegendMedium') },
      { band: 'high',     label: t('heatLegendHigh')   },
      { band: 'veryhigh', label: t('heatLegendVhigh')  },
    ];
    for (const { band, label } of legendDefs) {
      const item = legend.createEl('span', { cls: 'au-dheat-legend-item' });
      item.createEl('span', { cls: `au-dheat-swatch au-dheat-${band}` });
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
    body.createEl('div', { cls: 'au-section-sub', text: t('anchoredWindow') });
    const maxVal = Math.max(window5h.agg.input, window5h.agg.output, window5h.agg.cacheCreate, window5h.agg.cacheRead, 1);
    this._statRow(body, t('rowInput'),  window5h.agg.input,       maxVal, 'blue');
    this._statRow(body, t('rowOutput'), window5h.agg.output,      maxVal, 'green');
    this._statRow(body, t('rowCWrite'), window5h.agg.cacheCreate, maxVal, 'purple', cacheWriteTip(window5h.agg));
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
    this._statRow(body, t('rowCWrite'), stats.cacheCreate, maxVal, 'purple', cacheWriteTip(stats));
    this._statRow(body, t('rowCRead'),  stats.cacheRead,   maxVal, 'amber');
  }

  _statRow(parent, label, value, max, color, tip) {
    const row = parent.createEl('div', { cls: 'au-stat-row' });
    if (tip) row.title = tip;
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
    this._statRowNextGen(body, t('rowCWrite'), stats.cacheCreate, maxVal, 'purple', verdictFor(sv.cacheCreate), baselineDays, cacheWriteTip(stats));
    this._statRowNextGen(body, t('rowCRead'),  stats.cacheRead,   maxVal, 'amber',  verdictFor(sv.cacheRead),   baselineDays);
  }

  // Deliberate copy of _statRow(), not the same function with a branch — keeps Classic's
  // _statRow() truly unmodified. Same label/value/log-scale-bar structure (no row restructure,
  // no extra height), plus an optional compact verdict glyph after the bar.
  _statRowNextGen(parent, label, value, max, color, verdict, baselineDays, tip) {
    const row = parent.createEl('div', { cls: 'au-stat-row au-stat-row-ng' });
    if (tip) row.title = tip;
    // Colour chip in front of the label (v2.0, from Björn's mockup). It carries the token
    // type's own colour, so the row says which type it is before the label is even read —
    // and it ties the row to the bar further right, which uses the same colour.
    row.createEl('span', { cls: `au-stat-chip au-bar-${color}` });
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
    const total = stats.billed || billedOf(stats);
    const avgPerActiveDay = activeDays > 0 ? Math.round(total / activeDays) : 0;
    const grid = body.createEl('div', { cls: 'au-tile-grid' });
    const totalSeries = (series || []).map(x => x.billed || 0);
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
          modelTok[f] = (modelTok[f] || 0) + billedEntry(e);
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
        total:       billedOf(fm),
        billed:      billedOf(fm),
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
        byM[f]      += billedEntry(e);
        input       += e.usage.input_tokens  || 0;
        output      += e.usage.output_tokens || 0;
        cacheCreate += e.usage.cache_creation_input_tokens || 0;
        cacheRead   += e.usage.cache_read_input_tokens     || 0;
        reqs++;
        const rootLabel = vaultLabel(e.root);
        const projLabel = vaultLabel(e.cwd);
        const tok = billedEntry(e);
        if (!byRoot[rootLabel]) byRoot[rootLabel] = { total: 0, projects: {} };
        byRoot[rootLabel].total += tok;
        byRoot[rootLabel].projects[projLabel] = (byRoot[rootLabel].projects[projLabel] || 0) + tok;
      }
      out.push({
        ts: from,
        label: new Date(from).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
        ...byM, total: Object.values(byM).reduce((a, b) => a + b, 0),
        billed: billedOf({ input, output, cacheCreate, cacheRead }),
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
      const t = billedEntry(e);
      const i = BKTS.findIndex(b => t < b.max);
      if (i >= 0) hist[i].count++;
    }

    const sessMap = {};
    for (const e of entries) {
      const sid = e.sessionId || 'unknown';
      if (!sessMap[sid]) sessMap[sid] = { id: sid.slice(0, 8), first: e.timestamp, tokens: 0, reqs: 0, models: {} };
      const s = sessMap[sid];
      s.tokens += billedEntry(e);
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
    const totalTok    = billedOf(d.day30);
    const totalReqs   = d.day30.count;
    const activeDays  = days30.filter(x => x.reqs > 0).length;
    // Tokens per day actually worked, not per calendar day — a vacation gap in the report
    // period must not silently drag this average down. Requested explicitly (Björn, 24.08.2026).
    const avgPerActiveDay = activeDays > 0 ? Math.round(totalTok / activeDays) : 0;

    // ── Rate Limit Analysis ─────────────────────────────────────────
    const entries30sorted = d.entries30.slice().sort((a, b) => a.timestamp - b.timestamp);
    // Same computeLimitState() as the sidebar (09.10.2026): feed first, hit estimates as fallback.
    const limits = computeLimitState(d.rateLimitEvents, entries30sorted, now, avgPerActiveDay,
      readRateLimitFeed(now.getTime() - (d.retentionDays || 30) * 86_400_000));
    const rlEst = limits.rlEst;
    const rlEvents = rlEst.rlEvents;
    const weeklyLimitEst = limits.weeklyLimit;

    const rateLimitPayload = {
      events:       rlEvents.slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 30),
      weeks:        rlEst.weekBuckets,
      sessionEst:   rlEst.sessionEst,
      weeklyEst:    weeklyLimitEst,
      weeklySource: limits.weeklySource,
      weeklyEstHits: rlEst.weeklyLimitEst,
      h5Limit:      limits.h5Limit,
      h5Typical:    limits.h5Typical,
      h5Source:     limits.h5Source,
      weeklyHits:   rlEst.weeklyHits,
      totalSession: rlEst.totalSession,
      totalWeekly:  rlEst.totalWeekly,
    };

    // ── Week Status (Phase 1) ─────────────────────────────────────
    const weekStatus = limits.weekStatus;

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
      // Raw (unformatted) current-window totals for the Limit Hero banner — deliberately separate
      // from reportPayload's pre-formatted strings, since the hero needs real numbers to compute
      // percentages against the empirical limit estimates above.
      currentWindow5h: d.window5h.total || 0,
      todayTotal: billedOf(d.today),
      // 29-day average per active day. Since 2.0 this is what "Today" is measured against —
      // there is no daily limit to compare with, so the honest reference is the user's own
      // normal. Same figure the sidebar heatmap and verdict glyphs already use.
      avgDaily: d.avgDaily || 0,
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
/* baseline + cap-height sizing, same rule as the sidebar logo — see LOGO_SVG. */
.logo-header{display:flex;align-items:center;gap:10px}
header h1{font-size:17px;font-weight:700;letter-spacing:-0.02em;color:#f1f5f9}
/* "Usage" in the brand yellow, mirroring the logo lockup (v2.0) — the gradient-filled title
   was dropped with the old blue palette; the monogram beside it carries the colour now. */
header h1 .wm-accent{color:#FAB219}
.meta{font-size:11px;color:#64748b;margin-top:4px}
.hdr-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tabs{display:flex;gap:4px;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:2px}
.tab-btn{background:none;border:none;color:#94a3b8;font-size:11px;font-weight:600;padding:5px 12px;border-radius:4px;cursor:pointer;font-family:inherit}
.tab-btn.active{background:#334155;color:#f1f5f9}
select#periodSel{background:#1e293b;border:1px solid #334155;color:#e2e8f0;font-size:11px;font-weight:600;padding:5px 8px;border-radius:6px;font-family:inherit;cursor:pointer}
.limit-hero{margin-bottom:20px}
/* AI Budget Status (v2.0 visual rework, from Bjoerns mockup). The shell carries a soft
   coloured glow in the current zone hue. It is the one deliberately showy element on the
   page: it answers "am I fine right now", which is why people open this dashboard. */
.hero-shell{border-radius:14px;padding:18px 20px 20px;border:1px solid #334155;background:radial-gradient(130% 150% at 50% 0%,#17233a 0%,#111c2e 55%,#0f172a 100%)}
.hero-shell-good{border-color:#0CA30C55;box-shadow:0 0 0 1px #0CA30C22,0 10px 36px -14px #0CA30C66}
.hero-shell-warn{border-color:#FAB21955;box-shadow:0 0 0 1px #FAB21922,0 10px 36px -14px #FAB21966}
.hero-shell-bad{border-color:#D03B3B55;box-shadow:0 0 0 1px #D03B3B22,0 10px 36px -14px #D03B3B66}
.hero-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}
.hero-title{font-size:17px;font-weight:700;color:#f1f5f9;letter-spacing:-.01em}
.hero-title-note{font-size:11px;font-weight:500;color:#64748b;margin-top:2px}
.hero-zone{display:flex;align-items:center;gap:9px;border:1px solid;border-radius:10px;padding:8px 13px}
.hero-zone-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.hero-zone-txt{font-size:11.5px;font-weight:700;letter-spacing:.04em}
.hero-zone-sub{font-size:10.5px;color:#94a3b8;margin-top:1px}
.hero-row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.hero-panel{background:#16233a;border:1px solid #2b3a52;border-radius:12px;padding:15px 16px 14px}
.hero-label{font-size:13px;font-weight:700;color:#f1f5f9}
.hero-caption{font-size:10.5px;color:#64748b;margin:1px 0 12px}
.hero-main{display:flex;align-items:center;gap:16px}
.ring{flex-shrink:0}
.hero-figures{min-width:0;flex:1}
.hero-num{font-size:21px;font-weight:800;color:#f1f5f9;font-variant-numeric:tabular-nums;line-height:1.1}
.hero-num-unit{font-size:11px;font-weight:600;color:#94a3b8}
.hero-target{font-size:11px;color:#64748b;margin-top:1px}
.hero-bar{height:6px;background:#0b1220;border-radius:3px;overflow:hidden;margin:9px 0}
.hero-bar-fill{height:100%;border-radius:3px;transition:width .4s ease}
.hero-pill{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;border:1px solid;border-radius:20px;padding:3px 10px}
.hero-dot{width:7px;height:7px;border-radius:50%}
.hero-sub{font-size:10.5px;color:#94a3b8;margin-top:11px;line-height:1.45;padding-top:10px;border-top:1px solid #2b3a52}
.hero-unavailable{font-size:11px;color:#64748b;line-height:1.5;padding:10px 0 4px}
@media(max-width:1000px){.hero-row{grid-template-columns:1fr}}
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
/* Each day is a bucket the fill rises inside: height = magnitude, colour = verdict (v2.0). */
.week-day{position:relative;flex:1;height:46px;border-radius:5px;overflow:hidden;background:#16233a;border:1px solid #2b3a52}
.week-fill{position:absolute;left:0;right:0;bottom:0;transition:height .4s ease}
.week-txt{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:9px;color:#f8fafc;text-shadow:0 1px 3px rgba(0,0,0,.75)}
.week-day.future{background:#131f33;border:1px dashed #2b3a52}
.week-day.future .week-txt{color:#475569;text-shadow:none}
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
/* CSV export menu (v2.0) — sits in the header next to the tabs. Sized and coloured like the
   period select beside it so the header reads as one row of controls. */
.csv-menu{position:relative;display:inline-block}
.csv-trigger{background:#1e293b;border:1px solid #334155;color:#cbd5e1;border-radius:6px;
  font-size:12px;font-weight:600;padding:6px 12px;cursor:pointer;white-space:nowrap;
  transition:color .15s,border-color .15s,background .15s}
.csv-trigger:hover{color:#199E70;border-color:#199E70}
.csv-menu.open .csv-trigger{color:#199E70;border-color:#199E70}
.csv-caret{font-size:9px;opacity:.7;margin-left:2px}
.csv-dropdown{display:none;position:absolute;top:calc(100% + 4px);right:0;z-index:50;
  min-width:190px;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:4px;
  box-shadow:0 8px 24px rgba(0,0,0,.45)}
.csv-menu.open .csv-dropdown{display:block}
.csv-dropdown button{display:block;width:100%;text-align:left;background:none;border:0;
  color:#cbd5e1;font-size:12px;padding:7px 10px;border-radius:5px;cursor:pointer}
.csv-dropdown button:hover{background:#334155;color:#f1f5f9}
.csv-sep{height:1px;background:#334155;margin:4px 6px}
/* Names the destination inside the menu (02.10.2026). The Dashboard is a browser page, so it
   can only hand the file to the browser; it cannot choose a folder. Saying so where the click
   happens beats letting the user go looking afterwards. */
.csv-hint{font-size:10.5px;color:#94a3b8;padding:5px 10px 6px;line-height:1.35}
.csv-hint-alt{color:#64748b;max-width:210px}
.csv-dropdown{min-width:230px}
/* Projects Overview — sub-project detail (v1.8) */
.proj-toggle{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#cbd5e1;margin-bottom:6px;cursor:pointer;user-select:none}
.proj-toggle input{cursor:pointer}
.proj-detail-note{font-size:11px;color:#64748b;line-height:1.5;margin:2px 0 12px}
.proj-vault-row.has-sub td:first-child{cursor:pointer}
.proj-caret{display:inline-block;width:13px;color:#3987E5;font-size:11px}
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
        <!-- Sized just under the h1's cap height, same rule as LOGO_SVG. -->
        <svg width="39" height="23.9" viewBox="0.4 2.6 23.3 14.3" fill="none" aria-hidden="true" style="display:block">
          <defs>
            <linearGradient id="tuUDash" x1="14.3" y1="3" x2="22.3" y2="16" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#FAB219"/>
              <stop offset="1" stop-color="#D03B3B"/>
            </linearGradient>
          </defs>
          <path d="M1.8 4 H10.8 M6.3 4 V15.5" stroke="#0CA30C" stroke-width="2.8" stroke-linecap="round"/>
          <path d="M14.3 4 V11.5 A4 4 0 0 0 22.3 11.5 V4" stroke="url(#tuUDash)" stroke-width="2.8" stroke-linecap="round"/>
        </svg>
        <h1>Token <span class="wm-accent">Usage</span> Dashboard</h1>
      </div>
      <div class="meta">Snapshot generated ${generated} &nbsp;·&nbsp; Plugin v${version} &nbsp;·&nbsp; <a href="https://www.langeatn.de/media/token-usage/" target="_blank" rel="noopener" style="color:#C9A227;text-decoration:none;">Help &amp; Glossary ↗</a></div>
    </div>
    <div class="hdr-right">
      <div class="tabs">
        <button class="tab-btn active" id="tabBtnDash" onclick="showTab('dash')">Dashboard</button>
        <button class="tab-btn" id="tabBtnReports" onclick="showTab('reports')">Reports</button>
        <button class="tab-btn" id="tabBtnProjects" onclick="showTab('projects')">Projects</button>
      </div>
      <div class="csv-menu" id="csvMenu">
        <button class="csv-trigger" id="csvTrigger" title="Export data as CSV">CSV Export <span class="csv-caret">▾</span></button>
        <div class="csv-dropdown" id="csvDropdown">
          <div class="csv-hint">Downloads to your browser folder</div>
          <button data-csv="projects">Projects Overview</button>
          <button data-csv="daily">Daily Detail</button>
          <button data-csv="kpis">Key figures</button>
          <div class="csv-sep"></div>
          <button data-csv="all">All three files</button>
          <div class="csv-sep"></div>
          <div class="csv-hint csv-hint-alt">For files inside your vault instead, use the CSV button in the Obsidian sidebar.</div>
        </div>
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
    <div class="limit-hero" id="limitHero"></div>
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
      <div id="rlEst" style="margin-bottom:14px;padding:10px 14px;background:rgba(255,255,255,0.03);border-radius:6px;border-left:3px solid #199E70;font-size:12px;line-height:1.7;color:#cbd5e1"></div>
      <table><thead><tr><th>Date</th><th>Time</th><th>Type</th><th>Tokens (inp+out)</th><th>Resets at</th></tr></thead>
      <tbody id="tRL"></tbody></table>
    </div>
    <div class="cb">
      <h2>Weekly consumption — billing week <span id="weekWindowNote" class="live-note"></span></h2>
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
// Must stay identical to MODEL_COLORS in the plugin above — the sidebar and the dashboard keep
// separate copies (the dashboard is a standalone HTML file), so a change in one without the
// other would show the same model in two different colours.
var C={Haiku:'#0D9488',Sonnet:'#4A90E2',Opus:'#EC4899',Fable:'#A855F7',Other:'#6B7280'};
var VERDICT_HEX={good:'#0CA30C',warn:'#FAB219',bad:'#D03B3B',neutral:'#6B7280'};
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

// Big donut ring for the budget panels (v2.0, from Björn's mockup). Same maths as gaugeSvg,
// scaled up and with the percentage set as the panel's headline figure rather than a caption.
// Over 100% the ring stays full and turns critical — it must not wrap around and read as a
// fresh, low value.
function ringSvg(pct, color, size){
  var s = size || 112;
  var stroke = Math.round(s * 0.085);
  var r = (s - stroke) / 2 - 2;
  var c = 2 * Math.PI * r;
  var dash = (Math.max(0, Math.min(100, pct)) / 100) * c;
  var mid = s / 2;
  var id = 'rg' + Math.round(pct) + Math.round(s) + color.replace('#','');
  return '<svg class="ring" width="'+s+'" height="'+s+'" viewBox="0 0 '+s+' '+s+'">'
    + '<defs><filter id="'+id+'" x="-50%" y="-50%" width="200%" height="200%">'
    + '<feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/>'
    + '<feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'
    + '<circle cx="'+mid+'" cy="'+mid+'" r="'+r+'" fill="none" stroke="#1e293b" stroke-width="'+stroke+'"/>'
    + '<circle cx="'+mid+'" cy="'+mid+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="'+stroke+'"'
    + ' stroke-dasharray="'+dash.toFixed(1)+' '+c.toFixed(1)+'" stroke-linecap="round"'
    + ' transform="rotate(-90 '+mid+' '+mid+')" filter="url(#'+id+')"/>'
    + '<text x="'+mid+'" y="'+(mid + s*0.09)+'" text-anchor="middle" font-size="'+(s*0.23)+'"'
    + ' font-weight="700" fill="#f1f5f9">'+Math.round(pct)+'<tspan font-size="'+(s*0.13)+'">%</tspan></text>'
    + '</svg>';
}
function focusMiniRow(label,val,color){
  return '<div class="focus-mini-row"><span class="focus-mini-lbl">'+label+'</span><div class="focus-mini-track"><div class="focus-mini-fill" style="width:'+val+'%;background:'+color+'"></div></div></div>';
}
// intensityColorJs() removed in v2.0. Its last caller was the billing-week bar, which coloured
// days by their share of the week's BIGGEST day — a relative scale wearing status colours, so
// the busiest day always came out red regardless of whether it was a problem. That bar now
// judges each day against the user own average instead, and nothing else needed a continuous
// ramp, so the function went with it.

// Limit Hero (v1.9) — the three empirical numbers Anthropic never publishes, given the
// prominent top-of-dashboard treatment they were previously missing (session estimate used to
// be buried in the Rate Limits table further down; weekly only had one KPI card among five).
// Deliberately shows CURRENT status, not a forecast — renderKpiRow()'s "Limit Health" card
// already covers the forecast angle, this covers "where do I actually stand right now".
// Budget panel (v2.0 visual rework, from Björn's mockup): a large ring carrying the percentage,
// the raw figure and its target beside it, a progress bar underneath and a state pill. Same
// numbers as before — only the presentation changed, nothing new is computed or estimated.
var ZONE_LABEL = { good: 'Safe', warn: 'Close', bad: 'Over' };

function heroPanel(label, caption, current, target, sub, unavailableText, bands){
  if (target == null || target <= 0) {
    return '<div class="hero-panel"><div class="hero-label">'+label+'</div>'
      +'<div class="hero-caption">'+caption+'</div>'
      +'<div class="hero-unavailable">'+unavailableText+'</div></div>';
  }
  var pct = (current/target)*100;
  // Two band sets, because two different questions (see renderLimitHero). Against a LIMIT,
  // 100% is the ceiling. Against your own AVERAGE, 100% is an ordinary day — judging that by
  // limit bands would mark every normal day as critical.
  // Since 09.10.2026 (Björn) the average panel is neutral grey: no limit, only a change in how
  // you work, so it gets no traffic-light colour and its pill names the multiple instead.
  var b = bands || 'limit';
  var verdict = (b === 'average')
    ? 'neutral'
    : (pct<=80 ?'good':(pct<=100?'warn':'bad'));
  var color = VERDICT_HEX[verdict];
  var pillText = (b === 'average') ? ((pct/100).toFixed(1)+'x your usual day') : ZONE_LABEL[verdict];
  var barW = Math.max(0, Math.min(100, pct));
  return '<div class="hero-panel hero-'+verdict+'">'
    +'<div class="hero-label">'+label+'</div>'
    +'<div class="hero-caption">'+caption+'</div>'
    +'<div class="hero-main">'
      + ringSvg(pct, color, 112)
      +'<div class="hero-figures">'
        +'<div class="hero-num">'+fN(current)+' <span class="hero-num-unit">used</span></div>'
        +'<div class="hero-target">/ '+fN(Math.round(target))+'</div>'
        +'<div class="hero-bar"><div class="hero-bar-fill" style="width:'+barW+'%;background:'+color+'"></div></div>'
        +'<span class="hero-pill" style="color:'+color+';border-color:'+color+'44;background:'+color+'1a">'
          +'<span class="hero-dot" style="background:'+color+'"></span>'+pillText
        +'</span>'
      +'</div>'
    +'</div>'
    +'<div class="hero-sub">'+sub+'</div>'
    +'</div>';
}
function renderLimitHero(){
  var RL=D.rateLimit, ws=D.weekStatus;
  var se = RL && RL.sessionEst;
  // Since 09.10.2026 the limit comes from the status line feed where it has one (h5Source feed),
  // otherwise from the median of observed hits, exactly as before.
  var h5Feed = RL && RL.h5Source === 'feed';
  var h5L = (RL && RL.h5Limit) || (se ? se.median : null);
  var sessionHtml = heroPanel(
    // "Window", not "Session" (04.10.2026). The sidebar was corrected to the same wording:
    // calling it a session invites the reading we abolished on 02.10. — that this is simply
    // "the last five hours". It is an anchored window with a real start time.
    'Current 5h Window', h5Feed ? 'vs. 5h limit from the official percentage' : 'vs. observed 5h limit',
    D.currentWindow5h,
    h5L,
    h5Feed ? ('usual limit ~'+fN(RL.h5Typical || h5L)+' &nbsp;·&nbsp; this window anchored on the official percentage in your status line feed')
      : (se ? ('median ~'+fN(se.median)+' &nbsp;·&nbsp; '+(se.bandLow&&se.bandHigh ? 'usually '+fN(se.bandLow)+'–'+fN(se.bandHigh)+' (middle half)' : 'range '+fN(se.min)+'–'+fN(se.max))+' from '+se.n+' observed hits') : ''),
    'Not enough observed 5h-limit hits yet (need &gt; 50K tokens in a 5h window when one is hit).'
  );
  // There is NO daily limit (corrected 01.10.2026). Anthropic enforces an anchored 5-hour window
  // and a weekly cap, nothing in between — so the former "fair daily share" (weeklyLimitEst / 7)
  // was a number we made up. Today is now measured against the user's own 29-day average per
  // active day: it claims no quota, it reports whether today is busier or quieter than usual.
  // Calendar day, matching the sidebar (fixed 02.10.2026). This panel used to take the current
  // 24-hour slice of the billing week, which ran reset-hour to reset-hour. That was correct while
  // Today was measured against a daily share of the weekly limit — the share and the slice had to
  // use the same span. The share turned out to be invented and is gone, so the panel compares
  // against the user's own daily average now, and the honest span is the one the word promises.
  // Leaving it on the slice also meant the Dashboard and the sidebar printed different numbers
  // under the same label.
  var dailyBase  = D.avgDaily || null;
  var dailyHtml = heroPanel(
    'Today', 'vs. your usual day &nbsp;·&nbsp; calendar day, since midnight',
    D.todayTotal || 0,
    dailyBase,
    dailyBase ? ('your average per active day over all stored days (follows your Claude data retention) — not a limit, Anthropic has none for days') : '',
    'Not enough history yet to know what a usual day looks like for you.',
    'average'
  );
  var weeklyHtml = heroPanel(
    'This Week', 'vs. est. weekly limit',
    ws.soFar,
    ws.weeklyLimitEst,
    ws.weeklyLimitEst ? (ws.remainingDays+' day'+(ws.remainingDays!==1?'s':'')+' left in this billing week'
      +(RL && RL.weeklySource === 'feed' ? ' &nbsp;·&nbsp; limit ~'+fN(ws.weeklyLimitEst)+' from the official percentage' : '')) : '',
    'No weekly-limit hit observed yet in the last 30 days.'
  );

  // Overall zone = worst of the REAL limits only: the 5-hour window and the weekly cap. The
  // Today panel is deliberately excluded (01.10.2026) — it measures against the user's own
  // average, not a limit, so a merely busy day must not turn the banner amber. The banner
  // answers "how close am I to a limit", and a day cannot be close to a limit that has
  // never existed.
  var worst = 'good';
  [[D.currentWindow5h, h5L], [ws.soFar, ws.weeklyLimitEst]]
    .forEach(function(p){
      if (!p[1]) return;
      var q = (p[0]/p[1])*100;
      var v = q<=80?'good':(q<=100?'warn':'bad');
      if (v==='bad' || (v==='warn' && worst==='good')) worst = v;
    });
  var zoneText = { good:'GREEN ZONE', warn:'AMBER ZONE', bad:'RED ZONE' }[worst];
  var zoneSub  = { good:"You're well within your limits.",
                   warn:'Approaching one of your limits.',
                   bad:'At or past an estimated limit.' }[worst];
  var zoneCol  = VERDICT_HEX[worst];

  document.getElementById('limitHero').innerHTML =
      '<div class="hero-shell hero-shell-'+worst+'">'
    +   '<div class="hero-head">'
    +     '<div>'
    +       '<div class="hero-title">AI Budget Status</div>'
    +       '<div class="hero-title-note">Live usage against your limits — empirical, not published by Anthropic</div>'
    +     '</div>'
    +     '<div class="hero-zone" style="border-color:'+zoneCol+'55;background:'+zoneCol+'14">'
    +       '<span class="hero-zone-dot" style="background:'+zoneCol+'"></span>'
    +       '<div><div class="hero-zone-txt" style="color:'+zoneCol+'">'+zoneText+'</div>'
    +       '<div class="hero-zone-sub">'+zoneSub+'</div></div>'
    +     '</div>'
    +   '</div>'
    +   '<div class="hero-row">' + sessionHtml + dailyHtml + weeklyHtml + '</div>'
    + '</div>';
}

function renderKpiRow(){
  var ws=D.weekStatus, fs=D.focusScore;
  var pastTokens=ws.days.filter(function(d){return d.status!=='future';}).map(function(d){return d.tokens;});
  var wfSpark=sparklineSvg(pastTokens.length>1?pastTokens:[0,0],'#3987E5');
  var wfCard='<div class="kpi-card" style="border-left-color:#3987E5"><div><div class="kpi-label">Weekly Forecast</div>'
    +'<div class="kpi-val">'+fN(ws.forecast)+'</div><div class="kpi-sub">so far '+fN(ws.soFar)+'</div></div>'+wfSpark+'</div>';

  var lhColor=VERDICT_HEX[ws.verdict]||VERDICT_HEX.neutral;
  var lhBody = ws.weeklyLimitEst
    ? ('<div class="kpi-val" style="font-size:15px">'+ws.pct+'%</div><div class="kpi-sub">'+(ws.daysUntilExhausted!==null?('~'+ws.daysUntilExhausted.toFixed(1)+'d budget left'):'of est. limit')+'</div>')
    : '<div class="kpi-sub" style="line-height:1.4;max-width:90px">Est. limit not yet available</div>';
  var lhGauge = ws.weeklyLimitEst ? gaugeSvg(ws.pct||0,lhColor) : '';
  var lhCard='<div class="kpi-card" style="border-left-color:'+lhColor+'"><div><div class="kpi-label">Limit Health</div>'+lhBody+'</div>'+lhGauge+'</div>';

  var ceCard='<div class="kpi-card" id="kpiCache" style="border-left-color:#0CA30C"></div>';
  var dvCard='<div class="kpi-card" id="kpiVelocity" style="border-left-color:#9085E9"></div>';

  var fsColor=fs.color;
  var fsCard='<div class="kpi-card" style="border-left-color:'+fsColor+'"><div style="width:100%"><div class="kpi-label">Focus Score</div>'
    +'<div class="kpi-val">'+fs.score+'<span style="font-size:11px;color:#64748b">/100</span></div>'
    +'<span class="kpi-badge" style="background:'+fsColor+'22;color:'+fsColor+'">'+fs.badge+'</span>'
    +'<div class="focus-mini">'
    +focusMiniRow('Cache',fs.components.cache,'#199E70')
    +focusMiniRow('Cont.',fs.components.continuity,'#3987E5')
    +focusMiniRow('Depth',fs.components.depth,'#9085E9')
    +'</div></div></div>';

  document.getElementById('kpiRow').innerHTML = wfCard+lhCard+ceCard+dvCard+fsCard;
}

// The weekly reset is a fixed moment in UTC (Sunday 16:00), so its LOCAL clock time shifts with
// daylight saving: 18:00 in summer, 17:00 in winter. Every label used to say "18:00" outright,
// which would quietly go an hour wrong at the end of October. Derived from the actual instant
// instead, so it is right in both halves of the year and in any timezone.
function resetClockLocal(){
  var d = new Date();
  d.setUTCHours(16, 0, 0, 0);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderWeekBar(){
  var ws=D.weekStatus;
  var resetAt = resetClockLocal();
  var noteEl = document.getElementById('weekWindowNote');
  if (noteEl) noteEl.textContent = '(Sun ' + resetAt + ' → Sun ' + resetAt + ', your local time)';
  // Billing-week buckets run 18:00→18:00 (Sunday 18:00 reset), not local midnight. Each bucket
  // is therefore named after the day it ENDS on, not the one it starts on — that is the day it
  // mostly consists of: the Wed 18:00→Thu 18:00 bucket holds 18 of Thursday's hours against
  // only 6 of Wednesday's, so it is the Thursday column.
  //
  // Fixed 01.10.2026 (Björn: "Heute ist Donnerstag und Thursday ist farblos"). Naming buckets
  // by their start day shifted the whole week back by one, so on a Thursday morning the live
  // bucket sat in the Wednesday slot and the Thursday column stood empty — the current day
  // appeared to have no data at all. The totals were always right; only the labels were off.
  var lbls=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  // Day colour = that day against the USER OWN AVERAGE, not against the week's biggest day
  // (fixed v2.0, spotted by Björn 01.10.2026). The old version divided by the week's maximum,
  // so the busiest day was always red even at 18% of the weekly limit — a red bar sitting
  // directly under a green "well within your limits" banner. Status colours have to mean a
  // verdict, and the only honest verdict here is "how did this day compare to what a day may
  // fairly use". With no weekly estimate there is nothing to judge against, so the bars stay
  // neutral rather than inventing a scale.
  // Two channels, two questions — the fix to the fix (Björn, 01.10.2026: "warum ist jetzt alles
  // grün?"). Colouring purely by verdict made every day green at 18% of the weekly limit, which
  // is correct but says nothing about WHICH day was heavy. Colouring by relative height, as the
  // original did, made the busiest day red even when it was harmless. So:
  //   FILL HEIGHT = how much (relative to the week's biggest day) — magnitude
  //   COLOUR      = how does it rate against your own usual day — verdict
  // Neither channel has to lie about the other, and the bar answers both questions at once.
  // Colour = each day against the user's OWN average, not against a daily quota — there is no
  // daily quota (corrected 01.10.2026). Bands are the average bands (1.5x busier, 2x spike),
  // not the limit bands, because an ordinary day sits at roughly 100% here.
  var dailyBase = D.avgDaily || null;
  var maxTok = Math.max.apply(null, ws.days.map(function(d){ return d.tokens; }).concat([1]));
  var html=ws.days.map(function(d,i){
    var cls='week-day'+(d.status==='future'?' future':'')+(d.status==='current'?' current':'');
    var col;
    if (!d.tokens)       col = '#2b3a52';
    else if (!dailyBase) col = '#475569';   // no history yet — neutral, not a guess
    else {
      var q = (d.tokens / dailyBase) * 100;
      col = VERDICT_HEX[q <= 150 ? 'good' : (q <= 200 ? 'warn' : 'bad')];
    }
    // Floor of 6% so a day with little but non-zero usage still shows a sliver rather than
    // reading as "nothing happened".
    var fillPct = d.status === 'future' ? 0
                : (d.tokens ? Math.max(6, (d.tokens / maxTok) * 100) : 0);
    var lbl = d.status==='current' ? 'Today' : lbls[i];
    var share = (dailyBase && d.tokens) ? Math.round((d.tokens/dailyBase)*100) + '% of your usual day' : '';
    return '<div class="'+cls+'" title="'+(share||'no activity')+'">'
      + '<div class="week-fill" style="height:'+fillPct.toFixed(1)+'%;background:'+col+'"></div>'
      + '<div class="week-txt"><span>'+lbl+'</span>'
      + (d.status!=='future' ? ('<span>'+fN(d.tokens)+'</span>') : '') + '</div>'
      + '</div>';
  }).join('');
  document.getElementById('weekBar').innerHTML=html;
  var vEl=document.getElementById('weekVerdict');
  var vText = ws.verdict==='good'?'On track':ws.verdict==='warn'?'Approaching limit':ws.verdict==='bad'?'Likely to exceed':'No estimate yet';
  vEl.textContent=vText;
  vEl.style.background=VERDICT_HEX[ws.verdict]+'22';
  vEl.style.color=VERDICT_HEX[ws.verdict];
  var foot = ws.weeklyLimitEst
    ? ('Forecast '+fN(ws.forecast)+' of an estimated '+fN(ws.weeklyLimitEst)+' tokens by Sunday '+resetAt+' &nbsp;·&nbsp; '+ws.remainingDays+' day'+(ws.remainingDays!==1?'s':'')+' left in this billing week. Each bar is a 24-hour slice of that week, running '+resetAt+' to '+resetAt+' so the seven of them tile the week exactly. Anthropic measures no day at all.')
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

  // Status role (v2.0) — cache efficiency is a verdict, so it uses the status palette, not
  // token-type colours (the old scale ran green, Input blue, amber, Opus purple, mixing both
  // roles). Same four steps as the focus score, so the two verdicts never disagree on what a
  // colour means. The middle steps are a scale, not an alarm — the badge text beside them
  // ("Balanced", "Exploratory") carries the actual wording.
  var ceColor = cache.ratio>=8?'#0CA30C':cache.ratio>=3?'#FAB219':cache.ratio>=1?'#EC835A':'#6B7280';
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

  // Snapshot for the KPI CSV export (v2.0) — stored here rather than recomputed in the export
  // itself, so the file can never disagree with the cards currently on screen. Every value is
  // raw; formatting stays a display concern.
  lastKpis = {
    periodDays: n,
    totalTokens: totalTok,
    apiCalls: totalReqs,
    activeDays: activeDays,
    avgPerActiveDay: avgPerActiveDay,
    cacheRatio: cache.ratio,
    cacheLabel: ceLabel,
    cacheCreate: cache.create,
    cacheRead: cache.read,
  };

  var spark14v = slice.slice(-14).map(function(d){ return (d.input||0)+(d.output||0); });
  document.getElementById('kpiVelocity').innerHTML =
      '<div><div class="kpi-label">Daily Velocity ('+n+' days)</div><div class="kpi-val">'+fN(avgPerActiveDay)+'</div>'
    + '<div class="kpi-sub">tokens / active day</div></div>'
    + sparklineSvg(spark14v,'#9085E9');

  var models=['Haiku','Sonnet','Opus','Fable','Other'];
  var used=models.filter(function(m){return slice.some(function(d){return d[m]>0;});});
  var dailyData={labels:slice.map(function(d){return d.label;}),datasets:used.map(function(m){return{label:m,data:slice.map(function(d){return d[m]||0;}),backgroundColor:C[m],stack:'s'};})};
  if(cDailyChart){ cDailyChart.data=dailyData; cDailyChart.update(); }
  else { cDailyChart=new Chart(document.getElementById('cDaily'),{type:'bar',data:dailyData,options:{responsive:true,scales:{x:{stacked:true,grid:{color:'rgba(255,255,255,0.05)'}},y:{stacked:true,grid:{color:'rgba(255,255,255,0.05)'},ticks:{callback:function(v){return fN(v);}}}},plugins:{legend:{position:'top',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){return' '+ctx.dataset.label+': '+fN(ctx.raw);}}}}}}); }

  document.getElementById('ccCreate').textContent=fN(cache.create);
  document.getElementById('ccRead').textContent=fN(cache.read);
  document.getElementById('ccRatio').textContent=cache.ratio+'x';
  var rc=document.getElementById('ccRatioCard'); var r=cache.ratio;
  // Same status steps as ceColor above — deliberately identical thresholds and hexes, so the
  // card border and the KPI tile can never show a different verdict for the same ratio.
  rc.style.borderColor = r>=8?'#0CA30C':r>=3?'#FAB219':r>=1?'#EC835A':r>0?'#6B7280':'#334155';
  var h='',t='';
  if(!cache.create&&!cache.read){h='No cache data.';t='No cache tokens recorded in the last '+n+' days.';}
  else if(r>=8){h='Deep focus mode.';t='You work intensely with the same context. Docs, artifacts or long chats are reused heavily — the model reads from cache instead of reprocessing. Efficient and cost-effective.';}
  else if(r>=3){h='Balanced usage.';t='Focused phases alternate with fresh tasks. You bring new context regularly but also reuse existing material across multiple requests.';}
  else if(r>=1){h='Exploratory mode.';t='You bring new context frequently — many different projects, short sessions, or frequent topic switches. Cache is created but rarely reused intensively.';}
  else{h='Minimal cache reuse.';t='Almost every request brings fresh context. Highly exploratory or many independent short sessions without repeating the same source material.';}
  var hint='Cache Write costs 1.25× the input price for a 5-minute cache and 2× for a 1-hour cache (the usual kind for Claude Code on a subscription) — you pay a premium to store the context. Cache Read costs 0.1× (0.05× on Opus 5.5 and Sonnet 5.5) — far cheaper to reuse than reprocess. The Reuse Factor (Read ÷ Write) shows whether your investment in caching is paying off.';
  document.getElementById('ccExplain').innerHTML='<strong>'+h+'</strong> '+t+'<div class="hint">'+hint+'</div>';

  var cacheChartData={labels:slice.map(function(d){return d.label;}),datasets:[{label:'Cache Write',data:slice.map(function(d){return d.cacheCreate||0;}),borderColor:'#199E70',backgroundColor:'rgba(25,158,112,0.08)',tension:0.35,fill:true,pointRadius:2,pointHoverRadius:4},{label:'Cache Read',data:slice.map(function(d){return d.cacheRead||0;}),borderColor:'#9085E9',backgroundColor:'rgba(144,133,233,0.08)',tension:0.35,fill:true,pointRadius:2,pointHoverRadius:4}]};
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
  new Chart(document.getElementById('cDist'),{type:'bar',data:{labels:D.hist.map(function(h){return h.label;}),datasets:[{data:D.hist.map(function(h){return h.count;}),backgroundColor:'#3987E5',borderRadius:3}]},options:{responsive:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return' '+ctx.raw+' requests';}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'}},y:{beginAtZero:true,grid:{color:'rgba(255,255,255,0.05)'}}}}});
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
    estHtml += '<strong>5h limit estimate: ~' + fN(se.min) + ' – ' + fN(se.max) + ' tokens / 5h</strong>'
      + ' &nbsp;·&nbsp; median ' + fN(se.median) + ' &nbsp;·&nbsp; ' + se.n + ' observed hits (last 30 days)';
  } else {
    estHtml += '<strong>5h limit estimate:</strong> not enough data yet (need observed hits with > 50 K tokens in 5h window)';
  }
  if (RL.weeklyEst) {
    estHtml += '<br><strong>Weekly limit estimate: ≥ ' + fN(RL.weeklyEst) + ' tokens / week</strong>'
      + ' (conservative lower bound from ' + RL.weeklyHits + ' weekly-limit event' + (RL.weeklyHits !== 1 ? 's' : '') + ')';
  }
  estHtml += '<br><span style="color:#64748b;font-size:11px">'
    + RL.totalSession + ' 5h-limit hit' + (RL.totalSession !== 1 ? 's' : '')
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
    var col  = ev.type === 'weekly' ? '#D03B3B' : '#FAB219';
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
          backgroundColor: RL.weeks.map(function(w) { return w.hitWeekly ? '#D03B3B' : '#3987E5'; }),
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

// ── CSV export (v2.0) ───────────────────────────────────────────
// Runs entirely in the browser. The dashboard is a static file with no channel back into
// Obsidian (see _generateDashboard()), but every number it draws is already embedded in D —
// so each CSV is built in memory from the very same arrays the tables render from and handed
// to the browser as a download. No write access, no network, no dependency.
// One file per table rather than a single zip (Björn, 30.09.2026): zipping in the browser
// would have meant bundling a library, i.e. the plugin's first real dependency and a new
// check at every community review. A button per table also matches what you are looking at.
// Values are written raw, NOT through fN() — a CSV is for calculating with, so 1560000 goes
// in, not "1.56 M". Dates go in as ISO so they sort correctly in every tool.
function csvCell(v){
  if (v === null || v === undefined) return '';
  var s = String(v);
  // RFC 4180: quote if the value holds a delimiter, quote or line break; escape quotes by doubling.
  return /[",\\n\\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvFrom(rows){
  return rows.map(function(r){ return r.map(csvCell).join(','); }).join('\\r\\n');
}
function csvIso(ts){
  var d = new Date(ts);
  function p(x){ return (x < 10 ? '0' : '') + x; }
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
}
function downloadCsv(name, rows){
  // BOM first, so Excel reads it as UTF-8 — vault and sub-folder names routinely carry umlauts
  // and accents, which turn into mojibake without it. Built via fromCharCode rather than an
  // escape so it survives the template-string layer this dashboard code lives in.
  var blob = new Blob([String.fromCharCode(0xFEFF) + csvFrom(rows)], { type: 'text/csv;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 0);
}
function csvName(part){ return 'token-usage-' + part + '-' + csvIso(Date.now()) + '.csv'; }

// Header CSV menu (Björn, 30.09.2026) — replaced three small per-table buttons, which sat next
// to the numbers and were easy to miss entirely. One visible entry point next to the tabs
// instead, offering each report individually plus all three at once.
function wireCsvMenu(){
  var menu = document.getElementById('csvMenu');
  var trig = document.getElementById('csvTrigger');
  if (!menu || !trig) return;
  var actions = { projects: exportProjectsCsv, daily: exportDailyCsv, kpis: exportKpisCsv, all: exportAllCsv };
  trig.onclick = function(e){ e.stopPropagation(); menu.classList.toggle('open'); };
  Array.prototype.forEach.call(menu.querySelectorAll('[data-csv]'), function(b){
    b.onclick = function(e){
      e.stopPropagation();
      menu.classList.remove('open');
      var fn = actions[b.getAttribute('data-csv')];
      if (fn) fn();
    };
  });
  // Click anywhere else closes it — the usual dropdown contract.
  document.addEventListener('click', function(){ menu.classList.remove('open'); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') menu.classList.remove('open'); });
}

// Filled by applyPeriod() on every period change, read by exportKpisCsv().
var lastKpis = null;

// Dashboard key figures: a flat Metric/Value/Unit list rather than a rebuilt card layout —
// a CSV of nine headline numbers is something you paste into a tracking sheet, so one metric
// per row beats trying to mirror the visual grid. Week and limit figures come straight from D
// (they do not depend on the period dropdown); the rest comes from the lastKpis snapshot.
function exportKpisCsv(){
  var k = lastKpis || {};
  var ws = D.weekStatus || {};
  var fs = D.focusScore || {};
  var rl = D.rateLimit || {};
  var rows = [['Metric','Value','Unit','Scope']];
  function add(m, v, u, s){ rows.push([m, (v === null || v === undefined) ? '' : v, u || '', s || '']); }
  var per = k.periodDays ? k.periodDays + ' days' : '';
  add('Total tokens',            k.totalTokens,     'tokens',        per);
  add('API calls',               k.apiCalls,        'calls',         per);
  add('Active days',             k.activeDays,      'days',          per);
  add('Period length',           k.periodDays,      'days',          per);
  add('Avg tokens per active day', k.avgPerActiveDay, 'tokens',      per);
  add('Cache efficiency',        k.cacheRatio,      'ratio (x)',     per);
  add('Cache efficiency label',  k.cacheLabel,      '',              per);
  add('Cache write',             k.cacheCreate,     'tokens',        per);
  add('Cache read',              k.cacheRead,       'tokens',        per);
  add('Focus score',             fs.score,          'of 100',        per);
  add('Focus score label',       fs.badge,          '',              per);
  add('Week so far',             ws.soFar,          'tokens',        'current billing week');
  add('Week forecast',           ws.forecast,       'tokens',        'current billing week');
  add('Week share of est. limit', ws.pct,           '%',             'current billing week');
  // sessionEst is an OBJECT ({n, min, max, median}), unlike weeklyEst which is a plain number.
  // Exported raw it landed in the CSV as "[object Object]" (found 02.10.2026). The median is the
  // figure the gauges and the heatmap bands actually use, so that is what belongs here; min, max
  // and the hit count go in their own rows rather than being squeezed into one cell.
  add('Estimated 5h limit',      rl.sessionEst ? rl.sessionEst.median : null, 'tokens', 'median of observed hits');
  add('5h limit range low',      rl.sessionEst ? rl.sessionEst.min : null,  'tokens', 'lowest observed hit');
  add('5h limit range high',     rl.sessionEst ? rl.sessionEst.max : null,  'tokens', 'highest observed hit');
  add('5h limit usual band low',  rl.sessionEst ? rl.sessionEst.bandLow : null,  'tokens', '25th percentile of observed hits');
  add('5h limit usual band high', rl.sessionEst ? rl.sessionEst.bandHigh : null, 'tokens', '75th percentile of observed hits');
  add('Estimated weekly limit',  rl.weeklyEst,      'tokens',        rl.weeklySource === 'feed' ? 'from official percentage (status line feed)' : 'empirical estimate');
  add('5h limit in use',         rl.h5Limit || null, 'tokens',       rl.h5Source === 'feed' ? 'from official percentage (status line feed)' : 'median of observed hits');
  add('Weekly limit from hits',  rl.weeklyEstHits,  'tokens',        'lowest week that hit the cap');
  add('5h limit hits observed', rl.totalSession, 'hits',        'all recorded data');
  add('Weekly limit hits observed',  rl.totalWeekly,  'hits',        'all recorded data');
  add('Exported at',             new Date().toISOString(), 'ISO 8601', '');
  downloadCsv(csvName('key-figures'), rows);
}

// Projects: always the FULL data (D.projects), never the display-folded "Other" row, and
// always including sub-folders regardless of the detail checkbox — the checkbox controls
// readability on screen, it should not silently shrink an export. A Level column marks each
// row as vault or sub so the two never get confused once the file is open elsewhere.
function exportProjectsCsv(){
  var rows = [['Level','Vault / root','Sub-project','Tokens','% of parent','Active days','First active','Last active']];
  (D.projects || []).forEach(function(p){
    rows.push(['vault', p.label, '', p.tokens || 0, p.pct || 0, p.activeDays || 0, csvIso(p.firstTs), csvIso(p.lastTs)]);
    (p.projects || []).forEach(function(s){
      rows.push(['sub', p.label, s.label, s.tokens || 0, s.pct || 0, '', '', '']);
    });
  });
  downloadCsv(csvName('projects'), rows);
}

// Which vault columns exist in a given slice. Shared by the Daily Detail table and its CSV
// export so the two can never end up with a different set of columns.
function dailyLabelsFor(slice){
  var labels = [];
  slice.forEach(function(d){ Object.keys(d.byRoot||{}).forEach(function(l){ if(labels.indexOf(l)===-1) labels.push(l); }); });
  return labels.sort();
}

// Daily Detail: the day x vault matrix for the period currently selected in the dropdown, so
// the file always matches what the Projects tab shows. One column per vault, plus the row
// total. Re-derives its own slice from D.allDays rather than relying on renderProjects()
// having run — the export now lives in the header and must work on any tab.
function exportDailyCsv(){
  var n = parseInt(document.getElementById('periodSel').value, 10);
  var slice = D.allDays.slice(-n);
  var labels = dailyLabelsFor(slice);
  var rows = [['Date'].concat(labels).concat(['Total'])];
  slice.slice().sort(function(a, b){ return a.ts - b.ts; }).forEach(function(d){
    var cells = labels.map(function(l){ var r = (d.byRoot||{})[l]; return r ? r.total : 0; });
    rows.push([csvIso(d.ts)].concat(cells).concat([d.total || 0]));
  });
  downloadCsv(csvName('daily-' + n + 'd'), rows);
}

// "All three files" — browsers throttle or prompt on rapid multi-file downloads, so the three
// are staggered rather than fired in one burst. Chrome may still ask once whether this site
// may download multiple files; that is expected and only appears the first time.
function exportAllCsv(){
  exportProjectsCsv();
  setTimeout(exportDailyCsv, 350);
  setTimeout(exportKpisCsv, 700);
}

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
  var labels = dailyLabelsFor(slice);
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

renderLimitHero();
renderKpiRow();
renderWeekBar();
document.getElementById('periodSel').value=String(D.defaultPeriod);
applyPeriod(D.defaultPeriod);
renderReports();
wireCsvMenu();
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
      .addOption('es', 'Español')
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
  // ── Weekly reset calibration (v2.0) ───────────────────────────────────────────
  // A one-off setup step: run /usage in Claude Code, read your own weekly reset, enter it here.
  // Everything week-shaped in the plugin hangs off this moment — the billing-week bar, the
  // forecast, the "resets in" countdown and the weekly-limit estimate. Before 2.0 it was
  // hard-wired to one account's schedule, so for everyone else those numbers quietly described
  // somebody else's week.
  const calDone   = plugin.settings.weeklyResetSetAt != null;
  const calAuto   = plugin.settings.weeklyResetSource === 'auto';
  const dFmt      = { day: '2-digit', month: '2-digit', year: 'numeric' };
  const calSetting = new obsidian.Setting(containerEl)
    .setName(t('settingReset'))
    .setDesc(!calDone
      ? t('settingResetDesc')
      : calAuto
        ? t('settingResetAuto', new Date(plugin.settings.weeklyResetFrom || plugin.settings.weeklyResetSetAt).toLocaleDateString(localeFor(_lang), dFmt))
        : t('settingResetDone', new Date(plugin.settings.weeklyResetSetAt).toLocaleDateString(localeFor(_lang), dFmt)));

  // Visual state, not just wording: a calibrated setting gets a green check and a muted,
  // confirming description; an uncalibrated one gets an amber dot. The point is that a user
  // can tell at a glance whether this step is still outstanding, without reading the text.
  calSetting.nameEl.createSpan({
    cls: calDone ? 'au-cal-ok' : 'au-cal-todo',
    text: calDone ? ' ✓' : ' ●',
  });
  if (calDone) calSetting.descEl.addClass('au-cal-done-desc');

  const DAY_KEYS = ['calSun','calMon','calTue','calWed','calThu','calFri','calSat'];
  calSetting.addDropdown(dd => {
    DAY_KEYS.forEach((k, i) => dd.addOption(String(i), t(k)));
    dd.setValue(String(plugin.settings.weeklyResetDay ?? 0));
    dd.onChange(async v => {
      plugin.settings.weeklyResetDay   = parseInt(v, 10);
      plugin.settings.weeklyResetHour  = plugin.settings.weeklyResetHour ?? 18;
      plugin.settings.weeklyResetSetAt  = new Date().toISOString();
      // Manual beats auto from here on: a hand-set reset is a deliberate statement.
      plugin.settings.weeklyResetSource = 'manual';
      setBillingWeekReset(plugin.settings.weeklyResetDay, plugin.settings.weeklyResetHour);
      await plugin.saveSettings();
      // refresh() not render(): the reset moment changes which entries fall into the current
      // week, so the figures themselves have to be recomputed, not just redrawn.
      app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => {
        if (l.view instanceof AnthropicUsageView) l.view.refresh();
      });
      refreshUI();
    });
  });
  calSetting.addDropdown(dd => {
    for (let h = 0; h < 24; h++) dd.addOption(String(h), String(h).padStart(2, '0') + ':00');
    dd.setValue(String(plugin.settings.weeklyResetHour ?? 18));
    dd.onChange(async v => {
      plugin.settings.weeklyResetHour  = parseInt(v, 10);
      plugin.settings.weeklyResetDay   = plugin.settings.weeklyResetDay ?? 0;
      plugin.settings.weeklyResetSetAt  = new Date().toISOString();
      // Manual beats auto from here on: a hand-set reset is a deliberate statement.
      plugin.settings.weeklyResetSource = 'manual';
      setBillingWeekReset(plugin.settings.weeklyResetDay, plugin.settings.weeklyResetHour);
      await plugin.saveSettings();
      app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => {
        if (l.view instanceof AnthropicUsageView) l.view.refresh();
      });
      refreshUI();
    });
  });

  // Two settings removed in v2.0, both for the same reason — they had nothing left to control:
  //   "Sidebar appearance": Classic is gone, there is only one sidebar.
  //   "Activity calendar":  the calendar has its own rail page now. Hiding it meant hiding an
  //                         entire navigation entry, and not clicking the icon does the same
  //                         job without a switch (Björn, 01.10.2026).
  // Order (Björn, 02.10.2026): language, weekly reset, report period, archive, retention,
  // refresh interval — roughly most-decided-once to least-touched, with auto-refresh last
  // because it is the one nobody needs to change. Paths follow in their own block.
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
  new obsidian.Setting(containerEl)
    .setName(t('settingRefresh'))
    .setDesc(t('settingRefreshDesc'))
    .addText(txt => txt.setPlaceholder('30').setValue(String(plugin.settings.refreshSeconds))
      .onChange(async v => { const n = parseInt(v); if (!isNaN(n) && n >= 5) { plugin.settings.refreshSeconds = n; await plugin.saveSettings(); } }));

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
  new obsidian.Setting(containerEl)
    .setName(t('settingCsv'))
    .setDesc(t('settingCsvDesc'))
    .addText(txt => txt.setPlaceholder('Token Usage Exports').setValue(plugin.settings.csvPath || 'Token Usage Exports')
      .onChange(async v => { if (v.trim()) { plugin.settings.csvPath = v.trim(); await plugin.saveSettings(); } }))
    .addExtraButton(btn => btn.setIcon('folder-open').setTooltip(t('settingShowInFolder'))
      .onClick(() => revealInVault(app, plugin.settings.csvPath || 'Token Usage Exports')));

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
  '2.1.0': [
    'Your numbers will drop after this update, and here is why. Six things in this plugin were wrong, and two of them were claims we made ourselves in 2.0.0. All six are corrected. Details below and in the changelog',

    'Long responses were counted many times over. Claude Code writes one response to its log once per content block, up to about 75 times, and the plugin added every line. Each response is now counted once',

    'Subagent work was never counted. Claude Code logs subagents in a subfolder of the session, and the plugin never looked there. It does now',

    'We were wrong about cache in 2.0.0. Measured against the official percentages, cache writes clearly count toward the 5-hour window, cache reads a little. Our earlier analysis ran on the double-counted totals. The plugin still counts input and output only, so the official figure can run ahead, most of all after a pause in a long session',

    'The weekly estimate could sit far too low (on our data 1.14M against about 2.7M), and the "29-day average" behind Today was really every stored day. Labels and help now say what is actually computed. The Today ring is neutral grey: a busy day is no limit',

    'Cache prices were incomplete: a 1-hour cache write costs 2x the input price, not 1.25x, and it is the usual kind for Claude Code on a subscription (thanks to a hint in the Obsidian forum). Hover over a C.Write row to see the 1-hour and 5-minute split',

    'New, optional: a small status line script (extras/ratelimit-statusline.js) logs the official 5-hour and weekly percentages that Claude Code reports. With it, the plugin uses the official window start and shows the official percentage at every reading. Without it, nothing changes',
  ],
  '2.0.0': [
    'Your numbers may look different after this update, and that is the point. Three things about Anthropic limits turned out to be wrong in earlier versions, and all three are corrected: there is no daily limit (only a 5-hour window and a weekly cap), the 5-hour window is anchored rather than rolling, and cache tokens do not count toward either limit. Details below',

    'No more daily budget. Earlier versions compared Today against "a fair daily share" of the weekly limit — a number we had invented by dividing the weekly cap by seven. Anthropic has no such limit, so the comparison was measuring a real day against an imaginary budget. Today is now shown against your own 29-day average per active day: it claims no quota, it tells you whether today is busier or quieter than usual',

    'The 5-hour window is anchored, not rolling. It opens with your first message and runs exactly five hours; a new one only starts once that span has fully elapsed, chained in fixed blocks regardless of pauses in between. Previous versions summed "the last five hours from now", which at the moment a window turned over mixed the tail of the old window with the head of the new one — producing a figure that belonged to neither, exactly when you most wanted to see that your budget had reset',

    'Only input and output count toward a limit. Cache reads and writes are real volume and are still shown in full in their own rows, but they do not move you toward the 5-hour or weekly limit. This was measured against observed limit hits rather than assumed: weighting cache tokens by their price ratios — the obvious guess — produced a far noisier figure than plain input + output',

    'Weekly reset detects itself. The weekly limit resets at a weekday and hour that differs per account, and everything week-shaped depends on it. When you hit a weekly limit, Claude writes the next reset time into the message, and the plugin now reads it from there — Settings shows a green check and the date it came from. A manual setting always wins; automatic detection only confirms it, never overwrites it',

    'New look — the colour world has been rebuilt around a rule: one colour answers one question. Token types (input, output, cache write, cache read) say WHAT something is; green, amber and red say HOW IT STANDS, and never both at once. Every value was measured against the real surfaces for contrast and colour-blind separation, not picked by eye. New TU logo, four model colours, and the budget panels now use rings instead of bars',

    'The Classic sidebar has been removed — what you see now IS the plugin. If the sidebar looks different after this update, nothing is broken: the icon rail with Today, Calendar, Analytics and Settings is the one and only layout from here on. The "Sidebar appearance" setting is gone with it, because there is nothing left to switch between',

    'Activity heatmap, rebuilt around your billing week. One row per calendar day, one cell per two hours. It spans eight rows rather than seven, because a week running from reset to reset touches eight calendar dates — the first and last rows are partial on purpose, which is what makes the boundary of your cycle visible. Colour shows pace against your observed 5-hour limit, not raw volume. Beside it, Active days counts the days of this week with any activity',

    'Calendar shows two months instead of one. At the start of a month a single grid shows only a handful of usable days and hides exactly the run-up you are looking for. The arrows move the pair further back, as far as the archive reaches',
    'CSV export, two ways. The CSV button in the sidebar header writes the files into your vault, into a folder you choose under Settings — the menu names that folder before you click. The dashboard has the same three exports in its header menu, but those are browser downloads and land wherever your browser puts them; a web page cannot choose a folder. Projects Overview, Daily Detail matrix, key figures, or all three at once. Raw numbers and ISO dates, ready to calculate with. Everything is generated locally — no upload, no network, same as the rest of the plugin',
    'Spanish — the plugin UI and the full glossary are now available in Español alongside English, German, French and Italian. Switch under Settings → Language',
  ],
  '1.9.0': [
    'Dashboard: Limit Hero banner — the empirical session, daily-pacing, and weekly limit estimates now get a prominent banner at the very top of the dashboard, above the KPI cards',
    'Sidebar: Limit Pulse (NextGen) — the same Today/This Week limit percentages now sit at the very top of the Today page too, visible the moment you open the sidebar',
    'Activity calendar: bigger hover target — the tooltip now lives on the whole day cell, not just the small colored dot, so it is much easier to hit with the mouse',
    'Activity calendar: per-day notes — click any day to add a short personal note about that day\'s usage (e.g. "big refactor, expected spike"). Purely local, stored in plugin settings, shown as a small marker on the day and in its tooltip',
    'Cross-platform clarity — Token Usage already worked fully on macOS and Linux: the core session reading has always been platform-neutral (~/.claude/projects/ via os.homedir()), no code change needed there',
    'The one OS-specific piece — the Claude Desktop Agent Mode session finder added in v1.8.0 — turned out to be a Windows-only necessity, since only the Windows app runs its embedded Claude Code inside an MSIX sandbox that virtualises the filesystem. On macOS/Linux, Agent Mode sessions already land in the same standard location the plugin already reads, so no extra path guessing was needed there',
    'Removed unverified Windows-Store-style path guessing that had briefly crept into the macOS code path — replaced with a documented, evidence-based platform boundary instead',
    'Full documentation & manual updated with an explicit Data Sources section for macOS/Linux users at langeatn.de/media/token-usage/',
  ],
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

// Small free-text note per calendar day (v1.9). Purely local (settings.dailyComments), no
// connection to any other data path — a personal annotation layer over the activity calendar.
class DayCommentModal extends obsidian.Modal {
  constructor(app, dateTs, existingText, onSave) {
    super(app);
    this.dateTs = dateTs;
    this.existingText = existingText || '';
    this.onSave = onSave; // (newText: string) => void — called with '' to mean "delete"
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('au-day-note-modal');
    const dateLabel = new Date(this.dateTs).toLocaleDateString(localeFor(_lang),
      { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    contentEl.createEl('h2', { text: t('calNoteTitle', dateLabel) });
    const textarea = contentEl.createEl('textarea', { cls: 'au-day-note-textarea' });
    textarea.value = this.existingText;
    textarea.placeholder = t('calNotePlaceholder');
    textarea.rows = 5;
    // Focus after the modal's own open animation/layout settles, not synchronously.
    setTimeout(() => textarea.focus(), 0);

    const footer = contentEl.createDiv({ cls: 'au-day-note-footer' });
    if (this.existingText) {
      const delBtn = footer.createEl('button', { text: t('calNoteDelete'), cls: 'au-day-note-delete' });
      delBtn.addEventListener('click', () => { this.onSave(''); this.close(); });
    }
    const spacer = footer.createDiv({ cls: 'au-day-note-spacer' });
    const cancelBtn = footer.createEl('button', { text: t('calNoteCancel') });
    cancelBtn.addEventListener('click', () => this.close());
    const saveBtn = footer.createEl('button', { text: t('calNoteSave'), cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => { this.onSave(textarea.value.trim()); this.close(); });
  }
  onClose() { this.contentEl.empty(); }
}

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
    // CSV export from the plugin side, into the configurable vault folder (02.10.2026).
    // One command per file plus one for all three, mirroring the Dashboard's export menu.
    for (const [id, label, kind] of [
      ['export-csv-all',      'Export all CSV files',          'all'],
      ['export-csv-projects', 'Export projects CSV',           'projects'],
      ['export-csv-daily',    'Export daily detail CSV',       'daily'],
      ['export-csv-kpis',     'Export key figures CSV',        'kpis'],
    ]) {
      this.addCommand({
        id, name: label,
        callback: () => {
          const l = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
          if (l?.view instanceof AnthropicUsageView) l.view._exportCsv(kind);
          else new obsidian.Notice(t('csvNoData'));
        }
      });
    }
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
  // _applyReset must run in BOTH of these, not just on load: billingWeekStart() reads module
  // -level values, so without it a freshly calibrated reset would not take effect until the
  // next Obsidian restart — the user would change the setting and see nothing happen.
  _applyReset() {
    setBillingWeekReset(
      this.settings.weeklyResetDay  ?? 0,
      this.settings.weeklyResetHour ?? 18,
    );
  }
  async loadSettings(raw)  { this.settings = Object.assign({}, DEFAULT_SETTINGS, raw); _lang = this.settings.language || 'en'; this._applyReset(); }
  async saveSettings()  { await this.saveData(this.settings); _lang = this.settings.language || 'en'; this._applyReset(); }
}

module.exports = AnthropicUsagePlugin;
