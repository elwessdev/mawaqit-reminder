import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const REFRESH_HOUR = 0;     // refresh today's times at 00:05
const REFRESH_MINUTE = 5;

// -------------------------------------------------------------------------
// Mawaqit page parser
// -------------------------------------------------------------------------

// Walks the HTML to find `var confData = {...};` and returns the JSON string
// (brace-balanced, string-aware) — Mawaqit nests objects inside confData so
// a naive regex won't work.
function extractConfDataJson(html) {
    const startRe = /(?:var|let)\s+confData\s*=\s*\{/;
    const m = startRe.exec(html);
    if (!m)
        return null;

    const start = m.index + m[0].length - 1; // index of first `{`
    let depth = 0;
    let inStr = false;
    let strCh = '';
    let esc = false;

    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (inStr) {
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === strCh) inStr = false;
            continue;
        }
        if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0)
                return html.slice(start, i + 1);
        }
    }
    return null;
}

// -------------------------------------------------------------------------
// Panel button
// -------------------------------------------------------------------------

const MawaqitIndicator = GObject.registerClass(
class MawaqitIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Mawaqit Prayer Reminder', false);
        this._ext = extension;

        // Top bar label
        this._label = new St.Label({
            text: '…',
            style_class: 'panel-button',
            y_expand: true,
            y_align: 2, // Clutter.ActorAlign.CENTER
        });
        this.add_child(this._label);

        // Menu rows:
        //   Fajr (+20):    HH:MM
        //   Shurûq:        HH:MM
        //   Dhuhr (+10):   HH:MM
        //   Asr (+10):     HH:MM
        //   Maghrib (+10): HH:MM
        //   Isha (+10):    HH:MM
        this._timeItems = [];
        // Fajr (index 0)
        this._timeItems.push(this._makeRow('Fajr: --:--'));
        // Shurûq — separate, sits between Fajr and Dhuhr
        this._shuruqItem = this._makeRow('Shurûq: --:--');
        // The remaining 4 prayers
        for (let i = 1; i < 5; i++)
            this._timeItems.push(this._makeRow(`${PRAYER_NAMES[i]}: --:--`));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._mosqueItem = new PopupMenu.PopupMenuItem('Mosque: (not set)');
        this._mosqueItem.setSensitive(false);
        this.menu.addMenuItem(this._mosqueItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._ext.refresh());
        this.menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Settings…');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    // Helper: adds a non-interactive row, attached in correct visual order.
    _makeRow(text) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        // Insert Shurûq between Fajr (already added) and the next prayers,
        // by using addMenuItem in call order. We track position separately.
        this.menu.addMenuItem(item);
        return item;
    }

    setTimes(times, mosqueName, iqama, shuruq) {
        if (Array.isArray(times)) {
            times.forEach((t, i) => {
                const suffix = iqamaSuffix(iqama, i, times);
                const label = `${PRAYER_NAMES[i]}${suffix}: ${t}`;
                this._timeItems[i].label.set_text(label);
            });
        }
        if (shuruq)
            this._shuruqItem.label.set_text(`Shurûq: ${shuruq}`);
        if (mosqueName)
            this._mosqueItem.label.set_text(`Mosque: ${mosqueName}`);
    }

    setTopText(text) {
        this._label.set_text(text);
    }
});

// -------------------------------------------------------------------------
// The Extension
// -------------------------------------------------------------------------

export default class MawaqitExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._times = null;        // ['HH:MM', ...] for [Fajr, Dhuhr, Asr, Maghrib, Isha]
        this._iqama = null;        // parsed iqama config per prayer
        this._mosqueName = '';
        this._lastNotifiedKey = ''; // prevents double-firing notifications
        this._tickSourceId = 0;
        this._refreshSourceId = 0;
        this._scheduleSourceIds = []; // GLib source IDs for the per-prayer reminder timers

        // Soup HTTP session
        this._session = new Soup.Session({timeout: 20});
        this._session.user_agent =
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

        // Notification source (custom, so we keep our own icon/label)
        this._notifSource = new MessageTray.Source({
            title: 'Mawaqit',
            iconName: 'appointment-soon-symbolic',
        });
        this._notifSource.connect('destroy', () => {
            this._notifSource = null;
        });
        Main.messageTray.add(this._notifSource);

        // Top-bar indicator
        this._addIndicator();

        // React to settings changes
        this._settingsChangedId = this._settings.connect(
            'changed::mosque-url', () => this.refresh());
        this._positionChangedId = this._settings.connect(
            'changed::panel-position', () => this._addIndicator());

        // 1-second tick that updates the top-bar countdown
        this._tickSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => {
                this._updateTopBar();
                return GLib.SOURCE_CONTINUE;
            });

        // Daily refresh at 00:05 local time
        this._scheduleDailyRefresh();

        // First load
        this.refresh();
    }

    // Create (or re-create) the indicator at the configured panel position.
    _addIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._indicator = new MawaqitIndicator(this);
        const box = this._settings.get_string('panel-position'); // 'left'|'center'|'right'
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, box);

        // Restore display if we already have data
        if (this._times) {
            this._indicator.setTimes(this._times, this._mosqueName, this._iqama, this._shuruq);
            this._updateTopBar();
        }
    }

    disable() {
        if (this._tickSourceId) {
            GLib.Source.remove(this._tickSourceId);
            this._tickSourceId = 0;
        }
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        this._clearScheduledReminders();

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._settings && this._positionChangedId) {
            this._settings.disconnect(this._positionChangedId);
            this._positionChangedId = 0;
        }
        this._settings = null;

        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._notifSource) {
            this._notifSource.destroy();
            this._notifSource = null;
        }
        this._times = null;
        this._iqama = null;
    }

    // ---- HTTP fetch (Soup3 async) -------------------------------------

    _fetchPage(url) {
        return new Promise((resolve, reject) => {
            let msg;
            try {
                msg = Soup.Message.new('GET', url);
            } catch (e) {
                reject(new Error(`Invalid URL: ${e.message}`));
                return;
            }
            this._session.send_and_read_async(
                msg,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = msg.get_status();
                        if (status !== Soup.Status.OK) {
                            reject(new Error(`HTTP ${status}`));
                            return;
                        }
                        const decoder = new TextDecoder('utf-8');
                        resolve(decoder.decode(bytes.get_data()));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    // ---- Refresh + parse ----------------------------------------------

    async refresh() {
        const url = this._settings.get_string('mosque-url').trim();
        if (!url) {
            this._indicator.setTopText('Set URL');
            return;
        }
        if (!url.startsWith('https://mawaqit.net/')) {
            this._indicator.setTopText('Bad URL');
            return;
        }

        try {
            const html = await this._fetchPage(url);
            const json = extractConfDataJson(html);
            if (!json)
                throw new Error('confData not found in page');

            const conf = JSON.parse(json);
            if (!Array.isArray(conf.times) || conf.times.length < 5)
                throw new Error('No times in confData');

            this._times = conf.times.slice(0, 5);
            this._iqama = parseIqamaArray(conf.iqama, this._times);
            this._shuruq = conf.shuruq || '';
            this._mosqueName = conf.name || conf.localisation || 'Mosque';
            this._indicator.setTimes(this._times, this._mosqueName, this._iqama, this._shuruq);

            // ---- DEBUG ----
            log('[mawaqit] times: ' + JSON.stringify(this._times));
            log('[mawaqit] raw iqama from confData: ' + JSON.stringify(conf.iqama));
            log('[mawaqit] parsed iqama: ' + JSON.stringify(this._iqama));
            for (let i = 0; i < 5; i++) {
                const adhan = todayAt(this._times[i]);
                const iqama = this._iqamaDateFor(i);
                log('[mawaqit] ' + PRAYER_NAMES[i] +
                    ' adhan=' + adhan.toLocaleTimeString() +
                    ' iqama=' + iqama.toLocaleTimeString());
            }
            // ----

            this._scheduleAllReminders();
            this._updateTopBar();
        } catch (e) {
            logError(e, 'mawaqit-reminder refresh failed');
            this._indicator.setTopText('Error');
        }
    }

    // ---- Top-bar countdown --------------------------------------------

    _updateTopBar() {
        if (!this._times) return GLib.SOURCE_CONTINUE;
        const showSeconds = this._settings.get_boolean('show-seconds');

        // Are we currently between adhan and iqama for any prayer?
        const inIqama = this._currentIqamaWindow();
        if (inIqama) {
            const ms = inIqama.iqamaDate.getTime() - Date.now();
            const text = `${inIqama.name} iqama · ${formatDelta(ms, true)}`;
            if (text !== this._lastTopText) {
                log('[mawaqit] top bar (iqama): ' + text);
                this._lastTopText = text;
            }
            this._indicator.setTopText(text);
            return GLib.SOURCE_CONTINUE;
        }

        // Otherwise show countdown to the next prayer
        const next = this._nextPrayer();
        if (!next) {
            this._indicator.setTopText('…');
            return GLib.SOURCE_CONTINUE;
        }
        const ms = next.date.getTime() - Date.now();
        const text = `${next.name} · ${formatDelta(ms, showSeconds)}`;
        // log only the prayer name change, not every tick
        if (!this._lastTopPrayer || this._lastTopPrayer !== next.name) {
            log('[mawaqit] top bar (next): ' + next.name + ' at ' + next.date.toLocaleTimeString());
            this._lastTopPrayer = next.name;
        }
        this._indicator.setTopText(text);
        return GLib.SOURCE_CONTINUE;
    }

    // Returns {name, index, prayerDate, iqamaDate} if `now` is between
    // adhan and iqama for any prayer, else null.
    _currentIqamaWindow() {
        if (!this._times || !this._iqama) return null;
        const now = Date.now();
        for (let i = 0; i < 5; i++) {
            const adhan = todayAt(this._times[i]).getTime();
            const iqama = this._iqamaDateFor(i).getTime();
            if (now >= adhan && now < iqama) {
                return {
                    name: PRAYER_NAMES[i],
                    index: i,
                    prayerDate: new Date(adhan),
                    iqamaDate: new Date(iqama),
                };
            }
        }
        return null;
    }

    // Computes iqama Date for prayer index i, today.
    // iqama entry can be "+20" / "20" (offset in minutes) or "HH:MM" (absolute).
    _iqamaDateFor(i) {
        const entry = this._iqama[i];
        const adhan = todayAt(this._times[i]);
        if (entry && entry.kind === 'offset') {
            const d = new Date(adhan);
            d.setMinutes(d.getMinutes() + entry.minutes);
            return d;
        }
        if (entry && entry.kind === 'absolute') {
            return todayAt(entry.hhmm);
        }
        // Fallback: 10 min after adhan (Mawaqit default for most prayers)
        const d = new Date(adhan);
        d.setMinutes(d.getMinutes() + 10);
        return d;
    }

    _nextPrayer() {
        if (!this._times) return null;
        const now = Date.now();
        let best = null;
        for (let i = 0; i < 5; i++) {
            const d = todayAt(this._times[i]);
            const t = d.getTime();
            if (t > now && (!best || t < best.date.getTime()))
                best = {name: PRAYER_NAMES[i], date: d, index: i};
        }
        // All today's prayers passed — show tomorrow's Fajr
        if (!best) {
            const d = todayAt(this._times[0]);
            d.setDate(d.getDate() + 1);
            best = {name: PRAYER_NAMES[0], date: d, index: 0};
        }
        return best;
    }

    // ---- Reminder scheduling ------------------------------------------

    _clearScheduledReminders() {
        for (const id of this._scheduleSourceIds)
            GLib.Source.remove(id);
        this._scheduleSourceIds = [];
    }

    _scheduleAllReminders() {
        this._clearScheduledReminders();
        if (!this._times) return;

        const lead = this._settings.get_int('remind-minutes');
        const now = Date.now();

        this._times.forEach((hhmm, i) => {
            const prayerDate = todayAt(hhmm);
            const iqamaDate = this._iqamaDateFor(i);

            // (1) Pre-prayer reminder: `lead` minutes before adhan
            const remindFireMs = prayerDate.getTime() - lead * 60 * 1000;
            this._addOneShot(remindFireMs, () =>
                this._notifyPrayer(PRAYER_NAMES[i], hhmm, lead));

            // (2) Iqama notification: at iqama time
            this._addOneShot(iqamaDate.getTime(), () =>
                this._notifyIqama(PRAYER_NAMES[i], formatHM(iqamaDate)));
        });
    }

    // Helper: schedule a single GLib timeout, tracking its id for cleanup.
    _addOneShot(fireMs, fn) {
        const deltaSec = Math.floor((fireMs - Date.now()) / 1000);
        if (deltaSec <= 0) return; // already past
        const id = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, deltaSec, () => {
                fn();
                this._scheduleSourceIds = this._scheduleSourceIds.filter(x => x !== id);
                return GLib.SOURCE_REMOVE;
            });
        this._scheduleSourceIds.push(id);
    }

    _scheduleDailyRefresh() {
        const now = new Date();
        const next = new Date(now);
        next.setHours(REFRESH_HOUR, REFRESH_MINUTE, 0, 0);
        if (next.getTime() <= now.getTime())
            next.setDate(next.getDate() + 1);
        const deltaSec = Math.max(1, Math.floor((next.getTime() - now.getTime()) / 1000));

        this._refreshSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, deltaSec, () => {
                this.refresh();
                this._scheduleDailyRefresh(); // chain for tomorrow
                this._refreshSourceId = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    // ---- Notifications ------------------------------------------------

    _notifyPrayer(name, hhmm, lead) {
        // Guard against double-fire if scheduler races
        const key = `${name}@${hhmm}@${new Date().toDateString()}`;
        if (this._lastNotifiedKey === key) return;
        this._lastNotifiedKey = key;

        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'Mawaqit',
                iconName: 'appointment-soon-symbolic',
            });
            Main.messageTray.add(this._notifSource);
        }

        const title = lead > 0
            ? `${name} in ${lead} minute${lead === 1 ? '' : 's'}`
            : `${name} now`;
        const body = `${this._mosqueName} — ${name} at ${hhmm}`;

        const notif = new MessageTray.Notification({
            source: this._notifSource,
            title,
            body,
            iconName: 'appointment-soon-symbolic',
            urgency: MessageTray.Urgency.HIGH,
        });
        this._notifSource.addNotification(notif);
    }

    _notifyIqama(name, hhmm) {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'Mawaqit',
                iconName: 'appointment-soon-symbolic',
            });
            Main.messageTray.add(this._notifSource);
        }
        const notif = new MessageTray.Notification({
            source: this._notifSource,
            title: `${name} — Iqama (${hhmm})`,
            body: `${this._mosqueName} — time for ${name} prayer`,
            iconName: 'appointment-soon-symbolic',
            urgency: MessageTray.Urgency.HIGH,
        });
        this._notifSource.addNotification(notif);
    }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

// Returns a short suffix to append after a prayer name in the menu.
// Uses the iqama config + the prayer time to choose the friendliest form:
//   small offset (< 30 min)  → " (+10)"  — typical
//   large offset (>= 30 min) → " (iqama 14:45)" — show resulting time
//   absolute                 → " (iqama 14:45)"
//   missing                  → ""
function iqamaSuffix(iqamaArr, i, times) {
    if (!iqamaArr || !iqamaArr[i]) return '';
    const e = iqamaArr[i];
    if (e.kind === 'offset') {
        if (e.minutes < 30) return ` (+${e.minutes})`;
        // Large offset — show the resulting wall-clock time
        if (times && times[i]) {
            const d = todayAt(times[i]);
            d.setMinutes(d.getMinutes() + e.minutes);
            return ` (iqama ${pad(d.getHours())}:${pad(d.getMinutes())})`;
        }
        return ` (+${e.minutes})`;
    }
    if (e.kind === 'absolute') return ` (iqama ${e.hhmm})`;
    return '';
}

function todayAt(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
}

function formatHM(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Mawaqit stores iqama as 5 strings. Each can be:
//   - "+20" or "20"   → offset in minutes after adhan
//   - "05:00"         → absolute time
// Returns an array of 5 { kind: 'offset'|'absolute', minutes?: number, hhmm?: string }
function parseIqamaArray(arr, times) {
    const out = [];
    for (let i = 0; i < 5; i++) {
        const raw = (arr && arr[i] != null) ? String(arr[i]).trim() : '';
        if (/^[+]?\d+$/.test(raw)) {
            out.push({kind: 'offset', minutes: parseInt(raw.replace('+', ''), 10)});
        } else if (/^\d{1,2}:\d{2}$/.test(raw)) {
            out.push({kind: 'absolute', hhmm: raw});
        } else {
            // Default: 10 min after adhan (Mawaqit's standard for non-Fajr)
            out.push({kind: 'offset', minutes: i === 0 ? 20 : 10});
        }
    }
    return out;
}

function formatDelta(ms, showSeconds) {
    if (ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
        return showSeconds
            ? `${h}h ${pad(m)}:${pad(s)}`
            : `${h}h ${pad(m)}m`;
    }
    return showSeconds ? `${pad(m)}:${pad(s)}` : `${m} min`;
}

function pad(n) { return n < 10 ? `0${n}` : `${n}`; }
