import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MawaqitPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Mawaqit',
            icon_name: 'appointment-soon-symbolic',
        });
        window.add(page);

        // ---------------- Mosque group ----------------
        const groupMosque = new Adw.PreferencesGroup({
            title: 'Mosque',
            description: 'Paste the full URL of your mosque page on mawaqit.net, then click Save.',
        });
        page.add(groupMosque);

        // Row containing the entry + Save button
        const urlRow = new Adw.ActionRow({title: 'Mawaqit URL'});

        const entry = new Gtk.Entry({
            hexpand: true,
            valign: Gtk.Align.CENTER,
            placeholder_text: 'https://mawaqit.net/en/your-mosque',
            text: settings.get_string('mosque-url'),
        });
        urlRow.add_suffix(entry);

        const saveBtn = new Gtk.Button({
            label: 'Save',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        urlRow.add_suffix(saveBtn);
        urlRow.activatable_widget = saveBtn;

        groupMosque.add(urlRow);

        // Status row underneath
        const statusRow = new Adw.ActionRow({
            title: '',
            subtitle: settings.get_string('mosque-url')
                ? `Current: ${settings.get_string('mosque-url')}`
                : 'No URL saved yet.',
        });
        groupMosque.add(statusRow);

        const doSave = () => {
            const url = entry.get_text().trim();
            if (!url) {
                statusRow.set_subtitle('⚠ URL is empty.');
                return;
            }
            if (!url.startsWith('https://mawaqit.net/')) {
                statusRow.set_subtitle('⚠ URL must start with https://mawaqit.net/');
                return;
            }
            settings.set_string('mosque-url', url);
            statusRow.set_subtitle(`✓ Saved: ${url}`);
        };

        saveBtn.connect('clicked', doSave);
        entry.connect('activate', doSave); // pressing Enter in the field also saves

        // Safety net: save on window close too
        window.connect('close-request', () => {
            const cur = settings.get_string('mosque-url');
            const typed = entry.get_text().trim();
            if (typed && typed !== cur && typed.startsWith('https://mawaqit.net/'))
                settings.set_string('mosque-url', typed);
            return false;
        });

        // ---------------- Reminders group ----------------
        const groupRemind = new Adw.PreferencesGroup({title: 'Reminders'});
        page.add(groupRemind);

        const leadRow = new Adw.SpinRow({
            title: 'Minutes before prayer',
            subtitle: 'Send the notification this many minutes before each prayer time.',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 60, step_increment: 1, page_increment: 5,
                value: settings.get_int('remind-minutes'),
            }),
        });
        leadRow.connect('notify::value', () => {
            settings.set_int('remind-minutes', leadRow.get_value());
        });
        groupRemind.add(leadRow);

        const secRow = new Adw.SwitchRow({
            title: 'Show seconds in top-bar countdown',
            active: settings.get_boolean('show-seconds'),
        });
        secRow.connect('notify::active', () => {
            settings.set_boolean('show-seconds', secRow.get_active());
        });
        groupRemind.add(secRow);

        // ---------------- Appearance group ----------------
        const groupAppearance = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(groupAppearance);

        const positions = ['left', 'center', 'right'];
        const positionLabels = new Gtk.StringList();
        positionLabels.append('Left');
        positionLabels.append('Center');
        positionLabels.append('Right');

        const posRow = new Adw.ComboRow({
            title: 'Top-bar position',
            subtitle: 'Where to show the indicator in the top panel.',
            model: positionLabels,
            selected: positions.indexOf(settings.get_string('panel-position')),
        });
        posRow.connect('notify::selected', () => {
            const idx = posRow.get_selected();
            if (idx >= 0 && idx < positions.length)
                settings.set_string('panel-position', positions[idx]);
        });
        groupAppearance.add(posRow);

        window.set_default_size(560, 480);
    }
}
