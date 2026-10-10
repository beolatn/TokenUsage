// Token Usage status line (optional companion to the Token Usage plugin for Obsidian, 2.1.0+)
//
// What it does: Claude Code hands every status line script the OFFICIAL rate-limit percentages
// of your plan (5-hour window and week). This script shows them in your status line and appends
// one line per reading to ~/.claude/ratelimit-log.jsonl. When that file exists, the plugin anchors
// its limits on these official figures instead of estimating them from your own limit hits.
//
// Full guide (requirements, both options, checks, troubleshooting): extras/README.md in this repository.
// Needs Node.js (check with "node --version"). Claude Code installed with the native installer does
// not bring Node.js along. Working inside Obsidian or another client without a status line? Then
// this script gets few readings; see ratelimit-poll.js.
//
// Setup:
//   1. Copy this file to ~/.claude/ratelimit-statusline.js
//   2. Add this to ~/.claude/settings.json (merge it if the file already has other settings):
//        "statusLine": { "type": "command", "command": "node ~/.claude/ratelimit-statusline.js" }
//      If the ~ is not expanded on your system, use the full path instead, for example
//        "node C:/Users/<you>/.claude/ratelimit-statusline.js"
//   3. Restart Claude Code. The status line now reads "5h 12% | week 34%".
//
// Good to know:
//   - Only subscription plans (Pro, Max) report these percentages. With an API key there is
//     nothing to log, and the plugin keeps estimating as before.
//   - A reading is written only while a status line is shown, that is in the interactive Claude
//     Code terminal. Clients without a status line do not produce readings.
//   - Written only when a value changed or five minutes passed, so the file stays small.
//   - Nothing leaves your machine. The script never throws and never blocks Claude Code.
//   - Already using a status line of your own? Keep it, and add the logging part below to it.
//     The plugin only needs the JSON lines in exactly this format.
//
// MIT License, same as the plugin.

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG = path.join(os.homedir(), '.claude', 'ratelimit-log.jsonl');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  let out = '';
  try {
    const d = JSON.parse(raw);
    const rl = d.rate_limits || {};
    const f = rl.five_hour, w = rl.seven_day;
    const r1 = n => (typeof n === 'number' ? Math.round(n * 10) / 10 : null);
    const rec = {
      ts: Date.now(),
      session: d.session_id || null,
      model: (d.model && d.model.id) || null,
      h5: f ? { pct: r1(f.used_percentage), resets: f.resets_at } : null,
      wk: w ? { pct: r1(w.used_percentage), resets: w.resets_at } : null,
    };
    out = (f ? '5h ' + Math.round(f.used_percentage) + '%' : '5h ?')
        + ' | ' + (w ? 'week ' + Math.round(w.used_percentage) + '%' : 'week ?');
    if (f || w) {
      // Compare with the last line only: read the tail of the file, never the whole of it.
      let last = null;
      try {
        const st = fs.statSync(LOG);
        const fd = fs.openSync(LOG, 'r');
        const len = Math.min(st.size, 2048);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').trim().split('\n');
        last = JSON.parse(lines[lines.length - 1]);
      } catch (e) {}
      const same = last
        && JSON.stringify(last.h5) === JSON.stringify(rec.h5)
        && JSON.stringify(last.wk) === JSON.stringify(rec.wk);
      if (!same || !last || rec.ts - last.ts >= 5 * 60_000) {
        fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
      }
    }
  } catch (e) {
    out = 'rate limits: n/a';
  }
  process.stdout.write(out);
});
