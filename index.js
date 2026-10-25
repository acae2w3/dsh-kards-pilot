/**
 * KARDS pilot — host half.
 *
 * Registers three model-facing tools that give an agent real eyes and hands on
 * this Windows desktop:
 *
 *   kards_windows  list visible windows + virtual-screen geometry
 *   kards_screen   capture the desktop (or one window) as an image attachment
 *   kards_act      move the mouse / click / drag / scroll / type, optionally
 *                  returning a fresh screenshot of the result
 *
 * All OS work happens in one long-lived PowerShell helper (helper/kards-helper.ps1)
 * speaking newline-delimited JSON, so the DPI awareness, the coordinate space and
 * the process startup cost are paid once instead of per action.
 *
 * @module @local/kards-pilot
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root, so the helper script is found next to this module. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
/** Where captures are written before being committed as attachments. */
const SHOT_DIR = path.join(tmpdir(), 'dsh-kards-pilot')
/** How many capture files to keep on disk. */
const KEEP_SHOTS = 40
/** Fallback capture width when the deployment rejects a larger image. */
const WIDTH_LADDER = [1400, 1100, 900, 720]
/** Fixed rendezvous with the desktop orb, so a hand-started orb keeps serving. */
const ORB_DIR = path.join(homedir(), '.dsh', 'kards-orb')
const ORB_STATE = path.join(ORB_DIR, 'state.json')
const ORB_CMD = path.join(ORB_DIR, 'command.json')
const ORB_POS = path.join(ORB_DIR, 'position.json')

/** The prompt that hands the whole task to the agent. Keep in sync with client.js. */
const PLAYBOOK = [
  '【KARDS 操控任务】用户点了悬浮球，请你现在接管这台电脑上的 KARDS 对局。',
  '',
  '0. 先找窗口：用 kards_windows 找标题含 "kards" 的窗口（可能是最小化的，focus 会把它还原）。找不到就用 pwsh 启动它。找到后 kards_act {action:"focus", window:"kards"} 切到前台，再 kards_screen {window:"kards"} 看画面。',
  '',
  '1. 眼睛和手：kards_screen 返回截图与坐标映射；kards_act 的 x/y 默认就是这张图的像素，工具会换算成屏幕像素。每次点击后工具会自动附上新截图——先看，再决定下一步。点偏了就重新截图重点，不要盲点。',
  '',
  '2. 规则要点（判断依据）：',
  '- 三条战线：己方支援阵线（总部所在，最多 4 个单位）、前线（中立，最多 5 个；一方进入即独占，直到该方前线单位全灭才重新中立）、敌方支援阵线（你进不去，也打不到，只能靠前线打脸）。',
  '- 总部 20 点防御，降到 0 即败。前线单位可以攻击敌方总部；支援阵线的单位只有炮兵/轰炸机能越过前线打纵深。',
  '- 指挥点 Kredits：每回合 +1 槽（自然上限 12），回合开始填满，不保留。部署与移动/攻击共用同一池，单位上手后卡面只显示行动花费——想当回合就动它，得预留行动点。',
  '- 兵种：步兵（须到前线才能打纵深，每回合移动与攻击二选一）；坦克（同回合可先移动再攻击，顺序可调）；炮兵（在支援阵线就能轰敌方支援阵线，不受反击，无视守护）；战斗机（保护同战线其他单位，敌方轰炸机想打该线非战斗机目标必须先处理它）；轰炸机（攻击不受反击、无视守护，但防御时不还手）。',
  '- 能力：闪击=部署即可行动；烟幕=不能被攻击，行动后消失；伏击=每回合首次被攻击时先手反伤；重甲X=受单位攻击减伤 X；钳击=与指定友军互相加成，任一离场即失效。',
  '- 指令立即结算；反制埋伏在对手回合、满足条件时自动触发。',
  '- 抽牌：回合开始抽 1（先手第一回合不抽），手牌上限 9。牌库抽空后每抽一次总部受 1、2、3… 疲劳伤害，无法减免——拖后期要盯着剩余牌数。',
  '- 开局：先手 4 张起手且首回合不抽；后手 5 张且首回合抽 1；双方各有一次调度。调度时留低费单位与早期解牌，弃掉高费与用不上的指令。',
  '',
  '3. 一个回合的固定流程：看场面 → 定目标（抢前线 / 清场 / 打脸）→ 按指挥点排出牌顺序 → 逐张操作并确认生效 → 确认资源用尽 → 点「结束回合」。出牌一般是「点手牌 → 点目标位置或目标单位」。',
  '',
  '4. 纪律：',
  '- 每次操作后都要看新截图确认生效；没反应就重试或换点位。',
  '- 没看清对方总部防御和前线归属之前，不要盲目冲脸。',
  '- 界面卡在动画/弹窗：kards_act {action:"wait", ms:1500} 再截图。',
  '- 对局结束（胜利或失败画面）后，用一两句话向用户汇报结果与关键转折，然后停止操作。',
  '- 真的看不懂界面时，截一张图并说明卡在哪，不要乱点。',
  '',
  '现在开始：先 kards_windows。',
].join('\n')

export const name = 'kards-pilot'
export const inject = ['tools', 'attachments']

/**
 * One PowerShell helper process with a serialized request queue.
 * A crashed or timed-out helper is replaced on the next call.
 */
class Shell {
  /** @param {string} script absolute path of the helper script. */
  constructor(script) {
    this.script = script
    this.child = undefined
    this.pending = new Map()
    this.nextId = 1
    this.chain = Promise.resolve()
    this.stderr = ''
  }

  /** Start the helper if it is not running. */
  ensure() {
    if (this.child) return
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.script,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4096)
    })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        waiter.done()
        if (message.ok) waiter.resolve(message.data)
        else waiter.reject(new Error(String(message.error ?? 'helper failure')))
      }
    })
    const fail = (reason) => {
      this.child = undefined
      for (const [, waiter] of this.pending) {
        waiter.done()
        waiter.reject(new Error(reason))
      }
      this.pending.clear()
    }
    child.on('error', (error) => fail(`helper could not start: ${error.message}`))
    child.on('exit', (code) => fail(`helper exited (code ${String(code)})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`))
  }

  /**
   * Run one helper operation.
   * @param {string} op helper operation name.
   * @param {Record<string, unknown>} params operation parameters.
   * @param {number} timeoutMs how long to wait before replacing the helper.
   * @returns {Promise<any>} the operation payload.
   */
  call(op, params = {}, timeoutMs = 25000) {
    const run = async () => {
      this.ensure()
      const child = this.child
      if (!child) throw new Error('helper is not running')
      const id = this.nextId++
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`helper timed out after ${timeoutMs}ms on '${op}'`))
          this.dispose()
        }, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        this.pending.set(id, {
          resolve,
          reject,
          done: () => clearTimeout(timer),
        })
        try {
          child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`)
        } catch (error) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(new Error(`could not reach the helper: ${error.message}`))
        }
      })
    }
    const result = this.chain.then(run, run)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  /** Stop the helper, releasing the OS process. */
  dispose() {
    const child = this.child
    this.child = undefined
    if (!child) return
    try {
      child.stdin.end()
    } catch { /* already gone */ }
    try {
      child.kill()
    } catch { /* already gone */ }
  }
}

/** JSON Schema fragments shared by the capture-shaped outputs. */
const IMAGE_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
    },
  },
}

/**
 * Human/model-facing summary of one capture: where it came from, how image
 * pixels map back onto the desktop, and the exact screen region it covers.
 * @param {Record<string, any>} value capture outcome.
 * @returns {string} the text envelope placed beside the image block.
 */
function describeCapture(value) {
  const screen = value.screen
  const lines = [
    `<kards_screen>`,
    `image: ${value.imageWidth}x${value.imageHeight} px (${value.path})`,
    `screen region: x=${value.regionX} y=${value.regionY} w=${value.regionWidth} h=${value.regionHeight}`,
    `virtual screen: ${screen.width}x${screen.height} at (${screen.x},${screen.y})`,
    `mapping: screen_x = ${value.regionX} + image_x * ${Number(value.scaleX).toFixed(4)}; screen_y = ${value.regionY} + image_y * ${Number(value.scaleY).toFixed(4)}`,
    `kards_act(x, y) accepts THESE image pixels by default (space:"image"); pass space:"screen" for desktop pixels.`,
    `</kards_screen>`,
  ]
  return lines.join('\n')
}

/** Convert one stored image reference into the JSON value carried by the output. */
function imageValue(ref) {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined
      ? {}
      : { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }),
  }
}

/**
 * Delete the oldest captures so the temp directory cannot grow without bound.
 * @param {string} except the file just written.
 */
function pruneShots(except) {
  try {
    const entries = readdirSync(SHOT_DIR)
      .filter((entry) => entry.endsWith('.png') && path.join(SHOT_DIR, entry) !== except)
      .map((entry) => {
        const full = path.join(SHOT_DIR, entry)
        return { full, at: statSync(full).mtimeMs }
      })
      .sort((a, b) => b.at - a.at)
    for (const stale of entries.slice(KEEP_SHOTS - 1)) {
      try {
        rmSync(stale.full, { force: true })
      } catch { /* best effort */ }
    }
  } catch { /* the directory may not exist yet */ }
}

/**
 * Register the KARDS tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx owning plugin context.
 */
export function apply(ctx) {
  mkdirSync(SHOT_DIR, { recursive: true })
  const shell = new Shell(path.join(PACKAGE_ROOT, 'helper', 'kards-helper.ps1'))
  /** Last capture per agent, so clicked coordinates can default to image pixels. */
  const captures = new Map()
  let shotSeq = 0

  ctx.effect(() => () => {
    shell.dispose()
    captures.clear()
  }, 'kards-pilot helper')

  // ---- desktop floating ball ---------------------------------------------
  /** Publish the ball's phase; the orb repaints from this file. */
  const writeOrbState = (phase, label) => {
    try {
      mkdirSync(ORB_DIR, { recursive: true })
      writeFileSync(ORB_STATE, JSON.stringify({ phase, label: label ?? '', at: Date.now() }))
    } catch { /* the orb may not be running */ }
  }

  /** True when another orb process already holds the single-instance mutex. */
  const orbAlreadyRunning = () => new Promise((resolve) => {
    const probe = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$m=New-Object System.Threading.Mutex($false,'Local\\dsh-kards-orb'); if($m.WaitOne(0)){ $m.ReleaseMutex(); exit 1 } else { exit 0 }",
    ], { windowsHide: true, stdio: 'ignore' })
    probe.on('error', () => resolve(false))
    probe.on('exit', (code) => resolve(code === 0))
  })

  let orbChild
  /** Start the desktop ball unless one is already running. */
  const spawnOrb = async () => {
    if (orbChild) return
    const script = path.join(PACKAGE_ROOT, 'helper', 'orb.ps1')
    if (!existsSync(script)) return
    if (await orbAlreadyRunning()) {
      writeOrbState(pilotPhase, pilotLabel)
      return
    }
    mkdirSync(ORB_DIR, { recursive: true })
    orbChild = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-StatePath', ORB_STATE,
      '-CommandPath', ORB_CMD,
      '-PosPath', ORB_POS,
    ], { windowsHide: true, stdio: 'ignore' })
    orbChild.on('exit', () => { orbChild = undefined })
    orbChild.on('error', () => { orbChild = undefined })
    writeOrbState('idle', '进入对局')
  }

  let pilotTarget = null
  let pilotPhase = 'idle'
  let pilotLabel = '进入对局'
  let lastCommandAt = 0
  let idleStreak = 0
  let busy = false

  const setPilotPhase = (phase, label) => {
    pilotPhase = phase
    if (label !== undefined) pilotLabel = label
    writeOrbState(pilotPhase, pilotLabel)
  }

  /** Read a freshly written orb command, remembering the newest handled one. */
  const takeCommand = () => {
    try {
      if (!existsSync(ORB_CMD)) return null
      const parsed = JSON.parse(readFileSync(ORB_CMD, 'utf8'))
      if (!parsed || typeof parsed.at !== 'number' || parsed.at <= lastCommandAt) return null
      lastCommandAt = parsed.at
      return parsed
    } catch {
      return null
    }
  }

  /** Wake the most recently active top-level session with the playbook. */
  const wakePilot = async () => {
    const sessions = ctx.get('sessionController')
    if (!sessions) throw new Error('会话服务不可用，无法唤醒')
    setPilotPhase('waking', '唤醒中…')
    const signal = new AbortController().signal
    const list = await sessions.list({}, signal)
    const items = Array.isArray(list && list.items) ? list.items : []
    const remembered = items.find((item) => item.sessionId === pilotTarget)
    const roots = items.filter((item) => item.origin !== 'subagent' && !item.parentSessionId)
    const target = (remembered || roots[0] || items[0] || {}).sessionId
    if (!target) throw new Error('没有可用的会话')
    await sessions.prompt({
      requestId: `kards-${Date.now().toString(36)}`,
      sessionId: target,
      mode: 'queue',
      content: [{ type: 'text', text: PLAYBOOK }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, signal)
    pilotTarget = target
    idleStreak = 0
    setPilotPhase('active', '结束对局')
  }

  /** Cancel the pilot turn and go back to idle. */
  const stopPilot = async () => {
    const sessions = ctx.get('sessionController')
    setPilotPhase('idle', '进入对局')
    if (!sessions || !pilotTarget) return
    try {
      sessions.cancel({ sessionId: pilotTarget })
    } catch { /* already idle */ }
  }

  /** Keep the ball honest about whether the agent's turn is still running. */
  const refreshPilot = async () => {
    const sessions = ctx.get('sessionController')
    if (!sessions || !pilotTarget) return
    const list = await sessions.list({}, new AbortController().signal)
    const items = Array.isArray(list && list.items) ? list.items : []
    const item = items.find((entry) => entry.sessionId === pilotTarget)
    if (item && item.running === true) {
      idleStreak = 0
      if (pilotPhase !== 'active') setPilotPhase('active', '结束对局')
      return
    }
    idleStreak += 1
    if (idleStreak >= 2 && pilotPhase === 'active') setPilotPhase('idle', '进入对局')
  }

  ctx.effect(() => {
    let disposed = false
    let ticks = 0
    spawnOrb().catch(() => {})
    const timer = setInterval(async () => {
      if (disposed || busy) return
      const command = takeCommand()
      if (command) {
        busy = true
        try {
          if (command.action === 'stop' || (command.action === 'toggle' && pilotPhase === 'active')) await stopPilot()
          else await wakePilot()
        } catch (error) {
          setPilotPhase('error', String((error && error.message) || error).slice(0, 64))
        } finally {
          busy = false
        }
        return
      }
      ticks += 1
      if (ticks % 7 === 0) writeOrbState(pilotPhase, pilotLabel)
      if (pilotPhase === 'active' && ticks % 4 === 0) {
        try { await refreshPilot() } catch { /* transient */ }
      }
      if (pilotPhase === 'error' && ticks % 20 === 0) setPilotPhase('idle', '进入对局')
    }, 700)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      disposed = true
      clearInterval(timer)
      if (orbChild) {
        try { orbChild.kill() } catch { /* gone */ }
        orbChild = undefined
      }
    }
  }, 'kards-pilot orb')

  const attachments = () => {
    const service = ctx.get('attachments')
    if (!service) throw new Error('the attachment service is unavailable, so screenshots cannot be shown')
    return service
  }

  /**
   * Capture one region and commit it as a durable image attachment.
   * @param {Record<string, any>} exec tool execution context.
   * @param {{ title?: string, maxWidth?: number }} options capture source and width.
   * @returns {Promise<Record<string, any>>} the structured capture outcome.
   */
  async function capture(exec, options) {
    const service = attachments()
    const limits = service.imageLimits
    const requested = Number.isFinite(options.maxWidth) && options.maxWidth > 0
      ? Math.min(Math.floor(options.maxWidth), limits.maxImageDimension)
      : WIDTH_LADDER[0]
    const width = Math.min(requested, limits.maxImageDimension)
    const ladder = [width, ...WIDTH_LADDER.filter((entry) => entry < width)]
    let lastError
    for (const candidate of ladder) {
      const file = path.join(SHOT_DIR, `kards-${Date.now()}-${shotSeq++}.png`)
      const shot = await shell.call('shot', {
        path: file,
        maxWidth: candidate,
        ...(options.title ? { title: options.title } : {}),
      }, 30000)
      let data
      try {
        data = readFileSync(file)
      } catch (error) {
        throw new Error(`the capture was written but could not be read back: ${error.message}`)
      }
      try {
        const ref = await service.saveImage({ data, mediaType: 'image/png', name: path.basename(file) })
        pruneShots(file)
        const geometry = await shell.call('info', {}, 8000).catch(() => undefined)
        return {
          path: file,
          image: imageValue(ref),
          imageWidth: shot.imageWidth,
          imageHeight: shot.imageHeight,
          regionX: shot.regionX,
          regionY: shot.regionY,
          regionWidth: shot.regionWidth,
          regionHeight: shot.regionHeight,
          scaleX: shot.scaleX,
          scaleY: shot.scaleY,
          screen: geometry ? geometry.screen : { x: 0, y: 0, width: shot.regionWidth, height: shot.regionHeight },
          cursor: geometry ? geometry.cursor : undefined,
        }
      } catch (error) {
        lastError = error
        if (!/TOO_LARGE|TOO_MANY_PIXELS|DIMENSION/i.test(String(error && error.code) + String(error && error.message))) throw error
      }
    }
    throw lastError ?? new Error('the capture could not be stored within the deployment image limits')
  }

  /**
   * Re-label a stored capture block so the model sees the same envelope shape
   * whether the image came from kards_screen or a kards_act follow-up shot.
   * @param {Record<string, any>} value capture outcome.
   * @returns {Array<Record<string, any>>} text envelope plus the image block.
   */
  function captureContent(value) {
    return [
      { type: 'text', text: describeCapture(value) },
      { type: 'image', attachment: value.image },
    ]
  }

  ctx.tools.register({
    name: 'kards_windows',
    description: 'List the visible desktop windows of this Windows machine (title, pid, rectangle, which one is focused) plus the virtual-screen size. Call this first to locate the KARDS game window, or when a screenshot suggests another window is covering the game.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filter: { type: 'string', description: 'Case-insensitive substring; only matching titles are returned.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['screen', 'windows'],
        properties: {
          screen: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y', 'width', 'height'],
            properties: {
              x: { type: 'integer' }, y: { type: 'integer' },
              width: { type: 'integer' }, height: { type: 'integer' },
            },
          },
          cursor: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y'],
            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
          },
          windows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'pid', 'x', 'y', 'width', 'height', 'foreground', 'minimized', 'visible'],
              properties: {
                title: { type: 'string' },
                pid: { type: 'integer' },
                x: { type: 'integer' }, y: { type: 'integer' },
                width: { type: 'integer' }, height: { type: 'integer' },
                minimized: { type: 'boolean' },
                visible: { type: 'boolean' },
                foreground: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `virtual screen: ${value.screen.width}x${value.screen.height} at (${value.screen.x},${value.screen.y})`,
          value.cursor ? `cursor: (${value.cursor.x},${value.cursor.y})` : '',
          `windows (${value.windows.length}):`,
          ...value.windows.map((entry) => `- "${entry.title}" [pid ${entry.pid}] ${entry.width}x${entry.height} at (${entry.x},${entry.y})${entry.foreground ? '  <focused>' : ''}${entry.minimized ? '  (minimized — kards_act focus restores it)' : ''}`),
        ].filter(Boolean).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const info = await shell.call('info', {}, 15000)
      const listing = await shell.call('windows', {}, 15000)
      const raw = Array.isArray(listing.windows) ? listing.windows : (listing.windows ? [listing.windows] : [])
      const needle = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : ''
      const windows = raw
        .filter((entry) => needle === '' || String(entry.title).toLowerCase().includes(needle))
        .map((entry) => ({
          title: entry.title,
          pid: entry.pid,
          x: entry.x,
          y: entry.y,
          width: entry.width,
          height: entry.height,
          minimized: Boolean(entry.minimized),
          visible: Boolean(entry.visible),
          foreground: Boolean(entry.foreground),
        }))
      return { screen: info.screen, cursor: info.cursor, windows }
    },
    presentCall: () => ({ card: 'generic', title: 'Look for the game window', kind: 'search' }),
  })

  ctx.tools.register({
    name: 'kards_screen',
    description: 'See this Windows desktop: capture the whole screen or one window to a PNG and return it as an image you can look at. The reply states the virtual-screen size and the exact mapping between image pixels and desktop pixels. Coordinates you later pass to kards_act are image pixels of the most recent capture by default.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        window: { type: 'string', description: 'Capture (and focus) the visible window whose title contains this text, e.g. "KARDS". Omit to capture the whole virtual screen.' },
        max_width: { type: 'integer', description: 'Maximum image width in pixels; default 1400. Lower it when the reply image is too large to read comfortably.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'image', 'imageWidth', 'imageHeight', 'regionX', 'regionY', 'regionWidth', 'regionHeight', 'scaleX', 'scaleY', 'screen'],
        properties: {
          path: { type: 'string' },
          image: IMAGE_VALUE,
          imageWidth: { type: 'integer' },
          imageHeight: { type: 'integer' },
          regionX: { type: 'integer' },
          regionY: { type: 'integer' },
          regionWidth: { type: 'integer' },
          regionHeight: { type: 'integer' },
          scaleX: { type: 'number' },
          scaleY: { type: 'number' },
          cursor: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y'],
            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
          },
          screen: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y', 'width', 'height'],
            properties: {
              x: { type: 'integer' }, y: { type: 'integer' },
              width: { type: 'integer' }, height: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => captureContent(value),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    async execute(args, exec) {
      const captureResult = await capture(exec, {
        title: typeof args.window === 'string' && args.window.trim() !== '' ? args.window.trim() : undefined,
        maxWidth: typeof args.max_width === 'number' ? args.max_width : undefined,
      })
      if (exec.agent) captures.set(String(exec.agent.id), captureResult)
      return captureResult
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.window ? `Look at the ${args.window} window` : 'Look at the desktop',
      kind: 'read',
    }),
  })

  const ACT_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'cursor', 'note'],
    properties: {
      action: { type: 'string' },
      cursor: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y'],
        properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      },
      note: { type: 'string' },
      clickPoint: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y'],
        properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      },
      window: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'x', 'y', 'width', 'height'],
        properties: {
          title: { type: 'string' },
          x: { type: 'integer' }, y: { type: 'integer' },
          width: { type: 'integer' }, height: { type: 'integer' },
        },
      },
      image: IMAGE_VALUE,
      imageWidth: { type: 'integer' },
      imageHeight: { type: 'integer' },
      regionX: { type: 'integer' },
      regionY: { type: 'integer' },
      regionWidth: { type: 'integer' },
      regionHeight: { type: 'integer' },
      scaleX: { type: 'number' },
      scaleY: { type: 'number' },
      path: { type: 'string' },
      screen: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'width', 'height'],
        properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
          width: { type: 'integer' }, height: { type: 'integer' },
        },
      },
    },
  }

  ctx.tools.register({
    name: 'kards_act',
    description: [
      'Drive the real mouse and keyboard of this Windows desktop. This is how a game is played: the pointer actually moves and the click really lands, so avoid unrelated clicking.',
      'Actions: click, double_click, right_click, drag, move, wheel, key, focus, wait.',
      'x/y are pixels in the MOST RECENT kards_screen image (default space "image"); pass space:"screen" for desktop pixels. drag needs to_x/to_y too.',
      'Unless look is false, the reply also contains a fresh screenshot taken after the action — read it before deciding the next move.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'double_click', 'right_click', 'drag', 'move', 'wheel', 'key', 'focus', 'wait'],
        },
        x: { type: 'integer', description: 'Target x in the coordinate space selected by `space`.' },
        y: { type: 'integer', description: 'Target y in the coordinate space selected by `space`.' },
        to_x: { type: 'integer', description: 'Drag end x.' },
        to_y: { type: 'integer', description: 'Drag end y.' },
        space: { type: 'string', enum: ['image', 'screen'], description: 'image (default) = pixels of the last kards_screen capture; screen = desktop pixels.' },
        keys: { type: 'string', description: 'Keyboard combo for action "key", e.g. "enter", "esc", "space", "ctrl+s", "1".' },
        delta: { type: 'integer', description: 'Wheel delta for action "wheel"; negative scrolls down (default -120).' },
        window: { type: 'string', description: 'Window title substring for action "focus", and the window captured by the trailing screenshot.' },
        ms: { type: 'integer', description: 'Milliseconds for action "wait", or the settle delay before the trailing screenshot (default 350).' },
        look: { type: 'boolean', description: 'Take a screenshot after acting; default true. Set false to batch several actions.' },
      },
    },
    output: {
      schema: ACT_OUTPUT,
      render: (args, value) => {
        const head = [`kards_act ${value.action}: ok`, value.note, value.clickPoint ? `point: (${value.clickPoint.x},${value.clickPoint.y})` : '', value.window ? `window: "${value.window.title}" ${value.window.width}x${value.window.height} at (${value.window.x},${value.window.y})` : '', `cursor now: (${value.cursor.x},${value.cursor.y})`].filter(Boolean).join('\n')
        if (!value.image) return [{ type: 'text', text: head }]
        return [{ type: 'text', text: `${head}\n\n${describeCapture(value)}` }, { type: 'image', attachment: value.image }]
      },
      presentationMeta: (args, value) => ({
        action: args.action,
        ...(typeof value.path === 'string' ? { path: value.path } : {}),
      }),
    },
    async execute(args, exec) {
      const agentKey = exec.agent ? String(exec.agent.id) : ''
      const last = captures.get(agentKey)
      const space = args.space === 'screen' ? 'screen' : 'image'
      const action = String(args.action)

      /** Map one model-supplied point onto desktop pixels. */
      const point = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('this action needs numeric x and y coordinates')
        if (space === 'screen' || !last) {
          return { x: Math.round(x), y: Math.round(y), mapped: space === 'screen' }
        }
        return {
          x: Math.round(last.regionX + x * last.scaleX),
          y: Math.round(last.regionY + y * last.scaleY),
          mapped: true,
        }
      }

      let note = ''
      let clickPoint
      let windowInfo
      if (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'move') {
        const target = point(args.x, args.y)
        await shell.call('mouse', { x: target.x, y: target.y, action, delayMs: 60 }, 15000)
        clickPoint = { x: target.x, y: target.y }
        note = target.mapped && space === 'image' ? `mapped from image pixels (${args.x},${args.y})` : 'desktop pixels'
      } else if (action === 'drag') {
        const from = point(args.x, args.y)
        const to = point(args.to_x, args.to_y)
        await shell.call('drag', { x: from.x, y: from.y, toX: to.x, toY: to.y, durationMs: 320 }, 20000)
        clickPoint = { x: to.x, y: to.y }
        note = `dragged (${from.x},${from.y}) -> (${to.x},${to.y})`
      } else if (action === 'wheel') {
        const delta = Number.isFinite(args.delta) ? Math.round(args.delta) : -120
        await shell.call('wheel', { delta }, 10000)
        note = `wheel delta ${delta}`
      } else if (action === 'key') {
        if (typeof args.keys !== 'string' || args.keys.trim() === '') throw new Error('action "key" needs a keys string such as "enter" or "ctrl+s"')
        await shell.call('key', { keys: args.keys.trim() }, 10000)
        note = `keys ${args.keys.trim()}`
      } else if (action === 'focus') {
        if (typeof args.window !== 'string' || args.window.trim() === '') throw new Error('action "focus" needs a window title substring in `window`')
        const focused = await shell.call('focus', { title: args.window.trim() }, 20000)
        windowInfo = focused.rect
          ? { title: String(focused.title), x: focused.rect.x, y: focused.rect.y, width: focused.rect.width, height: focused.rect.height }
          : undefined
        note = focused.focused
          ? `focused "${focused.title}"`
          : `tried to focus "${focused.title}" but another window kept the foreground`
      } else if (action === 'wait') {
        const ms = Number.isFinite(args.ms) ? Math.min(Math.max(Math.round(args.ms), 0), 15000) : 1000
        await shell.call('sleep', { ms }, ms + 10000)
        note = `waited ${ms}ms`
      } else {
        throw new Error(`unsupported action "${action}"`)
      }

      const cursor = (await shell.call('info', {}, 8000)).cursor
      const value = { action, cursor, note, ...(clickPoint ? { clickPoint } : {}), ...(windowInfo ? { window: windowInfo } : {}) }

      if (args.look === false) return value
      const settle = Number.isFinite(args.ms) && action !== 'wait' ? Math.min(Math.max(Math.round(args.ms), 0), 5000) : 350
      if (settle > 0) await shell.call('sleep', { ms: settle }, settle + 8000)
      const captureResult = await capture(exec, {
        title: typeof args.window === 'string' && args.window.trim() !== '' && action === 'focus' ? args.window.trim() : undefined,
        maxWidth: WIDTH_LADDER[0],
      })
      captures.set(agentKey, captureResult)
      return { ...value, ...captureResult }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `KARDS ${String(args.action)}${Number.isFinite(args.x) ? ` (${args.x},${args.y})` : ''}`,
      kind: 'execute',
      rawInput: { action: args.action, x: args.x, y: args.y, keys: args.keys },
    }),
  })
}
