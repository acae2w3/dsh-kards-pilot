# KARDS 悬浮球手柄（@local/kards-pilot）

给 DeepSeek Harness 装一个悬浮球：**点一下它，当前会话的智能体就被唤醒进入 KARDS 对局**，
并且真的能看屏幕、移鼠标、点牌、按键盘 —— 不是模拟器，是这台电脑上的真实鼠标。

## 它给了智能体什么

| 工具 | 作用 |
|---|---|
| `kards_windows` | 列出窗口（标题 / pid / 位置尺寸 / 谁在前台 / 是否最小化）＋ 虚拟屏幕尺寸与光标位置。先用它找 KARDS 窗口。 |
| `kards_screen` | 截屏（整屏或指定窗口，后者会先把该窗口提到前台）并以**图片**返回，同时给出「图片像素 ↔ 屏幕像素」的换算关系。 |
| `kards_act` | 真实移动鼠标并 `click / double_click / right_click / drag / move / wheel / key / focus / wait`；默认动作后**自动附一张新截图**，让智能体当场确认这一步有没有生效。 |

坐标模型：`kards_act` 的 `x/y` 默认是**最近一次 `kards_screen` 那张图的像素**，由插件换算成屏幕坐标
（传 `space:"screen"` 可直接用桌面像素）。智能体只要「看图 → 点图上那个位置」，不用自己算缩放。

## 悬浮球（两处）

**1. 桌面级浮球 `helper/orb.ps1`（打游戏时看这个）**

一个独立的 WinForms 进程：置顶、无边框、圆形，默认贴在屏幕右缘约 1/3 高处，可以拖动，位置记在
`~/.dsh/kards-orb/position.json`。它画在其他窗口之上，所以**全屏打 KARDS 时也看得见、点得到**。

- 单击：唤醒 / 结束对局（插件通过 `~/.dsh/kards-orb/` 下的 `state.json` ⇄ `command.json` 与它对话）。
- 右键：唤醒/结束、切到 Harness 窗口、收起、退出。
- 状态：蓝=空闲、黄=唤醒中、绿=对局中（带脉冲环）、红=出错。
- 单实例（互斥体）：插件启动时会先探测，已有浮球就不重复起；手动起的那个会继续服务。
- 宿主没在监听时（状态文件超过 12 秒没更新），单击会退化成「把 Harness 窗口提到前台」。

**2. 页面内浮球 `client.js`（Harness 窗口里的那颗）**

往 `shell.overlay` 注册，右下角、可拖动。它压不过全屏游戏——游戏挡住 Harness 时就点不到，
所以真正对局时请用上面那颗桌面浮球。

## 安装与生效

```bash
# 在 Harness 里用 plugin_manager：
#   action: install_bundle, target: <本目录绝对路径>
```

⚠️ **客户端产物与 Host 模块都在进程启动时快照**：改过 `client.js` 或 `index.js` 之后要重启一次
Harness 才会生效（只刷新页面不够）。桌面浮球由 Host 半在激活时启动，所以也随重启一起换新。

## 实现

- `index.js`：Host 半。三个工具；截图经 `ctx.attachments.saveImage` 变成持久附件再作为图片块返回。
  另外负责桌面浮球的生命周期与「点球 → `sessionController.prompt` 唤醒当前会话」。
- `helper/kards-helper.ps1`：常驻 PowerShell 进程，stdin/stdout 走 JSON 行协议，负责
  `SetProcessDPIAware`、截屏（GDI+，含高质量缩放与 `PrintWindow` 离屏抓取）、
  `SetCursorPos` + `mouse_event`、`keybd_event`、窗口枚举/打分匹配/还原。
- `helper/orb.ps1`：桌面浮球（见上）。**必须存成 UTF-8 with BOM**，否则 Windows PowerShell 5.1
  会按 ANSI 读中文并解析失败。
- `client.js`：页面内浮球；圆形用 SVG 画，宿主按钮样式改不动它。

## 注意

- 它操作的是**真实桌面**：点击期间鼠标会被插件接管，别同时自己动鼠标。
- 全屏游戏盖住 Harness 窗口时悬浮球点不到，先切回 Harness 点球，球会把游戏窗口重新提到前台。
- 智能体的判断来自它在截图里看到的东西 ＋ 提示词里的规则手册，没有别的取巧通道。
