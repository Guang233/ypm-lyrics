/* prefs.js — YPM Lyrics 设置界面
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class YpmLyricsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'YPM Lyrics',
            icon_name: 'audio-x-generic-symbolic',
        });
        window.add(page);

        // ─── 显示设置 ────────────────────────────────────────────────
        const displayGroup = new Adw.PreferencesGroup({
            title: '显示设置',
            description: '调整歌词在顶栏中的外观',
        });
        page.add(displayGroup);

        // 字体大小
        const fontSizeRow = new Adw.SpinRow({
            title: '字体大小',
            subtitle: '歌词文字大小（像素）',
            adjustment: new Gtk.Adjustment({
                lower: 8, upper: 32,
                step_increment: 1, page_increment: 2,
                value: settings.get_int('font-size'),
            }),
        });
        settings.bind('font-size', fontSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(fontSizeRow);

        // 最大宽度
        const maxWidthRow = new Adw.SpinRow({
            title: '最大宽度',
            subtitle: '歌词标签最大宽度（像素）',
            adjustment: new Gtk.Adjustment({
                lower: 100, upper: 1200,
                step_increment: 50, page_increment: 100,
                value: settings.get_int('max-width'),
            }),
        });
        settings.bind('max-width', maxWidthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(maxWidthRow);

        // 自定义颜色
        const colorRow = new Adw.EntryRow({
            title: '自定义颜色',
            text: settings.get_string('label-color'),
        });
        colorRow.add_suffix(this._createHint('留空=主题色'));
        colorRow.connect('changed', () => {
            settings.set_string('label-color', colorRow.get_text());
        });
        displayGroup.add(colorRow);

        // 前缀类型
        const prefixModel = new Gtk.StringList();
        prefixModel.append('无');
        prefixModel.append('♪ 音符');
        prefixModel.append('专辑封面');

        const prefixRow = new Adw.ComboRow({
            title: '歌词前缀',
            subtitle: '歌词文字前面显示的图标',
            model: prefixModel,
        });
        const prefixValues = ['none', 'note', 'cover'];
        const prefixIdx = prefixValues.indexOf(settings.get_string('prefix-type'));
        prefixRow.set_selected(prefixIdx >= 0 ? prefixIdx : 1);
        prefixRow.connect('notify::selected', () => {
            settings.set_string('prefix-type', prefixValues[prefixRow.get_selected()]);
        });
        displayGroup.add(prefixRow);

        // ─── 位置设置 ────────────────────────────────────────────────
        const posGroup = new Adw.PreferencesGroup({
            title: '位置设置',
            description: '歌词在顶栏中的位置',
        });
        page.add(posGroup);

        // 顶栏区域
        const posModel = new Gtk.StringList();
        posModel.append('左侧 (left)');
        posModel.append('中部 (center)');
        posModel.append('右侧 (right)');

        const posRow = new Adw.ComboRow({
            title: '顶栏区域',
            subtitle: '歌词所在的顶栏区域',
            model: posModel,
        });
        const posValues = ['left', 'center', 'right'];
        const posIdx = posValues.indexOf(settings.get_string('position'));
        posRow.set_selected(posIdx >= 0 ? posIdx : 1);
        posRow.connect('notify::selected', () => {
            settings.set_string('position', posValues[posRow.get_selected()]);
        });
        posGroup.add(posRow);

        // 位置索引
        const posIndexRow = new Adw.SpinRow({
            title: '位置索引',
            subtitle: 'center 区域：0=时钟左边，1=时钟右边',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 10,
                step_increment: 1, page_increment: 1,
                value: settings.get_int('position-index'),
            }),
        });
        settings.bind('position-index', posIndexRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        posGroup.add(posIndexRow);

        // ─── 行为设置 ────────────────────────────────────────────────
        const behaviorGroup = new Adw.PreferencesGroup({
            title: '行为设置',
            description: '播放行为与歌词显示',
        });
        page.add(behaviorGroup);

        // 显示翻译
        const transRow = new Adw.SwitchRow({
            title: '显示翻译歌词',
            subtitle: '在原歌词后附加翻译',
        });
        settings.bind('show-translation', transRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(transRow);

        // 暂停时隐藏
        const hideRow = new Adw.SwitchRow({
            title: '暂停时隐藏',
            subtitle: '暂停或未播放时不在顶栏显示任何内容',
        });
        settings.bind('hide-when-paused', hideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(hideRow);

        // 未运行时隐藏
        const hideClosedRow = new Adw.SwitchRow({
            title: '未运行时隐藏',
            subtitle: '当网易云音乐未运行时隐藏歌词面板',
        });
        settings.bind('hide-when-closed', hideClosedRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(hideClosedRow);

        // 自定义未运行文本
        const closedTextRow = new Adw.EntryRow({
            title: '未运行状态文字',
            text: settings.get_string('closed-text'),
        });
        closedTextRow.add_suffix(this._createHint('不隐藏时的显示'));
        closedTextRow.connect('changed', () => {
            settings.set_string('closed-text', closedTextRow.get_text());
        });
        behaviorGroup.add(closedTextRow);

        // 暂停时显示格式
        const pausedFormatModel = new Gtk.StringList();
        pausedFormatModel.append('自定义文字');     // custom
        pausedFormatModel.append('停留在当前歌词'); // lyrics
        pausedFormatModel.append('仅曲名');       // title
        pausedFormatModel.append('曲名 - 作者');   // title-artist

        const formatMap = ['custom', 'lyrics', 'title', 'title-artist'];
        const formatIndex = formatMap.indexOf(settings.get_string('paused-format'));

        const pausedFormatRow = new Adw.ComboRow({
            title: '暂停时显示内容',
            subtitle: '当选择不隐藏歌词但播放暂停时的显示',
            model: pausedFormatModel,
            selected: formatIndex >= 0 ? formatIndex : 0,
        });

        pausedFormatRow.connect('notify::selected', () => {
            settings.set_string('paused-format', formatMap[pausedFormatRow.selected]);
        });
        behaviorGroup.add(pausedFormatRow);

        // 自定义暂停文本
        const pausedTextRow = new Adw.EntryRow({
            title: '暂停状态自定义文字',
            text: settings.get_string('paused-text'),
        });
        pausedTextRow.add_suffix(this._createHint('仅当选择"自定义文字"时生效'));
        pausedTextRow.connect('changed', () => {
            settings.set_string('paused-text', pausedTextRow.get_text());
        });
        behaviorGroup.add(pausedTextRow);

        // 无歌词显示格式
        const noLyricsModel = new Gtk.StringList();
        noLyricsModel.append('曲名 - 作者');
        noLyricsModel.append('仅曲名');
        noLyricsModel.append('不显示');

        const noLyricsRow = new Adw.ComboRow({
            title: '无歌词时显示',
            subtitle: '纯音乐/无歌词时顶栏显示的内容',
            model: noLyricsModel,
        });
        const nlValues = ['title-artist', 'title', 'none'];
        const nlIdx = nlValues.indexOf(settings.get_string('no-lyrics-format'));
        noLyricsRow.set_selected(nlIdx >= 0 ? nlIdx : 0);
        noLyricsRow.connect('notify::selected', () => {
            settings.set_string('no-lyrics-format', nlValues[noLyricsRow.get_selected()]);
        });
        behaviorGroup.add(noLyricsRow);

        // ─── 动画设置 ────────────────────────────────────────────────
        const animGroup = new Adw.PreferencesGroup({
            title: '动画设置',
            description: '歌词切换动画效果',
        });
        page.add(animGroup);

        // 动画类型
        const animTypeModel = new Gtk.StringList();
        animTypeModel.append('无动画');
        animTypeModel.append('淡入淡出');
        animTypeModel.append('滑动');
        animTypeModel.append('淡入淡出 + 滑动');
        animTypeModel.append('缩放');
        animTypeModel.append('翻转');

        const animTypeRow = new Adw.ComboRow({
            title: '动画类型',
            subtitle: '歌词切换时的过渡效果',
            model: animTypeModel,
        });
        const animValues = ['none', 'fade', 'slide', 'fade-slide', 'scale', 'flip'];
        const animIdx = animValues.indexOf(settings.get_string('animation-type'));
        animTypeRow.set_selected(animIdx >= 0 ? animIdx : 3);
        animTypeRow.connect('notify::selected', () => {
            settings.set_string('animation-type', animValues[animTypeRow.get_selected()]);
        });
        animGroup.add(animTypeRow);

        // 动画时长
        const animDurRow = new Adw.SpinRow({
            title: '动画时长',
            subtitle: '过渡动画时长（毫秒），0=禁用',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1000,
                step_increment: 50, page_increment: 100,
                value: settings.get_int('animation-duration'),
            }),
        });
        settings.bind('animation-duration', animDurRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        animGroup.add(animDurRow);

        // 走马灯速度
        const marqueeSpeedRow = new Adw.SpinRow({
            title: '走马灯滚动速度',
            subtitle: '超过最大宽度时横向滚动的速度（像素/秒），0=禁用。',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 300,
                step_increment: 10, page_increment: 20,
                value: settings.get_int('marquee-speed'),
            }),
        });
        settings.bind('marquee-speed', marqueeSpeedRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        animGroup.add(marqueeSpeedRow);
    }

    _createHint(text) {
        return new Gtk.Label({
            label: text,
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
        });
    }
}
