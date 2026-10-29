# Official rate-limit percentages for Token Usage (optional)

Token Usage works without anything in this folder. It reads Claude Code's session logs and counts your tokens. The two scripts here add something the logs do not contain: the **official percentages** of your plan, the same numbers Claude Code shows in `/usage`. Since 2.5 they are the only source of limit percentages in the plugin: without them the 5-hour and week rings stay grey and show counted tokens and the time to the reset.

*Updated for 2.5 (October 2026): up to 2.1 the plugin estimated limits from your own hits and used the feed to correct that estimate. Measured against the official values, the 5-hour estimate was off by 36 points on average, so the plugin no longer estimates. This guide describes the 2.5 behaviour.*

This guide explains what you gain, what you need, which of the two scripts fits the way you work, how to set it up on Windows, macOS and Linux, how to check that it works, and how to remove it again.

## Contents

- [What you gain](#what-you-gain)
- [Requirements](#requirements)
- [Which script do I need?](#which-script-do-i-need)
- [Option A: status line script](#option-a-status-line-script)
- [Option B: scheduled poll](#option-b-scheduled-poll)
- [Check that it works](#check-that-it-works)
- [How the plugin uses the readings](#how-the-plugin-uses-the-readings)
- [Known limits](#known-limits)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [Removing it again](#removing-it-again)
- [File format](#file-format)

## What you gain

| | Without a feed | With a feed |
|---|---|---|
| 5-hour window start | Reconstructed from your first logged message | The official start, also when the window was opened on claude.ai, another device or another tool |
| 5-hour ring | Grey: tokens in the window and time to the reset | The official percentage from a reading in the current window, with its time and the tokens counted since |
| Weekly ring | Grey: tokens this week and time to the reset | The official percentage, carried forward between readings with your counted tokens and labelled "projected" |
| Weekly reset | From your weekly-limit message, once you have hit the cap | From the feed, to the minute, also across daylight saving |

A real example from the author's own data, 27 October 2026: at 13:10 the plugin carried the week forward from an official 24% to about 28%; the next official reading six minutes later said 29%.

## Requirements

1. **A Claude subscription (Pro or Max)** that Claude Code is logged in with. With an API key Claude Code reports no plan percentages, and there is nothing to log.
2. **Node.js**, because both scripts are small Node programs. Check with `node --version` in a terminal. If the command is not found, install the LTS version from the Node.js website. Note: Claude Code itself no longer needs Node.js when it was installed with the native installer, so you may not have it yet.
3. **A recent Claude Code version.** The status line receives the percentages in a field called `rate_limits`; older versions do not send it.
4. For Option B only: **the Claude Code CLI** (`claude`) on this machine.

## Which script do I need?

| Where do you mostly work with Claude Code? | Use |
|---|---|
| In a terminal (`claude` in a shell) | **Option A**, the status line script |
| Inside Obsidian, an editor or another client built on Claude Code, where no status line is shown | **Option B**, the scheduled poll |
| Both | Both. They write to the same file, the plugin simply uses the newest reading |

Why the difference: a status line only runs while Claude Code's interactive terminal is open. Clients that embed Claude Code (for example through the Agent SDK) do not run it, so Option A alone would produce few or no readings there.

## Option A: status line script

The script [`ratelimit-statusline.js`](ratelimit-statusline.js) shows the percentages in your status line (`5h 12% | week 34%`) and writes a reading whenever a value changes, at most every five minutes otherwise. It costs nothing: Claude Code hands the numbers to the status line anyway.

**1. Copy the script** to your Claude folder:

- macOS / Linux: `~/.claude/ratelimit-statusline.js`
- Windows: `C:\Users\<you>\.claude\ratelimit-statusline.js`

**2. Register it** in `~/.claude/settings.json`. If the file already has content, add the `statusLine` entry next to the existing keys; do not replace the file.

macOS / Linux:

```json
"statusLine": { "type": "command", "command": "node ~/.claude/ratelimit-statusline.js" }
```

Windows (use forward slashes, `~` is not always expanded):

```json
"statusLine": { "type": "command", "command": "node C:/Users/<you>/.claude/ratelimit-statusline.js" }
```

**3. Restart Claude Code.** The status line at the bottom should read `5h 12% | week 34%` with your own numbers.

**Already using a status line of your own?** Keep it. Copy the logging part of our script (everything that builds `rec` and appends it to `ratelimit-log.jsonl`) into yours. The plugin only needs the JSON lines in exactly the format described [below](#file-format).

## Option B: scheduled poll

The script [`ratelimit-poll.js`](ratelimit-poll.js) asks Claude Code once, without opening a session, for the current percentages and writes one reading. You run it on a schedule.

**Read this before you set it up:**

- **Every run is a real request.** It sends the prompt `ok` to Haiku, the smallest model, and saves no session. It counts toward your usage like any request, just very little.
- **It can open a 5-hour window.** If no window is open at that moment, this request opens one, and your next window then starts at the poll time instead of at your first real message. Schedule it for times you usually work anyway.
- **Fixed times: not too often.** Three times a day is plenty for the week, which the plugin carries forward between readings. The 5-hour ring only shows a reading from the current window, so with three polls a day it is grey most of the time; that is the honest state, not an error.
- **Or only while you work (since 2.5, recommended for the 5-hour ring).** Started with `--only-when-active`, the script first checks whether Claude Code wrote to its session logs in the last 20 minutes (`--only-when-active=30` for 30 minutes) and otherwise exits without a request. While you work a 5-hour window is open anyway, so the poll practically never opens one of its own, and you can schedule it every 30 minutes. The 5-hour ring then shows an official value most of the time you work. Each run while active is one tiny request; idle runs cost nothing.
- **It tries once more after a timeout** (since 2.5). A run right after the computer wakes from sleep often has no network yet, so the script waits a minute and tries again, once.

**1. Copy the script** to `~/.claude/ratelimit-poll.js` (Windows: `C:\Users\<you>\.claude\ratelimit-poll.js`).

**2. Run it once by hand:**

```
node ~/.claude/ratelimit-poll.js
```

It prints `5h 12% | week 34%` on success. If it reports that the Claude Code CLI was not found, look up the full path (`where claude` on Windows, `which claude` on macOS and Linux) and set it in the environment variable `CLAUDE_BIN` for the scheduled run (see below).

**3. Schedule it.**

**Windows (Task Scheduler)**, in PowerShell, three runs a day at 12:00, 17:00 and 22:00, catching up after the computer was off:

```powershell
$node     = (Get-Command node).Source
$script   = "$env:USERPROFILE\.claude\ratelimit-poll.js"
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$script`""
$triggers = '12:00','17:00','22:00' | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName 'TokenUsageLimitPoll' -Action $action -Trigger $triggers -Settings $settings -Description 'Token Usage: official rate-limit percentages'
```

**Windows, only while you work** (every 30 minutes from 07:00 to midnight, asks only when Claude Code was active):

```powershell
$node    = (Get-Command node).Source
$script  = "$env:USERPROFILE\.claude\ratelimit-poll.js"
$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --only-when-active"
$trigger = New-ScheduledTaskTrigger -Daily -At '07:00'
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '07:00' -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 17)).Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName 'TokenUsageLimitPoll' -Action $action -Trigger $trigger -Settings $settings -Description 'Token Usage: official rate-limit percentages while you work'
```

**macOS and Linux (cron)**: open `crontab -e` and add one line. Cron runs with a minimal PATH, so use full paths (find them with `which node` and `which claude`). Fixed times:

```
0 12,17,22 * * * CLAUDE_BIN=/full/path/to/claude /full/path/to/node /Users/<you>/.claude/ratelimit-poll.js
```

Or only while you work, every 30 minutes:

```
*/30 7-23 * * * CLAUDE_BIN=/full/path/to/claude /full/path/to/node /Users/<you>/.claude/ratelimit-poll.js --only-when-active
```

On Linux the home folder is usually `/home/<you>`. On macOS you can use launchd instead of cron if you prefer; the command is the same.

**Errors** of scheduled runs are written to `~/.claude/ratelimit-poll-errors.log`.

## Check that it works

1. **The file exists and grows.** Show the last readings:
   - macOS / Linux: `tail -3 ~/.claude/ratelimit-log.jsonl`
   - Windows (PowerShell): `Get-Content $env:USERPROFILE\.claude\ratelimit-log.jsonl -Tail 3`
2. **The plugin uses it.** Refresh the sidebar. The week ring shows a percentage with "as of hh:mm" (or "projected" with the official value underneath), and the hint "Official percentages need the feed" under the rings is gone. The 5-hour ring shows a percentage right after a reading in the current window. In the dashboard the panels read "official percentage from Anthropic" or "projected from the last official value".
3. **Compare once with Claude Code.** Run `/usage` in Claude Code right after a reading. The plugin's rings should show the same percentages.

## How the plugin uses the readings

- **Window start:** every reading carries the moment the current 5-hour window resets. The window is the five hours before that, so the plugin knows the real start even if the window was opened somewhere it cannot see.
- **5-hour ring:** shows the latest reading only while its window is still open, with the time of the reading and the tokens counted since. Within a window the official value can only rise, so it is a lower bound. Nothing is carried forward: how fast a window fills depends mostly on how much context a session carries, which the logs cannot tell reliably. A reading from an earlier window is not shown.
- **Weekly ring:** shows the latest reading of the current week. Between readings it is carried forward with your counted tokens against the weekly limit the readings imply (tokens of the week up to a reading divided by its percentage, from readings of 10% upwards; below that the whole-number rounding is too coarse) and labelled "projected". After a weekly reset without a new reading it carries on from 0% with last week's limit, labelled "projected since reset".
- **Usage credits:** with usage credits you can keep working after the weekly limit. Readings at 100% or more, and anything after them in the same week, are not used for the weekly limit; a week at 100% shows the official value without carrying it forward.
- **Weekly reset:** taken from the reading as an exact moment, so it stays right across daylight saving.
- **Further windows:** if Anthropic reports more than the 5-hour window and the week (for example a separate weekly limit for one model), both scripts record it under `more` and the plugin shows it under the rings, as reported.
- **No feed for a while:** without a fitting reading the rings go grey again and show counted tokens and the time to the reset. Nothing is estimated in between.

## Known limits

- **The weekly projection counts input and output only.** Officially, cache writes also count (cache reads a little). Over a week this evens out well (1.2 points off on average in our measurement), but a large cache rebuild shows up fully only with the next reading.
- **Readings only exist when a script runs:** while a status line is shown (Option A) or at the scheduled times (Option B).
- **Whole percentages:** the official figures come rounded. One percent of a 5-hour window can be a few thousand tokens.

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| Status line is empty | Node.js not found | Check `node --version`. On Windows use the full path to `node.exe` in the `command` if needed |
| Status line shows `5h ? \| week ?` | No percentages delivered: API key instead of a subscription, or an older Claude Code version | Log in with your subscription, update Claude Code |
| Status line shows `rate limits: n/a` | Claude Code sent something the script could not read | Update Claude Code; if it persists, open an issue |
| Poll: "Claude Code CLI not found" | `claude` not on the PATH of the scheduled task | Set `CLAUDE_BIN` to the full path |
| Poll: "No rate_limit_event in the output" | Not logged in, or logged in with an API key | Run `claude` once by hand and log in with your subscription |
| 5-hour ring grey with "no reading in this window yet" | No reading since the current window opened | Normal between polls at fixed times. Run the poll once by hand, then refresh, or schedule it every 30 minutes with `--only-when-active` |
| Week ring grey with "no reading this week yet" | No reading since the weekly reset, and none last week either | Wait for the next reading or run the poll once by hand |

## Privacy

Everything stays on your machine. Each line in `ratelimit-log.jsonl` contains a timestamp, the percentages with their reset times, and, from the status line, the Claude Code session ID and model ID. The plugin only reads this file; it never sends it anywhere and never runs the scripts itself. The poll sends one request to Claude (the prompt `ok`), exactly like any other Claude Code request.

## Removing it again

- **Option A:** remove the `statusLine` entry from `~/.claude/settings.json` and delete the script.
- **Option B:** delete the task (Windows: `Unregister-ScheduledTask -TaskName 'TokenUsageLimitPoll'`) or the cron line, then delete the script.
- **Optional:** delete `~/.claude/ratelimit-log.jsonl`. Without it the rings for the 5-hour window and the week stay grey and show counted tokens and the time to the reset.

## File format

One JSON object per line in `~/.claude/ratelimit-log.jsonl`:

```json
{"ts":1791639419982,"session":"poll","source":"poll","model":"haiku","h5":{"pct":32,"resets":1791648600},"wk":{"pct":79,"resets":1791734400}}
```

| Field | Meaning |
|---|---|
| `ts` | Time of the reading, milliseconds since 1970 |
| `session` | Claude Code session ID (status line) or `poll` |
| `model` | Model of that session, or `haiku` for the poll |
| `h5.pct`, `wk.pct` | Official percentage used, 5-hour window and week |
| `h5.resets`, `wk.resets` | When that window resets, seconds since 1970 |
| `more` | Optional (since 2.5): further windows Anthropic reports, by their name, each with `pct` and `resets` |

If you write your own logger, this is all the plugin needs. Lines it cannot read are skipped.
