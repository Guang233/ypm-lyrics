# YPM Lyrics - GNOME Shell Extension

为 [YesPlayMusic](https://github.com/qier222/YesPlayMusic) 量身打造的 GNOME 顶栏歌词扩展。在 Linux 的桌面上，用最优雅、流畅的方式浏览你最爱的音乐歌词。

## ✨ 特性 (Features)

* **极致同步 (Zero Latency Sync)**：深度整合 MPRIS D-Bus 与 HTTP API 双引擎。不仅有基于时间的平滑逐字滚动，更能在你按下“暂停”或“切换”的 0 毫秒内瞬间捕获并冻结，告别歌词延迟与闪烁！
* **精美播放卡片 (Now Playing Card)**：点击顶栏歌词即可丝滑展开下拉面板。内置高清 500x500 级、带柔和圆角的网易云专辑封面与歌曲信息。
* **丰富自定义动画 (Rich Animations)**：内置淡入淡出 (Fade)、微移滑动 (Slide)、缩放 (Scale)、以及极具科幻感的 3D 翻转 (Flip) 等多种进退场动画供你选择！
* **可控的空状态 (Custom Empty State)**：自由决定在暂停或彻底关闭 YesPlayMusic 时屏幕上该出现什么。是隐藏起来保持纯净，还是用指定的 `YPM Lyrics` 撑起牌面？皆由你定！
* **性能守护 (Performance First)**：采用严格的多段轮循策略与 Clutter Native Animation，不仅肉眼观感丝滑如呼吸，更是极致省电。

## 📥 安装 (Installation)

### 选项 1: 从源码手动安装
1. 克隆本仓库到你的 GNOME Extensions 目录：
   ```bash
   git clone https://github.com/Guang233/ypm-lyrics.git ~/.local/share/gnome-shell/extensions/ypm-lyrics@guang.local
   ```
2. 编译 GSettings schemas：
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/ypm-lyrics@guang.local/schemas/
   ```
3. 重启 GNOME Shell：
   * 在 X11 下，按 `Alt+F2` 输入 `r` 然后回车。
   * 在 Wayland 下，注销并重新登录。
4. 在“扩展 (Extensions)”应用中启用 `YPM Lyrics`。

### 选项 2: E.G.O (GNOME Extensions 官网)
*(敬请期待)*

## ⚙️ 依赖项 (Dependencies)
* [YesPlayMusic](https://github.com/qier222/YesPlayMusic) 本地客户端。

## 🔧 常见问题

* **没有显示封面缩略图？** 请确保您的系统已经正确支持 `/tmp` 读写，且 YesPlayMusic 能正常返回 `mpris:artUrl`。
* **无法获取到歌词？** 请确认 YesPlayMusic 已打开且正在播放，由于本地接口原因暂时不支持纯网页版。

## 📜 许可 (License)
基于 **GPL-2.0** 协议开源。欢迎 Fork 并提交 PR！
