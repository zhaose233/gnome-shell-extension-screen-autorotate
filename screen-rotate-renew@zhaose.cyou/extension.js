/* extension.js
* Copyright (C) 2022  kosmospredanie, shyzus
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

'use strict';

const GETTEXT_DOMAIN = 'gnome-shell-extension-screen-rotate';
const ORIENTATION_LOCK_SCHEMA = 'org.gnome.settings-daemon.peripherals.touchscreen';
const ORIENTATION_LOCK_KEY = 'orientation-lock';

const Gettext = imports.gettext.domain(GETTEXT_DOMAIN);
const _ = Gettext.gettext;

const { GLib, Gio } = imports.gi;

const Main = imports.ui.main;
const SystemActions = imports.misc.systemActions;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Rotator = Me.imports.rotator;

const Orientation = Object.freeze({
    'normal': 0,
    'left-up': 1,
    'bottom-up': 2,
    'right-up': 3
});

const {Clutter} = imports.gi;

let seat = null, originalGetTouchMode = null;


class SensorProxy {
    constructor(rotate_cb) {
        this._rotate_cb = rotate_cb;
        this._proxy = null;
        this._enabled = false;
        this._watcher_id = Gio.bus_watch_name(
            Gio.BusType.SYSTEM,
            'net.hadess.SensorProxy',
            Gio.BusNameWatcherFlags.NONE,
            this.appeared.bind(this),
            this.vanished.bind(this)
        );
    }

    destroy() {
        Gio.bus_unwatch_name(this._watcher_id);
        if (this._enabled) this.disable();
        this._proxy = null;
    }

    enable() {
        this._enabled = true;
        if (this._proxy === null) return;
        this._proxy.call_sync('ClaimAccelerometer', null, Gio.DBusCallFlags.NONE, -1, null);
    }

    disable() {
        this._enabled = false;
        if (this._proxy === null) return;
        this._proxy.call_sync('ReleaseAccelerometer', null, Gio.DBusCallFlags.NONE, -1, null);
    }

    appeared(connection, name, name_owner) {
        this._proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'net.hadess.SensorProxy', '/net/hadess/SensorProxy', 'net.hadess.SensorProxy',
            null);
        this._proxy.connect('g-properties-changed', this.properties_changed.bind(this));
        if (this._enabled) {
            this._proxy.call_sync('ClaimAccelerometer', null, Gio.DBusCallFlags.NONE, -1, null);
        }
    }

    vanished(connection, name) {
        this._proxy = null;
    }

    properties_changed(proxy, changed, invalidated) {
        if (!this._enabled) return;
        let properties = changed.deep_unpack();
        for (let [name, value] of Object.entries(properties)) {
            if (name != 'AccelerometerOrientation') continue;
            let target = value.unpack();
            this._rotate_cb(target);
        }
    }
}

class ScreenAutorotate {
    constructor() {
        this._system_actions = (new SystemActions.getDefault());
	
        this._system_actions_backup = null;
        this._override_system_actions();

	Main.panel._updatePanel()
	
	this._orientation_settings = new Gio.Settings({ schema_id: ORIENTATION_LOCK_SCHEMA });
        this._orientation_settings.connect('changed::' + ORIENTATION_LOCK_KEY, this._orientation_lock_changed.bind(this));

        this._sensor_proxy = new SensorProxy( this.rotate_to.bind(this) );

        this._state = false; // enabled or not

        let locked = this._orientation_settings.get_boolean(ORIENTATION_LOCK_KEY);
        if (!locked) this.enable();
    }

    _override_system_actions() {
        this._system_actions_backup = {
            '_updateOrientationLock': this._system_actions._updateOrientationLock
        };

	this._system_actions._updateOrientationLock = function() {
            try {
                (new imports.misc.systemActions.getDefault())._actions.get('lock-orientation').available = true;
                (new imports.misc.systemActions.getDefault()).notify('can-lock-orientation');
            } catch (error) {
                log(error)
            }
        };
        this._system_actions._updateOrientationLock();
    }

    _restore_system_actions() {
        if (this._system_actions_backup === null) return;
        this._system_actions._updateOrientationLock = this._system_actions_backup['_updateOrientationLock'];
        this._system_actions._updateOrientationLock();
        this._system_actions_backup = null;
    }

    _orientation_lock_changed() {
        let locked = this._orientation_settings.get_boolean(ORIENTATION_LOCK_KEY);
        if (this._state == locked) {
            this.toggle();
        }
    }

    destroy() {
        this._sensor_proxy.destroy();
        this._orientation_settings = null;
        this._restore_system_actions();
    }

    toggle() {
        if (this._state) {
            this.disable();
        } else {
            this.enable();
        }
    }

    enable() {
        this._sensor_proxy.enable();
        this._state = true;
    }

    disable() {
        this._sensor_proxy.disable();
        this._state = false;
    }

    rotate_to(orientation) {
        let target = Orientation[orientation];
        Rotator.rotate_to(target);
	if (target == 2) {
	    try {
		GLib.spawn_command_line_async('pactl load-module module-remap-sink sink_name=reverse-stereo master=alsa_output.pci-0000_08_00.6.analog-stereo channels=2 master_channel_map=front-right,front-left channel_map=front-left,front-right');
	    } catch (error) {
		log(error);
	    }
	} else {
	    try {
		GLib.spawn_command_line_async('pactl unload-module module-remap-sink');
	    } catch (error) {
		log(error);
	    }
	}

	if (target != 0) {
	    seat.get_touch_mode = () => true;
	} else {
	    seat.get_touch_mode = originalGetTouchMode;
	}
    }
}

class Extension {
    constructor(uuid) {
        this._uuid = uuid;
        ExtensionUtils.initTranslations(GETTEXT_DOMAIN);
    }

    enable() {
        this._ext = new ScreenAutorotate();
	// let proxy = Gio.DBusProxy.new_for_bus_sync(
        //     Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
        //     'net.hadess.SensorProxy', '/net/hadess/SensorProxy', 'net.hadess.SensorProxy',
        //     null);
	// this._ext.rotate_to(
	//     proxy.get_cached_property("AccelerometerOrientation").get_string()[0]);
	// proxy.destroy()
    }

    disable() {
        this._ext.destroy();
        this._ext = null;
	seat.get_touch_mode = originalGetTouchMode;
    }
}

function init(meta) {
    seat = Clutter.get_default_backend().get_default_seat();
    originalGetTouchMode = seat.get_touch_mode;
    return new Extension(meta.uuid);
}




