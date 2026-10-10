# Official rate-limit percentages for Token Usage (optional)

Token Usage works without anything in this folder. It reads Claude Code's session logs and estimates your 5-hour and weekly limits from the moments you actually hit them. The two scripts here add something the logs do not contain: the **official percentages** of your plan, the same numbers Claude Code shows in `/usage`. When they are available, the plugin anchors its rings on them.

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
| 5-hour ring | Your tokens against the median of your own limit hits | Exactly the official percentage at every reading, counting on with your tokens in between |
| Weekly ring | Your tokens against the lowest week that ever hit the cap (can be far too low) | Exactly the official percentage at every reading |
| Needs a limit hit first | Yes | No |

A real example from the author's own data: the sidebar showed the week at 141% while Claude Code said 61%. With the feed both show 61%.

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
- **Do not run it often.** Three times a day is plenty. The plugin counts on with your tokens between readings, so more readings add little.

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

**macOS and Linux (cron)**: open `crontab -e` and add one line. Cron runs with a minimal PATH, so use full paths (find them with `which node` and `which claude`):

```
0 12,17,22 * * * CLAUDE_BIN=/full/path/to/claude /full/path/to/node /Users/<you>/.claude/ratelimit-poll.js
```

On Linux the home folder is usually `/home/<you>`. On macOS you can use launchd instead of cron if you prefer; the command is the same.

**Errors** of scheduled runs are written to `~/.claude/ratelimit-poll-errors.log`.

## Check that it works

1. **The file exists and grows.** Show the last readings:
   - macOS / Linux: `tail -3 ~/.claude/ratelimit-log.jsonl`
   - Windows (PowerShell): `Get-Content $env:USERPROFILE\.claude\ratelimit-log.jsonl -Tail 3`
2. **The plugin uses it.** Refresh the sidebar. Under the three rings, the line about the 5-hour limit now ends with "derived from the official percentage in your status line feed". Hovering over the week ring says the same for the weekly limit. In the dashboard the 5-hour panel reads "vs. 5h limit from the official percentage".
3. **Compare once with Claude Code.** Run `/usage` in Claude Code right after a reading. The plugin's rings should show the same percentages.

## How the plugin uses the readings

- **Window start:** every reading carries the moment the current 5-hour window resets. The window is the five hours before that, so the plugin knows the real start even if the window was opened somewhere it cannot see.
- **5-hour ring:** the latest reading in the open window is the base. Between readings the plugin adds your new tokens at the rate your recent windows actually had (the median of your closed windows of the last 14 days). At the moment of a reading, the ring shows exactly the official figure.
- **Weekly ring:** the latest reading of the current week (from 10% upwards) defines your weekly limit in tokens. Readings below 10% are too coarse, because the percentages come as whole numbers.
- **No feed for a while:** older readings stay valid for their windows and weeks. When nothing fits, the plugin falls back to its own estimates from limit hits, as before.

## Known limits

- **Between two readings the plugin counts input and output only.** Officially, cache writes also count toward the 5-hour window (cache reads a little). A cache rebuild, for example a new chat or the first message after a long pause in a long session, therefore shows up with the next reading, not immediately.
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
| Plugin still shows the old texts under the rings | No reading yet in the current window or week | Wait for the next reading or run the poll once by hand, then refresh |

## Privacy

Everything stays on your machine. Each line in `ratelimit-log.jsonl` contains a timestamp, the two percentages with their reset times, and, from the status line, the Claude Code session ID and model ID. The plugin only reads this file; it never sends it anywhere and never runs the scripts itself. The poll sends one request to Claude (the prompt `ok`), exactly like any other Claude Code request.

## Removing it again

- **Option A:** remove the `statusLine` entry from `~/.claude/settings.json` and delete the script.
- **Option B:** delete the task (Windows: `Unregister-ScheduledTask -TaskName 'TokenUsageLimitPoll'`) or the cron line, then delete the script.
- **Optional:** delete `~/.claude/ratelimit-log.jsonl`. Without it the plugin falls back to its own estimates, exactly as before.

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

If you write your own logger, this is all the plugin needs. Lines it cannot read are skipped.
