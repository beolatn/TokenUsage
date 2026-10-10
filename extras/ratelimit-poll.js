// Token Usage rate-limit poll (optional companion to the Token Usage plugin for Obsidian, 2.1.0+)
//
// What it does: asks Claude Code once, headless, for your plan's OFFICIAL rate-limit percentages
// (5-hour window and week) and appends one line to ~/.claude/ratelimit-log.jsonl, the same file and
// format the status line script writes. Meant to be run on a schedule (Task Scheduler, cron, launchd)
// by people who work mostly where no status line runs, for example inside Obsidian or another client
// built on Claude Code. Full guide: extras/README.md in this repository.
//
// Read this before you schedule it:
//   - Every run is a real, tiny Claude request (Haiku, prompt "ok", no session saved). It counts
//     toward your usage like any other request, just very little of it.
//   - If no 5-hour window is open at that moment, this request OPENS one. Your next window then
//     starts at the poll time, not at your first real message. Schedule it for times you usually
//     work anyway, and not more than a few times a day.
//   - Needs Node.js and the Claude Code CLI, logged in with a subscription (Pro, Max). With an API
//     key there are no plan percentages to read.
//
// Run by hand first:  node ~/.claude/ratelimit-poll.js
// It prints "5h 12% | week 34%" on success. Errors go to ~/.claude/ratelimit-poll-errors.log.
// If the Claude Code CLI is not found, set CLAUDE_BIN to its full path.
//
// MIT License, same as the plugin.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const LOG = path.join(HOME, '.claude', 'ratelimit-log.jsonl');
const ERR = path.join(HOME, '.claude', 'ratelimit-poll-errors.log');
const WIN = process.platform === 'win32';

function fail(msg) {
  try { fs.appendFileSync(ERR, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {}
  console.error(msg);
  process.exit(1);
}

// Find the Claude Code CLI. Scheduled tasks often run with a minimal PATH, so besides PATH this
// also checks the usual install locations of the native installer and of npm.
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const isFile = p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'));
  if (!WIN) dirs.push('/usr/local/bin', '/opt/homebrew/bin');
  // Real executables first.
  for (const d of dirs) { const p = path.join(d, WIN ? 'claude.exe' : 'claude'); if (isFile(p)) return p; }
  if (WIN && process.env.APPDATA) {
    // An npm install puts the real claude.exe here and only a .cmd starter on the PATH.
    const npmExe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (isFile(npmExe)) return npmExe;
    dirs.push(path.join(process.env.APPDATA, 'npm'));
  }
  // Last resort on Windows: the .cmd starter.
  if (WIN) for (const d of dirs) { const p = path.join(d, 'claude.cmd'); if (isFile(p)) return p; }
  return null;
}

const bin = findClaude();
if (!bin) fail('Claude Code CLI not found. Install it or set CLAUDE_BIN to its full path.');

// Arguments without spaces on purpose, so the .cmd fallback on Windows can run as one shell line.
const args = ['-p', 'ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
const opts = { cwd: os.tmpdir(), encoding: 'utf8', timeout: 90_000, windowsHide: true };
const r = (WIN && /\.cmd$/i.test(bin))
  ? spawnSync('"' + bin + '" ' + args.join(' '), { ...opts, shell: true })
  : spawnSync(bin, args, opts);
if (r.error) fail('Could not run ' + bin + ': ' + r.error.message);

let info = null;
for (const line of (r.stdout || '').split('\n')) {
  if (!line.includes('rate_limit_event')) continue;
  try {
    const o = JSON.parse(line);
    if (o.type === 'rate_limit_event' && o.rate_limit_info) info = o.rate_limit_info;
  } catch (e) {}
}
if (!info) fail('No rate_limit_event in the output (exit code ' + r.status + '). Logged in with a subscription?');

const uw = info.unifiedWindows || {};
const conv = w => (w && typeof w.utilization === 'number')
  ? { pct: Math.round(w.utilization * 1000) / 10, resets: w.resetsAt } : null;
const rec = { ts: Date.now(), session: 'poll', source: 'poll', model: 'haiku', h5: conv(uw.five_hour), wk: conv(uw.seven_day) };
if (!rec.h5 && !rec.wk) fail('No percentages in the event: ' + JSON.stringify(info).slice(0, 300));

fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
console.log('5h ' + (rec.h5 ? rec.h5.pct + '%' : '?') + ' | week ' + (rec.wk ? rec.wk.pct + '%' : '?'));
