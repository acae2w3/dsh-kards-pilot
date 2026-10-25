/**
 * KARDS pilot — browser half.
 *
 * Registers one floating ball into `shell.overlay`. Clicking it wakes the
 * current Session with the pilot playbook (through the ordinary, authenticated
 * `remote.session.prompt` surface); clicking it while a match is running
 * cancels that turn. Dragging it moves it; the position is remembered.
 *
 * Drag/hover/phase visuals are inline styles on purpose: the host stylesheet
 * styles bare `button` elements with higher precedence than a single class,
 * so a class-only ball renders as a host button. The `<style>` block only adds
 * what inline styles cannot express (transition keyframes, focus ring).
 *
 * @module @local/kards-pilot
 */
window.__ModuleLoader__.load({
  id: '@local/kards-pilot',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'kards-pilot'
    const POS_KEY = 'kards-pilot:pos'
    const TARGET_KEY = 'kards-pilot:target'
    const SEEN_KEY = 'kards-pilot:seen'
    const SIZE = 56

    const STRINGS = {
      zh: {
        start: '进入对局',
        stop: '结束对局',
        waking: '唤醒中…',
        retry: '重试',
        hint: '点击：唤醒智能体进入 KARDS 对局；对局进行中再次点击可中止；按住拖动可移动位置。',
      },
      en: {
        start: 'Play KARDS',
        stop: 'Stop match',
        waking: 'Waking up…',
        retry: 'Retry',
        hint: 'Click to wake the agent into a KARDS match; click again while a match runs to stop it; drag to move.',
      },
    }

    /** Per-phase ball paint: idle blue, waking amber, active green, error red. */
    const PHASE_STOPS = {
      idle: ['#3b8fe6', '#1a5fb4', '#0a2f5e'],
      waking: ['#f2c76b', '#c98a20', '#6d4708'],
      active: ['#46d38a', '#17a45f', '#0a5c36'],
      error: ['#f18e8e', '#c33b3b', '#661717'],
    }

    /** The prompt that hands the whole task to the agent. */
    const WAKE_TEXT = [
      '【KARDS 操控任务】用户点了悬浮球，请你现在接管这台电脑上的 KARDS 对局。',
      '',
      '0. 先找窗口：用 kards_windows 找标题含 "kards" 的窗口。找不到就用 pwsh 启动它（桌面/开始菜单里的 KARDS 快捷方式），等窗口出现再继续。找到后 kards_act {action:"focus", window:"kards"} 切到前台，再 kards_screen {window:"kards"} 看画面。',
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
      '- 开局：先手 4 张起手且首回合不抽；后手 5 张且首回合抽 1；双方各有一次调度（换掉不要的起手牌）。调度时留低费单位与早期解牌，弃掉高费与用不上的指令。',
      '',
      '3. 一个回合的固定流程：看场面 → 定目标（抢前线 / 清场 / 打脸）→ 按指挥点排出牌顺序 → 逐张操作并确认生效 → 确认资源用尽 → 点结束回合。出牌一般是「点手牌 → 点目标位置或目标单位」。',
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

    /** Read a JSON value from localStorage, never throwing. */
    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        return raw === null ? fallback : JSON.parse(raw)
      } catch {
        return fallback
      }
    }

    /** Write a JSON value to localStorage, never throwing. */
    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch { /* private mode */ }
    }

    /** Default resting place: right edge, above the composer. */
    function defaultPos() {
      return {
        left: Math.max(8, (window.innerWidth || 1280) - SIZE - 24),
        top: Math.max(8, (window.innerHeight || 800) - SIZE - 120),
      }
    }

    /** Keep the ball fully on screen. */
    function clampPos(pos) {
      const width = window.innerWidth || 1280
      const height = window.innerHeight || 800
      return {
        left: Math.min(Math.max(-SIZE / 2, Number(pos.left) || 0), width - SIZE / 2),
        top: Math.min(Math.max(0, Number(pos.top) || 0), height - SIZE - 4),
      }
    }

    /** A fresh request id for one prompt admission. */
    function newRequestId() {
      try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
      } catch { /* fall through */ }
      return `kards-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    /** The browser time zone, so transcript timestamps match the user's day. */
    function clientTimeZone() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone
      } catch {
        return undefined
      }
    }

    /** Visible sessions, most recently active first. */
    async function readSessions(ctx) {
      const value = await ctx.remote.session.list({})
      const items = value && Array.isArray(value.items) ? value.items : []
      return items.filter((item) => item && typeof item.sessionId === 'string')
    }

    /**
     * Choose the Session to wake: the remembered one while it still exists,
     * otherwise the most recently active top-level Session.
     * @param {Array<Record<string, any>>} items session summaries.
     * @param {string|null} remembered previously used Session id.
     * @returns {string|null} the Session id, or null when none is available.
     */
    function pickTarget(items, remembered) {
      if (remembered && items.some((item) => item.sessionId === remembered)) return remembered
      const roots = items.filter((item) => item.origin !== 'subagent' && !item.parentSessionId)
      const choice = roots[0] || items[0]
      return choice ? choice.sessionId : null
    }

    const CSS = `
.kp-root .kp-ring{animation:kp-pulse 1.7s ease-out infinite}
@keyframes kp-pulse{0%{transform:scale(.9);opacity:.95}70%{transform:scale(1.24);opacity:0}100%{opacity:0}}
.kp-root .kp-pill{transition:opacity .12s ease}
.kp-root .kp-glyph{width:28px;height:28px;display:block;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))}
`

    /**
     * The floating KARDS ball.
     * @param {{ctx: any, t: (key: string) => string}} props plugin services plus translator.
     */
    function Ball(props) {
      const { ctx, t } = props
      const gradId = React.useRef(`kp-grad-${Math.random().toString(36).slice(2, 8)}`).current
      const [phase, setPhase] = React.useState('idle')
      const [note, setNote] = React.useState('')
      const [hover, setHover] = React.useState(false)
      const [pressed, setPressed] = React.useState(false)
      const [focused, setFocused] = React.useState(false)
      const [pos, setPos] = React.useState(() => clampPos(readJson(POS_KEY, defaultPos())))
      const [seen, setSeen] = React.useState(() => readJson(SEEN_KEY, false))
      const state = React.useRef({
        dragging: false,
        moved: false,
        startX: 0,
        startY: 0,
        originX: 0,
        originY: 0,
        pos: null,
        target: readJson(TARGET_KEY, null),
        idleStreak: 0,
      })
      state.current.pos = pos

      React.useEffect(() => {
        const onResize = () => setPos((current) => clampPos(current))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // Reflect a match that is already running (for example after a page reload).
      React.useEffect(() => {
        const target = state.current.target
        if (typeof target !== 'string' || target === '') return undefined
        let alive = true
        readSessions(ctx)
          .then((items) => {
            if (!alive) return
            const item = items.find((entry) => entry.sessionId === target)
            if (item && item.running === true) setPhase('active')
          })
          .catch(() => {})
        return () => { alive = false }
      }, [ctx])

      // While a match runs, notice when the agent's turn ends.
      React.useEffect(() => {
        if (phase !== 'active') return undefined
        let alive = true
        const tick = async () => {
          const target = state.current.target
          if (typeof target !== 'string' || target === '') return
          const items = await readSessions(ctx)
          if (!alive) return
          const item = items.find((entry) => entry.sessionId === target)
          if (item && item.running === true) {
            state.current.idleStreak = 0
            return
          }
          state.current.idleStreak += 1
          if (state.current.idleStreak >= 2) setPhase('idle')
        }
        const id = window.setInterval(() => { tick().catch(() => {}) }, 4000)
        return () => {
          alive = false
          window.clearInterval(id)
        }
      }, [phase, ctx])

      const wake = async () => {
        setPhase('waking')
        setNote('')
        state.current.idleStreak = 0
        try {
          const items = await readSessions(ctx)
          const target = pickTarget(items, state.current.target)
          if (target === null) throw new Error('没有可用的会话')
          await ctx.remote.session.prompt({
            requestId: newRequestId(),
            sessionId: target,
            mode: 'queue',
            content: [{ type: 'text', text: WAKE_TEXT }],
            clientTimeZone: clientTimeZone(),
          })
          state.current.target = target
          writeJson(TARGET_KEY, target)
          setSeen(true)
          writeJson(SEEN_KEY, true)
          setPhase('active')
        } catch (error) {
          setPhase('error')
          setNote(String((error && (error.message || error.code)) || error))
          window.setTimeout(() => {
            setPhase((current) => (current === 'error' ? 'idle' : current))
          }, 9000)
        }
      }

      const stop = async () => {
        const target = state.current.target
        setPhase('idle')
        setNote('')
        if (typeof target !== 'string' || target === '') return
        try {
          await ctx.remote.session.cancel({ sessionId: target })
        } catch (error) {
          setNote(String((error && (error.message || error.code)) || error))
        }
      }

      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return
        const el = event.currentTarget
        try { el.setPointerCapture(event.pointerId) } catch { /* unsupported */ }
        const current = state.current
        current.dragging = true
        current.moved = false
        current.startX = event.clientX
        current.startY = event.clientY
        current.originX = state.current.pos.left
        current.originY = state.current.pos.top
        setPressed(true)
        event.preventDefault()
      }

      const onPointerMove = (event) => {
        const current = state.current
        if (!current.dragging) return
        const dx = event.clientX - current.startX
        const dy = event.clientY - current.startY
        if (!current.moved && Math.abs(dx) + Math.abs(dy) > 4) current.moved = true
        if (!current.moved) return
        const next = clampPos({ left: current.originX + dx, top: current.originY + dy })
        current.pos = next
        setPos(next)
      }

      const onPointerUp = (event) => {
        const current = state.current
        if (!current.dragging) return
        current.dragging = false
        setPressed(false)
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* unsupported */ }
        if (current.moved) {
          writeJson(POS_KEY, current.pos)
          return
        }
        if (phase === 'idle' || phase === 'error') wake()
        else if (phase === 'active') stop()
      }

      const onKeyDown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (phase === 'idle' || phase === 'error') wake()
        else if (phase === 'active') stop()
      }

      const label = phase === 'active'
        ? t('stop')
        : phase === 'waking'
          ? t('waking')
          : phase === 'error'
            ? (note || t('retry'))
            : t('start')
      const pillOnRight = pos.left < 150
      const scale = pressed ? 0.96 : (hover ? 1.045 : 1)
      // The interactive wrapper carries the button semantics; the painted layer is a
      // plain div so host rules for `button` / `[role=button]` cannot reshape it.
      const wrapStyle = {
        position: 'relative',
        width: `${SIZE}px`,
        height: `${SIZE}px`,
        cursor: pressed ? 'grabbing' : 'grab',
        outline: 'none',
        lineHeight: 0,
        touchAction: 'none',
        transform: `translateY(${hover && !pressed ? -1 : 0}px) scale(${scale})`,
        transition: 'transform .14s ease, box-shadow .14s ease',
        borderRadius: '50%',
      }
      const paintStyle = {
        position: 'absolute',
        left: '0',
        top: '0',
        width: `${SIZE}px`,
        height: `${SIZE}px`,
        display: 'block',
        pointerEvents: 'none',
        filter: 'drop-shadow(0 7px 16px rgba(3,16,38,.45))',
      }
      const dotStyle = {
        position: 'absolute',
        right: '-1px',
        bottom: '-1px',
        width: '11px',
        height: '11px',
        borderRadius: '50%',
        border: '2px solid var(--dsw-alias-bg-base)',
        background: phase === 'active'
          ? 'var(--dsw-alias-state-success-primary)'
          : phase === 'waking'
            ? 'var(--dsw-alias-state-warn-primary)'
            : phase === 'error'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-state-idle-primary)',
        pointerEvents: 'none',
      }
      const ringStyle = {
        position: 'absolute',
        left: '-5px',
        top: '-5px',
        width: `${SIZE + 10}px`,
        height: `${SIZE + 10}px`,
        display: 'block',
        pointerEvents: 'none',
      }
      const pillStyle = {
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        maxWidth: '230px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontFamily: 'system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
        fontSize: '12px',
        lineHeight: '1',
        padding: '7px 11px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-overlay)',
        color: phase === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
        border: `1px solid ${phase === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1)'}`,
        boxShadow: '0 6px 18px rgba(0,0,0,.28)',
        pointerEvents: 'none',
        ...(pillOnRight ? { left: `${SIZE + 8}px` } : { right: `${SIZE + 8}px` }),
      }
      const showPill = hover || pressed || phase !== 'idle' || !seen
      const stops = PHASE_STOPS[phase] || PHASE_STOPS.idle

      return h('div', {
        className: 'kp-root',
        style: {
          position: 'fixed',
          left: `${pos.left}px`,
          top: `${pos.top}px`,
          width: `${SIZE}px`,
          height: `${SIZE}px`,
          zIndex: 70,
          pointerEvents: 'auto',
          userSelect: 'none',
        },
      },
      h('style', { key: 'css' }, CSS),
      showPill ? h('div', { key: 'pill', className: 'kp-pill', style: pillStyle }, label) : null,
      h('div', {
        key: 'ball',
        role: 'button',
        tabIndex: 0,
        className: 'kp-ball',
        'data-phase': phase,
        'aria-label': `${label}. ${t('hint')}`,
        title: `${label}\n${t('hint')}`,
        style: wrapStyle,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onKeyDown,
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      },
      h('svg', {
        key: 'paint',
        className: 'kp-paint',
        viewBox: '0 0 56 56',
        width: SIZE,
        height: SIZE,
        'aria-hidden': 'true',
        style: paintStyle,
      },
      h('defs', { key: 'defs' },
        h('radialGradient', { id: gradId, cx: '34%', cy: '26%', r: '78%' },
          h('stop', { key: 's0', offset: '0%', stopColor: stops[0] }),
          h('stop', { key: 's1', offset: '52%', stopColor: stops[1] }),
          h('stop', { key: 's2', offset: '100%', stopColor: stops[2] }))),
      h('circle', { key: 'body', cx: 28, cy: 28, r: 27.2, fill: `url(#${gradId})`, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1 }),
      focused
        ? h('circle', { key: 'focus', cx: 28, cy: 28, r: 29.6, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2.4 })
        : null,
      h('circle', { key: 'sight', cx: 28, cy: 28, r: 9, fill: 'none', stroke: 'rgba(255,255,255,.92)', strokeWidth: 2 }),
      h('path', { key: 'ticks', d: 'M28 13.5v5.5M28 42.5V37M13.5 28h5.5M42.5 28H37', stroke: 'rgba(255,255,255,.92)', strokeWidth: 2, strokeLinecap: 'round' }),
      h('circle', { key: 'core', cx: 28, cy: 28, r: 2.6, fill: 'rgba(255,255,255,.95)' })),
      phase === 'active' || phase === 'waking'
        ? h('svg', {
            key: 'pulse',
            className: 'kp-ring',
            viewBox: '0 0 66 66',
            'aria-hidden': 'true',
            style: ringStyle,
          }, h('circle', {
            cx: 33,
            cy: 33,
            r: 31,
            fill: 'none',
            stroke: phase === 'waking' ? 'rgba(242,199,107,.7)' : 'rgba(70,211,138,.6)',
            strokeWidth: 2,
          }))
        : null,
      h('span', { key: 'dot', className: 'kp-dot', style: dotStyle })))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session'],
      apply(ctx) {
        let translate = null
        ctx.effect(() => {
          const disposers = []
          try {
            disposers.push(ctx.locale.register(NS, 'zh', STRINGS.zh))
            disposers.push(ctx.locale.register(NS, 'en', STRINGS.en))
          } catch { /* keep the built-in fallback */ }
          try {
            translate = ctx.locale.bind(NS)
          } catch { /* keep the built-in fallback */ }
          return () => {
            for (const dispose of disposers.reverse()) {
              try { dispose() } catch { /* already gone */ }
            }
            translate = null
          }
        }, 'kards-pilot locale')

        const pick = () => {
          try {
            const nav = String((window.navigator && window.navigator.language) || 'zh')
            return /^en/i.test(nav) ? 'en' : 'zh'
          } catch {
            return 'zh'
          }
        }
        const t = (key) => {
          const fallback = STRINGS[pick()][key] ?? STRINGS.zh[key] ?? key
          if (!translate) return fallback
          try {
            const value = translate(key)
            return typeof value === 'string' && value !== '' && value !== key ? value : fallback
          } catch {
            return fallback
          }
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'kards-pilot-ball',
          order: 40,
        }, (props) => h(Ball, { ...props, ctx, t })))
      },
    }
  },
})
