# Mawaqit Prayer Reminder

A GNOME Shell extension that shows the next prayer and a live countdown in the top bar, and sends desktop notifications before each prayer and at iqama time. Prayer times are read directly from your mosque's page on [mawaqit.net](https://mawaqit.net).

> **Unofficial.** This project is not affiliated with or endorsed by Mawaqit.

## Features

- **Next prayer + countdown** in the top bar (e.g. `Asr · 24 min`, or `Asr · 24:13` with seconds enabled)
- **Iqama countdown**: between adhan and iqama the bar switches to e.g. `Dhuhr iqama · 07:42`
- **Dropdown menu** with today's times for Fajr, Shurûq, Dhuhr, Asr, Maghrib and Isha, with the iqama offset next to each prayer, plus the mosque name
- **Two notifications per prayer**: a reminder N minutes before the adhan (default 5), and another at iqama time
- **Automatic daily refresh** at 00:05, plus a manual "Refresh now" menu entry
- **Configurable panel position**: left, center or right

## Requirements

- GNOME Shell **46** (e.g. Ubuntu 24.04)
- `glib-compile-schemas` (package `libglib2.0-bin` on Debian/Ubuntu)
- Internet access to `mawaqit.net`

## Installation

```bash
# 1. Clone the repository straight into the extensions folder
git clone https://github.com/<your-username>/<repo-name>.git \
  ~/.local/share/gnome-shell/extensions/mawaqit-reminder@local

# 2. Compile the settings schema
glib-compile-schemas ~/.local/share/gnome-shell/extensions/mawaqit-reminder@local/schemas/

# 3. Restart GNOME Shell
#    Wayland: log out and log back in
#    X11:     press Alt+F2, type "r", press Enter

# 4. Enable the extension
gnome-extensions enable mawaqit-reminder@local

# 5. Open the settings and paste your mosque URL
gnome-extensions prefs mawaqit-reminder@local
```

The directory name must match the `uuid` in `metadata.json` (`mawaqit-reminder@local`).

## Setup

1. Find your mosque on [mawaqit.net](https://mawaqit.net) and open its page.
2. Copy the URL from the address bar, e.g. `https://mawaqit.net/en/your-mosque-name`.
3. Paste it into **Mawaqit URL** in the extension settings and click **Save**.

The top bar updates within a couple of seconds. Only URLs starting with `https://mawaqit.net/` are accepted.

## Settings

| Setting | Description | Default |
|---|---|---|
| Mawaqit URL | Full URL of your mosque page on mawaqit.net | empty |
| Minutes before prayer | How early to send the pre-prayer notification (0–60) | 5 |
| Show seconds in top-bar countdown | `MM:SS` instead of `N min` | off |
| Top-bar position | `left`, `center` or `right` | center |

## Top-bar messages

| Text | Meaning |
|---|---|
| `Set URL` | No mosque URL configured yet |
| `Bad URL` | The URL doesn't start with `https://mawaqit.net/` |
| `Error` | Fetching or parsing the page failed (see logs below) |
| `…` | Waiting for data |

## Troubleshooting

**View logs:**

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

**Check the extension state:**

```bash
gnome-extensions info mawaqit-reminder@local
```

**Notifications not appearing?** Check *Settings → Notifications* and make sure Do Not Disturb is off.

**Top bar shows `Error`?** Open the mosque URL in a browser to confirm it loads. The extension depends on the page's current structure (see below), so a Mawaqit site change may break it. Please open an issue with the log output.

**Reset everything:**

```bash
gnome-extensions disable mawaqit-reminder@local
rm -rf ~/.local/share/gnome-shell/extensions/mawaqit-reminder@local
dconf reset -f /org/gnome/shell/extensions/mawaqit-reminder/
```

## How it works

1. On enable, on settings change, on manual refresh and daily at 00:05, the extension fetches the mosque page with libsoup.
2. It locates the `confData` JavaScript object embedded in the HTML using a brace-balanced, string-aware scanner, then parses it as JSON.
3. From `confData` it reads `times` (Fajr, Dhuhr, Asr, Maghrib, Isha), `shuruq`, `iqama` and the mosque name.
4. Iqama entries are either an offset in minutes (`+10`) or an absolute time (`14:45`). If a value is missing, it falls back to 20 minutes for Fajr and 10 minutes for the others.
5. One `GLib` timer is scheduled per notification (pre-prayer and iqama, five prayers each). Timers that are already in the past are skipped.
6. A 1-second tick refreshes the top-bar label.

Timers run inside the shell process. After a suspend/resume they may fire late, and the next refresh re-synchronises them. Times are cached only in memory, so an internet connection is needed when the extension loads.

## Project structure

```
.
├── extension.js     # Shell-side code: indicator, fetcher/parser, scheduler, notifications
├── prefs.js         # Adwaita preferences window
├── metadata.json    # Extension manifest
└── schemas/
    └── org.gnome.shell.extensions.mawaqit-reminder.gschema.xml
```

## Development

Test in a nested session without logging out:

```bash
dbus-run-session gnome-shell --nested --wayland
```

Reload after editing `extension.js` by disabling and re-enabling the extension, though on Wayland a full re-login is the reliable way to reload changed JavaScript modules.

## Contributing

Issues and pull requests are welcome. For bugs, please include your GNOME Shell version (`gnome-shell --version`) and relevant log output.

## Disclaimer

Prayer times come from the mosque's own Mawaqit page. Always verify against your local mosque's announcements.
