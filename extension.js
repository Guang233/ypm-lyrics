/* extension.js — YPM Lyrics: YesPlayMusic 顶栏歌词
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * 通过 YesPlayMusic 本地 HTTP API 获取播放状态和歌词。
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ─── Constants ───────────────────────────────────────────────────────
const PLAYER_API = 'http://127.0.0.1:27232/player';
const LYRIC_API = 'http://127.0.0.1:10754/lyric?id=';
const TICK_MS = 100;
const POLL_NORMAL_TICKS = 10;        // 跟踪模式：每 10 tick poll（1000ms）
const MAX_DRIFT_MS = 1000;           // 动态校准阈值：实际时间戳与 API 偏差超过 1s 则重新校准
const PAUSE_TIMEOUT_US = 1500000;    // 1.5 秒无 progress 变化 → 暂停（微秒）

// ─── LRC Parser ──────────────────────────────────────────────────────

function parseLRC(lrc) {
    if (!lrc) return [];
    const lines = lrc.split('\n');
    const result = [];
    const timeRe = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;

    for (const line of lines) {
        const times = [];
        let match;
        timeRe.lastIndex = 0;
        while ((match = timeRe.exec(line)) !== null) {
            const min = parseInt(match[1], 10);
            const sec = parseInt(match[2], 10);
            const ms = match[3]
                ? parseInt(match[3].padEnd(3, '0'), 10)
                : 0;
            times.push(min * 60000 + sec * 1000 + ms);
        }
        const text = line.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
        if (text.length === 0) continue;
        for (const t of times) {
            result.push({ time: t, text });
        }
    }
    result.sort((a, b) => a.time - b.time);
    return result;
}

function findLyricIndex(lyrics, posMs) {
    if (!lyrics || lyrics.length === 0) return -1;
    let idx = -1;
    for (let i = 0; i < lyrics.length; i++) {
        if (lyrics[i].time <= posMs) idx = i;
        else break;
    }
    return idx;
}

// ─── Extension ───────────────────────────────────────────────────────

export default class YpmLyricsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._soupSession = new Soup.Session();
        this._lyricsCache = new Map();
        this._coverCache = new Map();      // songId → tmpFilePath

        this._currentSongId = null;
        this._currentTrackName = '';
        this._currentTrackArtist = '';
        this._currentArtUrl = '';
        this._currentLyrics = [];
        this._currentTLyrics = [];
        this._currentIndex = -1;

        // ── 时间戳计算系统（用户指定双模式逻辑） ──
        this._anchorMs = 0;                // 误差在100ms内的实际时间戳对应 API ms
        this._anchorTimestamp = 0;         // 该时间戳对应本机的单调时钟（微秒）
        this._lastRawProgress = -1;        // 上一次查询的进度
        this._lastProgressChangeTime = 0;

        this._pollingMode = 'FAST';        // 'FAST'=100ms, 'NORMAL'=1000ms
        this._pollTickCounter = 0;

        this._isPlaying = false;
        this._playerAvailable = false;

        this._mprisProxy = null;
        this._mprisName = null;
        this._dbusProxy = null;

        this._mainTimerId = 0;
        this._animTimeoutId = 0;
        this._lastAnimText = '';

        this._buildUI();
        this._connectSettings();
        this._watchMpris();
        this._startMainTimer();
    }

    disable() {
        this._stopMainTimer();
        if (this._animTimeoutId) {
            GLib.source_remove(this._animTimeoutId);
            this._animTimeoutId = 0;
        }
        if (this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings?.disconnect(id);
            this._settingsChangedIds = null;
        }
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
        this._label = null;
        this._bin = null;
        this._box = null;
        this._prefixLabel = null;
        this._coverIcon = null;
        this._soupSession?.abort();
        this._soupSession = null;
        this._settings = null;
        this._lyricsCache = null;
        this._disconnectYpmMpris();
        if (this._dbusProxy) {
            this._dbusProxy = null;
        }

        // 清理临时封面文件
        if (this._coverCache) {
            for (const p of this._coverCache.values()) {
                try { Gio.File.new_for_path(p).delete(null); } catch (_e) { /* ok */ }
            }
            this._coverCache = null;
        }
    }

    // ─── UI ──────────────────────────────────────────────────────────

    _buildUI() {
        this._button = new PanelMenu.Button(0.5, 'YPM Lyrics', false); // false = create menu
        this._button.add_style_class_name('ypm-lyrics-btn');

        this._box = new St.BoxLayout({
            style_class: 'ypm-lyrics-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // 前缀：音符 label 或专辑封面 icon（按设置切换）
        this._prefixLabel = new St.Label({
            style_class: 'ypm-lyrics-prefix',
            text: '♪ ',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._coverIcon = new St.Icon({
            style_class: 'ypm-lyrics-cover',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._coverIcon.hide();

        this._bin = new St.Bin({
            style_class: 'ypm-lyrics-bin',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
        });
        this._bin.set_clip_to_allocation(true);

        this._label = new St.Label({
            style_class: 'ypm-lyrics-label',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.opacity = 0;

        // 取消原有的直接 max_width 和 text_overflow 以允许其原样撑开用于测量和走马灯
        // 在外部 Bin 上进行裁剪

        this._bin.set_child(this._label);
        this._bin.clip_to_allocation = true; // 开启裁剪
        this._box.add_child(this._prefixLabel);
        this._box.add_child(this._coverIcon);
        this._box.add_child(this._bin);
        this._button.add_child(this._box);

        // ── 播放卡片 PopupMenu ──
        this._menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._menuBox = new St.BoxLayout({ vertical: false, style_class: 'ypm-lyrics-menu-box' });
        
        this._menuCoverContainer = new St.Bin({
            style_class: 'ypm-lyrics-menu-cover-container',
            clip_to_allocation: true
        });

        this._menuCover = new St.Icon({
            icon_size: 64, // 原本大小 64
            style_class: 'ypm-lyrics-menu-cover',
            fallback_icon_name: 'audio-x-generic-symbolic'
        });
        this._menuCoverContainer.set_child(this._menuCover);
        
        const textBox = new St.BoxLayout({ vertical: true, style_class: 'ypm-lyrics-menu-text-box' });
        this._menuTitle = new St.Label({ style_class: 'ypm-lyrics-menu-title', text: 'YPM Lyrics' });
        this._menuArtist = new St.Label({ style_class: 'ypm-lyrics-menu-artist', text: 'Waiting for player...' });
        
        textBox.add_child(this._menuTitle);
        textBox.add_child(this._menuArtist);
        
        this._menuBox.add_child(this._menuCoverContainer);
        this._menuBox.add_child(textBox);
        this._menuItem.add_child(this._menuBox);
        
        this._button.menu.addMenuItem(this._menuItem);

        this._applySettings();
        this._updatePrefix();
        this._addToPanel();
        this._updateVisibility();
    }

    _addToPanel() {
        if (!this._button) return;
        const pos = this._settings.get_string('position');
        const idx = this._settings.get_int('position-index');
        const box = pos === 'left' ? 'left'
            : pos === 'right' ? 'right'
                : 'center';
        Main.panel.addToStatusArea('ypm-lyrics', this._button, idx, box);
    }

    _removeFromPanel() {
        if (!this._button) return;
        const container = this._button.get_parent();
        if (container) container.remove_child(this._button);
    }

    _applySettings() {
        if (!this._label || !this._settings) return;

        const fontSize = this._settings.get_int('font-size');
        const maxWidth = this._settings.get_int('max-width');
        const color = this._settings.get_string('label-color');

        let style = `font-size: ${fontSize}px; max-width: ${maxWidth}px;`;
        if (color && color.length > 0)
            style += ` color: ${color};`;

        this._label.set_style(style);

        // 前缀也跟随字体大小
        if (this._prefixLabel) {
            let prefixStyle = `font-size: ${fontSize}px;`;
            if (color && color.length > 0)
                prefixStyle += ` color: ${color};`;
            this._prefixLabel.set_style(prefixStyle);
        }

        // 封面图标大小跟随字体
        if (this._coverIcon)
            this._coverIcon.icon_size = Math.max(fontSize + 2, 14);
    }

    _updatePrefix() {
        if (!this._settings || !this._prefixLabel || !this._coverIcon) return;
        const ptype = this._settings.get_string('prefix-type');
        if (ptype === 'note') {
            this._prefixLabel.show();
            this._coverIcon.hide();
        } else if (ptype === 'cover') {
            this._prefixLabel.hide();
            this._coverIcon.show();
        } else {
            this._prefixLabel.hide();
            this._coverIcon.hide();
        }
    }

    _updateVisibility() {
        if (!this._button || !this._settings) return;
        const hideWhenPaused = this._settings.get_boolean('hide-when-paused');
        const hideWhenClosed = this._settings.get_boolean('hide-when-closed');
        const closedText = this._settings.get_string('closed-text');

        // 是否在线判断：拥有 MPRIS 必然存活；或 HTTP 后端探测存活
        const isOffline = (!this._playerAvailable && !this._mprisProxy);

        if (isOffline || !this._currentSongId) {
            // Player closed or disconnected
            this._button.set_reactive(false); // 不允许点击弹卡片
            if (hideWhenClosed) {
                this._button.hide();
            } else {
                this._button.show();
                this._setLabelText(closedText, false);
                if (this._prefixLabel) this._prefixLabel.hide();
                if (this._coverIcon) this._coverIcon.hide();
            }
            return;
        }

        this._button.set_reactive(true); // 允许点击弹卡片

        if (!this._isPlaying) {
            // Player paused
            if (hideWhenPaused) {
                this._button.hide();
            } else {
                this._button.show();
                const format = this._settings.get_string('paused-format');
                
                if (format === 'custom') {
                    const pausedText = this._settings.get_string('paused-text');
                    this._setLabelText(pausedText, false);
                    if (this._prefixLabel) this._prefixLabel.hide();
                    if (this._coverIcon) this._coverIcon.hide();
                } else {
                    this._updatePrefix();
                    if (format === 'title') {
                        this._setLabelText(this._currentTrackName || 'YPM Lyrics', false);
                    } else if (format === 'title-artist') {
                        const name = this._currentTrackName || 'Unknown';
                        const artist = this._currentTrackArtist || 'Unknown';
                        this._setLabelText(`${name} - ${artist}`, false);
                    }
                    // format === 'lyrics': do nothing, keep existing text
                }
            }
            return;
        }

        // Playing normally
        this._button.show();
        this._updatePrefix();
    }

    _connectSettings() {
        this._settingsChangedIds = [];
        const keys = [
            'font-size', 'max-width', 'animation-duration', 'animation-type',
            'label-color', 'show-translation', 'position', 'position-index',
            'hide-when-paused', 'no-lyrics-format', 'prefix-type',
            'hide-when-closed', 'closed-text', 'paused-format', 'paused-text', 'marquee-speed'
        ];
        for (const key of keys) {
            const id = this._settings.connect(`changed::${key}`, () => {
                if (key === 'position' || key === 'position-index') {
                    this._removeFromPanel();
                    this._addToPanel();
                } else if (key.includes('hide') || key.includes('text') || key.includes('format')) {
                    this._updateVisibility();
                } else if (key === 'prefix-type') {
                    this._updatePrefix();
                    // 如果切换到 cover，尝试加载当前封面
                    if (this._settings.get_string('prefix-type') === 'cover' && this._currentArtUrl)
                        this._loadCoverArt(this._currentArtUrl, this._currentSongId);
                } else if (key === 'no-lyrics-format') {
                    if (this._currentLyrics.length === 0 && this._currentSongId)
                        this._showNoLyricsFallback();
                } else {
                    this._applySettings();
                    if (key === 'show-translation')
                        this._updateLyricDisplay(true);
                }
            });
            this._settingsChangedIds.push(id);
        }
    }

    // ─── 双模式主定时器（100ms / 1000ms） ────────────────────────

    _startMainTimer() {
        if (this._mainTimerId) return;
        this._pollingMode = 'FAST';
        this._pollTickCounter = 0;
        this._pollPlayerState();
        
        this._mainTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            // 所有程序都是利用实际计算出的时间戳
            if (this._isPlaying && this._currentLyrics?.length > 0)
                this._updateLyricDisplay(false);

            this._pollTickCounter++;
            const pollEvery = this._pollingMode === 'FAST' ? 1 : POLL_NORMAL_TICKS;

            if (this._pollTickCounter >= pollEvery) {
                this._pollTickCounter = 0;
                this._pollPlayerState();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopMainTimer() {
        if (this._mainTimerId) {
            GLib.source_remove(this._mainTimerId);
            this._mainTimerId = 0;
        }
    }

    _enterFastMode() {
        if (this._pollingMode === 'FAST') return;
        this._pollingMode = 'FAST';
        this._pollTickCounter = 0;
        this._lastRawProgress = -1; // 忘记旧数据，强制等待下一次翻转以计算准确时间戳
    }

    _enterNormalMode() {
        if (this._pollingMode === 'NORMAL') return;
        this._pollingMode = 'NORMAL';
        this._pollTickCounter = 0;
    }

    _pollPlayerState() {
        if (!this._soupSession) return;
        const message = Soup.Message.new('GET', PLAYER_API);
        if (!message) return;

        this._soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const text = new TextDecoder().decode(bytes.get_data());
                    const json = JSON.parse(text);
                    this._playerAvailable = true;
                    this._handlePlayerState(json);
                } catch (_e) {
                    if (this._playerAvailable || this._currentSongId !== null) {
                        this._playerAvailable = false;
                        this._currentSongId = null;
                        this._currentLyrics = [];
                        this._isPlaying = false;
                        this._updateVisibility();
                        if (this._label) {
                            this._label.set_text('');
                            this._label.opacity = 0;
                        }
                    }
                }
            },
        );
    }

    _handlePlayerState(json) {
        if (!json) return;

        const rawProgress = json.progress ?? 0;
        const now = GLib.get_monotonic_time();
        const newProgressMs = Math.round(rawProgress * 1000);
        const wasPlaying = this._isPlaying;

        // 如果刚好是重新计算/初次启动，强行捕获一个基础时间（等待下一次实质性变化前）
        if (this._lastRawProgress === -1) {
            this._lastRawProgress = rawProgress;
            this._lastProgressChangeTime = now;
            if (this._anchorTimestamp === 0) {
                this._anchorMs = newProgressMs;
                this._anchorTimestamp = now;
            }
            return;
        }

        const progressChanged = Math.abs(rawProgress - this._lastRawProgress) > 0.01;

        if (this._pollingMode === 'NORMAL') {
            // 正常以 1000ms 频率查询
            if (!progressChanged) {
                // 如果进度超过一秒查询了一次还没变 -> 暂停了 (仅当无 MPRIS 监管时适用)
                if (!this._mprisProxy) {
                    this._enterFastMode();
                }
            } else {
                const expectedMs = this._anchorMs + (now - this._anchorTimestamp) / 1000;
                const driftMs = Math.abs(newProgressMs - expectedMs);       // 动态校准：与我们时间戳的相差
                const stepMs = Math.abs(rawProgress - this._lastRawProgress) * 1000; // 前后两次变更的跨度
                
                // 如果相差太大，或者前后查询进度跨度超过平滑的1秒 (拖动)，则重新校准
                if (driftMs > MAX_DRIFT_MS || Math.abs(stepMs - 1000) > 800) {
                    this._enterFastMode();
                } else {
                    this._lastProgressChangeTime = now;
                }
            }
        }

        if (this._pollingMode === 'FAST') {
            if (progressChanged) {
                // 成功捕捉到前后两次变化！由于现在是 100ms 间隔，此时捕捉的时间误差极其接近实际
                // 计算出误差在 100ms 内的实际时间戳
                this._anchorMs = newProgressMs;
                this._anchorTimestamp = now - 50000; // 最完美中点校准
                this._lastProgressChangeTime = now;
                this._isPlaying = true;
                this._enterNormalMode();
            } else {
                // 如果连续 100ms 查询，1.5 秒始终没发生过数值改变，那就是暂停状态
                if (!this._mprisProxy) {
                    const timeSinceChangeUs = now - this._lastProgressChangeTime;
                    if (timeSinceChangeUs > PAUSE_TIMEOUT_US && this._isPlaying) {
                        // 精准判定：歌曲在 _lastRawProgress 时刻就停了！
                        this._anchorMs = Math.round(this._lastRawProgress * 1000);
                        this._anchorTimestamp = 0; // 冻结状态
                        this._isPlaying = false;
                    }
                }
            }
        }

        this._lastRawProgress = rawProgress;

        if (this._isPlaying !== wasPlaying) {
            if (this._isPlaying) {
                this._enterFastMode();
            } else {
                this._updateLyricDisplay(true);
            }
            this._updateVisibility();
        }

        // ── 歌曲信息 ──
        const trackId = json.currentTrack?.id;
        if (!trackId) {
            if (this._currentSongId !== null) {
                this._currentSongId = null;
                this._currentLyrics = [];
                this._isPlaying = false;
                this._updateVisibility();
                if (this._label) {
                    this._label.set_text('');
                    this._label.opacity = 0;
                }
            }
            return;
        }

        const songId = String(trackId);

        // ── 歌曲切换 ──
        if (songId !== this._currentSongId) {
            this._currentSongId = songId;
            this._currentIndex = -1;
            this._currentLyrics = [];
            this._currentTLyrics = [];
            this._lastAnimText = '';

            this._currentTrackName = json.currentTrack?.name || '';
            const artists = json.currentTrack?.ar;
            this._currentTrackArtist = Array.isArray(artists)
                ? artists.map(a => a.name).filter(Boolean).join(' / ')
                : '';

            // 专辑封面 & 卡片弹窗信息更新
            let artUrl = json.currentTrack?.al?.picUrl || '';
            if (artUrl) {
                artUrl = artUrl.replace(/\?param=\d+y\d+/, '');
                this._currentArtUrl = `${artUrl}?param=500y500`; // 高清参数
            } else {
                this._currentArtUrl = '';
            }

            if (this._currentArtUrl) {
                this._loadCoverArt(this._currentArtUrl, songId, true);
            }

            if (this._menuTitle && this._menuArtist) {
                this._menuTitle.set_text(this._currentTrackName || 'Unknown Title');
                this._menuArtist.set_text(this._currentTrackArtist || 'Unknown Artist');
            }

            this._setLabelText(this._currentTrackName || '加载中…', true);
            this._fetchLyrics(songId);
        }
    }

    // ─── MPRIS DBus Integration (0ms latency pause detect) ───────────

    _watchMpris() {
        this._dbusProxy = new Gio.DBusProxy({
            g_connection: Gio.DBus.session,
            g_name: 'org.freedesktop.DBus',
            g_object_path: '/org/freedesktop/DBus',
            g_interface_name: 'org.freedesktop.DBus'
        });
        
        this._dbusProxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, res) => {
            try {
                proxy.init_finish(res);
                this._dbusProxy.connectSignal('NameOwnerChanged', (p, sender, [name, oldOwner, newOwner]) => {
                    if (name.startsWith('org.mpris.MediaPlayer2.yesplaymusic')) {
                        if (newOwner) {
                            this._connectYpmMpris(name);
                        } else if (name === this._mprisName) {
                            this._disconnectYpmMpris();
                        }
                    }
                });
                
                this._dbusProxy.call('ListNames', null, Gio.DBusCallFlags.NONE, -1, null, (p, r) => {
                    try {
                        const names = p.call_finish(r).deep_unpack()[0];
                        for (const n of names) {
                            if (n.startsWith('org.mpris.MediaPlayer2.yesplaymusic')) {
                                this._connectYpmMpris(n);
                                break;
                            }
                        }
                    } catch(e) {}
                });
            } catch(e) { }
        });
    }

    _disconnectYpmMpris() {
        this._mprisProxy = null;
        this._mprisName = null;
    }

    _connectYpmMpris(name) {
        if (this._mprisProxy) return;
        this._mprisName = name;
        this._mprisProxy = new Gio.DBusProxy({
            g_connection: Gio.DBus.session,
            g_name: name,
            g_object_path: '/org/mpris/MediaPlayer2',
            g_interface_name: 'org.mpris.MediaPlayer2.Player'
        });
        this._mprisProxy.init_async(GLib.PRIORITY_DEFAULT, null, (p, r) => {
            try {
                p.init_finish(r);
                this._checkMprisState(); // Check immediately
                this._mprisProxy.connect('g-properties-changed', () => {
                    this._checkMprisState();
                });
            } catch(e) {}
        });
    }
    
    _checkMprisState() {
        if (!this._mprisProxy) return;
        const statusVar = this._mprisProxy.get_cached_property('PlaybackStatus');
        if (statusVar) {
            const status = statusVar.unpack();
            const isPlaying = (status === 'Playing');
            
            if (this._isPlaying !== isPlaying) {
                if (!isPlaying) {
                    // BEFORE setting isPlaying false, calculate the exact current ms
                    // This freezes the anchor exactly at the moment of pause!
                    this._anchorMs = this._getCurrentPositionMs();
                    this._anchorTimestamp = 0; 
                }
                
                this._isPlaying = isPlaying;
                if (isPlaying) {
                    this._enterFastMode();
                } else {
                    this._updateLyricDisplay(true);
                }
                this._updateVisibility();
            }
        }
    }

    // ─── Lyrics Fetching ─────────────────────────────────────────────

    _fetchLyrics(songId) {
        if (this._lyricsCache?.has(songId)) {
            const cached = this._lyricsCache.get(songId);
            this._currentLyrics = cached.lrc;
            this._currentTLyrics = cached.tlrc;
            this._currentIndex = -1;
            this._lastAnimText = '';
            if (cached.lrc.length === 0)
                this._showNoLyricsFallback();
            return;
        }

        const uri = `${LYRIC_API}${songId}`;
        const message = Soup.Message.new('GET', uri);
        if (!message) return;

        this._soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const text = new TextDecoder().decode(bytes.get_data());
                    const json = JSON.parse(text);

                    const lrcStr = json?.lrc?.lyric || '';
                    const tlrcStr = json?.tlyric?.lyric || '';
                    const lrc = parseLRC(lrcStr);
                    const tlrc = parseLRC(tlrcStr);

                    this._lyricsCache?.set(songId, { lrc, tlrc });

                    if (this._currentSongId === songId) {
                        this._currentLyrics = lrc;
                        this._currentTLyrics = tlrc;
                        this._currentIndex = -1;
                        this._lastAnimText = '';

                        if (lrc.length === 0)
                            this._showNoLyricsFallback();
                    }
                } catch (e) {
                    log(`YPM Lyrics: Failed to fetch lyrics: ${e.message}`);
                    if (this._currentSongId === songId)
                        this._showNoLyricsFallback();
                }
            },
        );
    }

    _showNoLyricsFallback() {
        const fmt = this._settings?.get_string('no-lyrics-format') ?? 'title-artist';
        let text = '';
        if (fmt === 'title-artist') {
            text = this._currentTrackName || '';
            if (this._currentTrackArtist)
                text += ` - ${this._currentTrackArtist}`;
        } else if (fmt === 'title') {
            text = this._currentTrackName || '';
        }
        if (text) {
            this._setLabelText(text, true);
        } else {
            if (this._label) {
                this._label.set_text('');
                this._label.opacity = 0;
            }
        }
    }

    // ─── Cover Art ───────────────────────────────────────────────────

    _loadCoverArt(url, songId, updateMenu = false) {
        if (!this._soupSession) return;

        // 检查缓存
        if (this._coverCache?.has(songId)) {
            const path = this._coverCache.get(songId);
            try {
                const gicon = Gio.FileIcon.new(Gio.File.new_for_path(path));
                if (this._settings?.get_string('prefix-type') === 'cover' && this._coverIcon)
                    this._coverIcon.set_gicon(gicon);
                if (updateMenu && this._menuCover)
                    this._menuCover.set_gicon(gicon);
            } catch (_e) { /* ignore */ }
            return;
        }

        const message = Soup.Message.new('GET', url);
        if (!message) return;

        this._soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const tmpPath = `/tmp/ypm-lyrics-cover-${songId}.jpg`;
                    const file = Gio.File.new_for_path(tmpPath);
                    file.replace_contents(bytes.get_data(), null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null);

                    this._coverCache?.set(songId, tmpPath);

                    // 限制缓存大小：超过 20 则删除最早的
                    if (this._coverCache && this._coverCache.size > 20) {
                        const firstKey = this._coverCache.keys().next().value;
                        const firstPath = this._coverCache.get(firstKey);
                        this._coverCache.delete(firstKey);
                        try { Gio.File.new_for_path(firstPath).delete(null); } catch (_e) { /* ok */ }
                    }

                    // 仍在同一首歌时才设置图标
                    if (this._currentSongId === songId) {
                        const gicon = Gio.FileIcon.new(file);
                        if (this._settings?.get_string('prefix-type') === 'cover' && this._coverIcon)
                            this._coverIcon.set_gicon(gicon);
                        if (updateMenu && this._menuCover)
                            this._menuCover.set_gicon(gicon);
                    }
                } catch (e) {
                    log(`YPM Lyrics: Failed to load cover art: ${e.message}`);
                }
            },
        );
    }

    // ─── Position ─────────────────────────────────────────────────────

    _getCurrentPositionMs() {
        // 如果处于暂停状态，停止插值，直接返回冻结的锚点值
        if (!this._isPlaying) {
            return this._anchorMs;
        }

        // 播放中：从完全精准的翻转锚点开始进行单调时钟线性插值
        if (this._anchorTimestamp > 0) {
            const now = GLib.get_monotonic_time();
            const elapsedUs = now - this._anchorTimestamp;
            return this._anchorMs + elapsedUs / 1000;
        }
        return this._anchorMs;
    }

    _updateLyricDisplay(forceUpdate) {
        if (!this._currentLyrics || this._currentLyrics.length === 0) return;

        const posMs = this._getCurrentPositionMs();
        const idx = findLyricIndex(this._currentLyrics, posMs);

        if (idx === this._currentIndex && !forceUpdate) return;
        this._currentIndex = idx;

        if (idx < 0) {
            this._setLabelText(this._currentTrackName || '…', true);
            return;
        }

        let text = this._currentLyrics[idx].text;

        if (this._settings?.get_boolean('show-translation') && this._currentTLyrics.length > 0) {
            const tIdx = findLyricIndex(this._currentTLyrics, posMs);
            if (tIdx >= 0 && this._currentTLyrics[tIdx].text)
                text += `  ${this._currentTLyrics[tIdx].text}`;
        }

        this._animateTo(text);
    }

    // ─── Animation ───────────────────────────────────────────────────

    _updateBinWidthAndMarquee(newText, duration) {
        if (!this._label || !this._bin || !this._settings) return;

        this._label.remove_transition('translation-x');
        this._label.translation_x = 0;
        if (this._marqueeTimeoutId) {
            GLib.source_remove(this._marqueeTimeoutId);
            this._marqueeTimeoutId = 0;
        }

        const maxWidth = this._settings.get_int('max-width');
        const [minW, natW] = this._label.get_preferred_width(-1);
        const targetWidth = Math.min(natW, maxWidth);

        // 宽度平滑过渡
        if (duration > 0) {
            this._bin.ease({
                width: targetWidth,
                duration: duration * 1.5, // 消除抽动感
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._bin.set_width(targetWidth);
        }

        // 走马灯滚动
        const speed = this._settings.get_int('marquee-speed');
        if (natW > maxWidth && speed > 0 && this._isPlaying) {
            const distance = natW - maxWidth + 40; // 40px padding at the end
            const marqueeDuration = (distance / speed) * 1000;
            const waitTime = 2000;

            const startMarquee = () => {
                if (!this._label || this._label.text !== newText || !this._isPlaying) return;
                this._label.ease({
                    translation_x: -distance,
                    duration: marqueeDuration,
                    mode: Clutter.AnimationMode.LINEAR,
                    onComplete: () => {
                        if (!this._label || this._label.text !== newText) return;
                        this._label.translation_x = 0;
                        this._marqueeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, waitTime, () => {
                            this._marqueeTimeoutId = 0;
                            startMarquee();
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                });
            };

            this._marqueeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, waitTime, () => {
                this._marqueeTimeoutId = 0;
                startMarquee();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _animateTo(newText) {
        if (!this._label) return;
        // 文本相同则跳过
        if (newText === this._lastAnimText) return;
        this._lastAnimText = newText;

        const animType = this._settings?.get_string('animation-type') ?? 'fade-slide';
        const animDur = this._settings?.get_int('animation-duration') ?? 300;

        // 设置无动画但重置锁
        if (animType === 'none' || animDur <= 0) {
            this._label.remove_all_transitions();
            this._label.set_text(newText);
            this._label.opacity = 255;
            this._label.translation_y = 0;
            this._label.set_scale(1, 1);
            this._label.rotation_angle_x = 0;
            return;
        }

        // 取消进行中的动画
        if (this._animTimeoutId) {
            GLib.source_remove(this._animTimeoutId);
            this._animTimeoutId = 0;
        }
        this._label.remove_all_transitions();

        const halfDur = Math.max(Math.round(animDur / 2), 20);
        const useFade = animType === 'fade' || animType === 'fade-slide';
        const useSlide = animType === 'slide' || animType === 'fade-slide';
        const useScale = animType === 'scale';
        const useFlip = animType === 'flip';

        // ── Phase 1: 当前文本动画退出 ──
        this._label.save_easing_state();
        this._label.set_easing_duration(halfDur);
        this._label.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
        if (useFade || useScale || useFlip) this._label.opacity = 0;
        if (useSlide) this._label.translation_y = -6;
        if (useScale) {
            this._label.set_pivot_point(0.5, 0.5);
            this._label.set_scale(0.85, 0.85);
        }
        if (useFlip) {
            this._label.set_pivot_point(0.5, 0.5);
            this._label.rotation_angle_x = 90;
        }
        this._label.restore_easing_state();

        // ── Phase 2: 设置新文本并动画进入 ──
        this._animTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, halfDur + 5, () => {
            this._animTimeoutId = 0;
            if (!this._label || !this._bin) return GLib.SOURCE_REMOVE;

            this._label.set_text(newText);

            this._label.remove_all_transitions();

            // 设置进入起始状态
            if (useFade || useScale || useFlip) this._label.opacity = 0;
            if (useSlide) this._label.translation_y = 6;
            if (useScale) {
                this._label.set_pivot_point(0.5, 0.5);
                this._label.set_scale(1.15, 1.15);
            }
            if (useFlip) {
                this._label.set_pivot_point(0.5, 0.5);
                this._label.rotation_angle_x = -90;
            }

            // 进入动画
            this._label.save_easing_state();
            this._label.set_easing_duration(halfDur);
            this._label.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
            this._label.opacity = 255;
            this._label.translation_y = 0;
            if (useScale) this._label.set_scale(1, 1);
            if (useFlip) this._label.rotation_angle_x = 0;
            this._label.restore_easing_state();

            return GLib.SOURCE_REMOVE;
        });
    }

    _setLabelText(text, fadeIn) {
        if (!this._label || !this._bin) return;

        if (this._animTimeoutId) {
            GLib.source_remove(this._animTimeoutId);
            this._animTimeoutId = 0;
        }
        
        this._label.remove_all_transitions();
        this._label.set_text(text);
        this._label.translation_y = 0;
        this._label.set_scale(1, 1);
        this._label.rotation_angle_x = 0;
        this._lastAnimText = text;

        if (fadeIn) {
            const animDur = this._settings?.get_int('animation-duration') ?? 300;
            
            if (animDur > 0 && this._label.opacity < 200) {
                this._label.opacity = 0;
                this._label.save_easing_state();
                this._label.set_easing_duration(animDur);
                this._label.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
                this._label.opacity = 255;
                this._label.restore_easing_state();
            } else {
                this._label.opacity = 255;
            }
        } else {
            this._label.opacity = 255;
        }
    }
}
