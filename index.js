/**
 * dsh-session-admin —— 会话归档 / 取消归档的工具面
 *
 * 为什么需要它：
 *   归档（archive）本来只在界面里能点。宿主侧的能力是齐的：
 *   `@deepseek-ai/dsh-api-workspace-controller` 的 archiveSession 就是
 *   `ctx.workspaceRegistry.archiveSession(sessionId, {stopActivity})`
 *   （lib/index.js L299；unarchive 在 L318），但**没有任何官方工具**把它暴露给模型。
 *   于是「会话太大 / 太旧，帮我收起来」这种事只能请人去点界面，或者由模型
 *   直接去改 storages 里的状态文件 —— 后者是危险的（内存副本会盖掉手改）。
 *   本插件只把服务层那一层包成工具，不发明新机制、不碰任何文件。
 *
 * 契约来源（都在 asar 里读过原文，不是推测）：
 *   - 服务名：`workspaceRegistry`（dsh-workspace/lib/index.js L377 `super(ctx,"workspaceRegistry")`）。
 *   - `archiveSession(sessionId, options = {})` → Promise<void>（L527）。
 *     * 会话必须存在（live 或已落盘），否则抛 WorkspaceUnknownSessionError（L530）。
 *     * 不带 stopActivity 时会先问 `workspace/session-activity` waterfall，
 *       有活动就抛 WorkspaceActiveSessionError（L531-533）——所以默认**不**强杀。
 *     * 带 `{stopActivity:true}` 则跳过活动检查，先落盘归档再派发停止事件（L541）。
 *     * 已经归档过的 id 直接 resolve，不写不查（L529）——天然幂等。
 *   - `unarchiveSession(sessionId)` → Promise<void>（L554）；不在归档集里也直接 resolve，幂等。
 *   - `archivedSessionIds` getter（L507）给出归档全集。
 *   - `sessionPersistence.stat(id)` → `{header, revision, sizeBytes}` 或 `undefined`
 *     （dsh-session-persistence-jsonl/lib/index.js L2571/2590）。
 *
 * 安全设计：
 *   1. 归档**只认已存在的会话**：先自己探一次存在性，不存在直接 session_not_found，
 *      绝不"顺手建一个"。注意 registry 自己也查，这里只是把错误提前成结构化返回。
 *   2. 默认不强杀：stopActivity 必须由调用方显式传 true 才会带上，
 *      因为"归档"和"打断正在跑的工作"是两件事，不该由工具替调用方决定。
 *   3. 全部 fail-open：任何异常都变成 `{ok:false, code, error}` 返回，绝不 throw
 *      （工具里抛异常会打断整个回合）。
 *   4. 只读工具（list）不写任何文件：只调 getter、stat()、sessionTitle.get()。
 *
 * schema 硬约束（踩过的坑，别改回去）：
 *   - tools.register 的 parameters 必须是**标准 JSON Schema**（顶层 type:'object'
 *     + properties + required 数组）；简写参数表会被静默拒登。
 *   - output.schema 走的是 dsh-tools/json-schema 强制子集（"one scalar type"），
 *     所以可空字段**不能**写 type:['string','null']，只能用 exact-one oneOf。
 *   - output.schema 是 additionalProperties:false：execute 返回的每个键都必须登记，
 *     漏一个整条结果会被拒收。
 */

export const name = 'dsh-session-admin'

/**
 * tools 是硬依赖（没注册器就什么也做不了）。
 * workspaceRegistry **不写在这里**：它可能晚于本插件就绪，写进顶层 inject 数组会在
 * 服务缺失时让整个插件装载失败；改用 apply 里的 ctx.inject 软订阅。
 */
export const inject = ['tools']

export const TOOLS = {
  archive: 'session_archive',
  unarchive: 'session_unarchive',
  list: 'session_admin_list',
}

// ---------------------------------------------------------------------------
// JSON Schema（强制子集）
// ---------------------------------------------------------------------------

const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const NULLABLE_NUMBER = { oneOf: [{ type: 'number' }, { type: 'null' }] }

const SESSION_ADMIN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    sessionId: { type: 'string' },
    archived: { type: 'boolean' },
    code: { type: 'string' },
    error: { type: 'string' },
    count: { type: 'integer' },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          title: NULLABLE_STRING,
          archived: { type: 'boolean' },
          sizeBytes: NULLABLE_NUMBER,
        },
        required: ['sessionId', 'archived'],
        additionalProperties: false,
      },
    },
  },
  required: ['ok'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function errText(err) {
  if (err === null || err === undefined) return '未知错误'
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message || String(err)
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function text(line) {
  return [{ type: 'text', text: String(line) }]
}

/** 取服务：拿不到就 undefined，绝不抛。 */
function service(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(key, false) ?? undefined
    return ctx?.[key] ?? undefined
  } catch {
    return undefined
  }
}

/** id 校验：非空、无首尾/内部空白（防止把一整行描述当 id 传进来）。 */
function normalizeId(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'sessionId 必须是字符串' }
  const id = raw.trim()
  if (id.length === 0) return { ok: false, error: 'sessionId 不能为空' }
  if (/\s/.test(id)) return { ok: false, error: 'sessionId 不能包含空白字符' }
  return { ok: true, id }
}

/**
 * 会话是否存在：true = 在，false = 确定不在，undefined = 拿不到判断依据（交给 registry 自己拒）。
 * 只看两个不写盘的事实源：活会话表 + 持久化 stat()。
 */
async function sessionKnown(ctx, id) {
  const sessions = service(ctx, 'sessions')
  if (sessions && typeof sessions.get === 'function') {
    try {
      if (sessions.get(id) !== undefined) return true
    } catch {
      /* 活会话表读失败不算结论，继续看持久化 */
    }
  }
  const persistence = service(ctx, 'sessionPersistence')
  if (persistence && typeof persistence.stat === 'function') {
    try {
      return (await persistence.stat(id)) !== undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 标题只有活会话拿得到（sessionTitle.get 要 session 对象）；拿不到就 null，不猜。 */
function titleOf(ctx, id) {
  try {
    const sessions = service(ctx, 'sessions')
    const titles = service(ctx, 'sessionTitle')
    if (!sessions || !titles) return null
    if (typeof sessions.get !== 'function' || typeof titles.get !== 'function') return null
    const session = sessions.get(id)
    if (session === undefined) return null
    const snapshot = titles.get(session)
    const title = snapshot !== null && typeof snapshot === 'object' ? snapshot.title : undefined
    return typeof title === 'string' && title.length > 0 ? title : null
  } catch {
    return null
  }
}

/** 把 registry / persistence 抛出的具名错误翻译成稳定 code。 */
function classify(err) {
  const kind = err !== null && typeof err === 'object' && typeof err.name === 'string' ? err.name : ''
  if (kind === 'WorkspaceActiveSessionError') return 'session_active'
  if (kind === 'WorkspaceUnknownSessionError') return 'session_not_found'
  return ''
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const ARCHIVE_DESCRIPTION =
  '把一个会话归档（从所有分组界面隐藏，不删除、不动 workspace 记账；取消归档能回到原位）。' +
  '默认**不**打断正在跑的工作：该会话还有活动时会被拒（code=session_active），' +
  '确实要强制归档再传 stopActivity=true。已经归档过的会话直接返回成功。'

const UNARCHIVE_DESCRIPTION =
  '取消归档一个会话，让它回到原来的位置。本来就没归档的会话直接返回成功（幂等）。'

const LIST_DESCRIPTION =
  '列出本机所有已落盘的会话：sessionId / 标题（仅活会话有，其余为 null）/ 是否已归档 / 体积字节。' +
  '只读，不写任何文件。想找「太大或太旧、可以收起来」的会话时先看这个。'

function registerWith({ tools, registry, ctx, warn }) {
  // ---- session_archive ---------------------------------------------------
  tools.register({
    name: TOOLS.archive,
    description: ARCHIVE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要归档的会话 id（session_* 或 uuid 原文）。' },
        stopActivity: {
          type: 'boolean',
          description: 'true = 跳过活动检查并把该会话正在跑的工作停掉（强制归档）；默认 false，有活动则拒绝。',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: SESSION_ADMIN_OUTPUT_SCHEMA,
      render: (_args, value) => {
        try {
          const v = value !== null && typeof value === 'object' ? value : {}
          if (v.ok === false) return text(`没归档（${v.code ?? 'error'}）：${v.error ?? '未知错误'}`)
          return text(`已归档 ${v.sessionId}`)
        } catch (err) {
          return text(`session_archive 渲染失败：${errText(err)}`)
        }
      },
    },
    async execute(args) {
      try {
        const checked = normalizeId(args?.sessionId)
        if (!checked.ok) return { ok: false, code: 'bad_session_id', error: checked.error }
        const stopActivity = args?.stopActivity === true

        // 只允许归档已存在的会话：不存在就明确拒绝，绝不新建
        if ((await sessionKnown(ctx, checked.id)) === false) {
          return { ok: false, code: 'session_not_found', error: `没有 id 为 ${checked.id} 的会话` }
        }

        await registry.archiveSession(checked.id, stopActivity ? { stopActivity: true } : {})
        return { ok: true, sessionId: checked.id, archived: true }
      } catch (err) {
        const code = classify(err)
        if (code === 'session_not_found') {
          return { ok: false, code, error: `没有 id 为 ${String(args?.sessionId ?? '')} 的会话` }
        }
        if (code === 'session_active') {
          return {
            ok: false,
            code,
            error: '该会话还有工作在跑，宿主拒绝归档；要强制归档请传 stopActivity:true',
          }
        }
        return { ok: false, code: 'archive_failed', error: errText(err) }
      }
    },
  })

  // ---- session_unarchive -------------------------------------------------
  tools.register({
    name: TOOLS.unarchive,
    description: UNARCHIVE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要取消归档的会话 id。' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: SESSION_ADMIN_OUTPUT_SCHEMA,
      render: (_args, value) => {
        try {
          const v = value !== null && typeof value === 'object' ? value : {}
          if (v.ok === false) return text(`没取消（${v.code ?? 'error'}）：${v.error ?? '未知错误'}`)
          return text(`已取消归档 ${v.sessionId}`)
        } catch (err) {
          return text(`session_unarchive 渲染失败：${errText(err)}`)
        }
      },
    },
    async execute(args) {
      try {
        const checked = normalizeId(args?.sessionId)
        if (!checked.ok) return { ok: false, code: 'bad_session_id', error: checked.error }
        await registry.unarchiveSession(checked.id)
        return { ok: true, sessionId: checked.id, archived: false }
      } catch (err) {
        return { ok: false, code: 'unarchive_failed', error: errText(err) }
      }
    },
  })

  // ---- session_admin_list ------------------------------------------------
  tools.register({
    name: TOOLS.list,
    description: LIST_DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: SESSION_ADMIN_OUTPUT_SCHEMA,
      render: (_args, value) => {
        try {
          const v = value !== null && typeof value === 'object' ? value : {}
          if (v.ok === false) return text(`列出失败：${v.error ?? '未知错误'}`)
          const rows = Array.isArray(v.sessions) ? v.sessions : []
          if (rows.length === 0) return text('没有任何已落盘的会话。')
          const lines = [`共 ${rows.length} 个会话：`]
          for (const row of rows) {
            const size = typeof row.sizeBytes === 'number' ? `${row.sizeBytes} B` : '?'
            const flag = row.archived === true ? '[已归档]' : '[     ]'
            const title = typeof row.title === 'string' ? row.title : '(非活会话，无标题)'
            lines.push(`  ${flag} ${size.padStart(10)}  ${row.sessionId}  ${title}`)
          }
          return text(lines.join('\n'))
        } catch (err) {
          return text(`session_admin_list 渲染失败：${errText(err)}`)
        }
      },
    },
    async execute() {
      try {
        const persistence = service(ctx, 'sessionPersistence')
        const archived = new Set(
          Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.map(String) : [],
        )

        // 枚举只认持久化清单：归档的会话通常不再 live，只在 storages 里躺着
        let snapshots = []
        if (persistence && typeof persistence.list === 'function') {
          const listed = await persistence.list()
          snapshots = Array.isArray(listed) ? listed : []
        }

        const sessions = []
        for (const snap of snapshots) {
          const id = snap?.header?.id ?? snap?.id
          if (typeof id !== 'string' || id.length === 0) continue

          // 体积按规格取 stat().sizeBytes：pending 态会话还没落盘，拿不到就是 null（正常形态，不是故障）
          let sizeBytes = null
          if (persistence && typeof persistence.stat === 'function') {
            try {
              const info = await persistence.stat(id)
              if (info !== null && typeof info === 'object' && typeof info.sizeBytes === 'number') {
                sizeBytes = info.sizeBytes
              }
            } catch {
              /* 单条读不到不影响整表 */
            }
          }

          sessions.push({ sessionId: id, title: titleOf(ctx, id), archived: archived.has(id), sizeBytes })
        }

        return { ok: true, count: sessions.length, sessions }
      } catch (err) {
        return { ok: false, code: 'list_failed', error: errText(err) }
      }
    },
  })

  if (typeof warn === 'function') {
    warn(`[session-admin] 已注册 ${Object.values(TOOLS).join(' / ')}（归档默认不强杀）`)
  }
}

/**
 * 插件入口。
 * workspaceRegistry 按作用域软订阅：直接拿到就立刻挂，拿不到就走 ctx.inject 等它出现
 * ——服务缺席时本插件只是不注册工具，不会让整个装载失败。
 */
export function apply(ctx) {
  const logger = typeof ctx?.get === 'function' ? ctx.get('logger', false) : undefined
  const warn = (msg) => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(msg)
      else if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(msg)
    } catch {
      /* 日志失败绝不影响注册 */
    }
  }

  const mount = (scope) => {
    try {
      const tools = service(scope, 'tools')
      const registry = service(scope, 'workspaceRegistry')
      if (!tools || typeof tools.register !== 'function') {
        warn('[session-admin] tools 服务不可用：不注册任何工具')
        return
      }
      if (!registry || typeof registry.archiveSession !== 'function' || typeof registry.unarchiveSession !== 'function') {
        warn('[session-admin] workspaceRegistry 服务不可用：不注册任何工具')
        return
      }
      registerWith({ tools, registry, ctx: scope, warn })
    } catch (err) {
      warn(`[session-admin] 注册失败（不抛异常）：${errText(err)}`)
    }
  }

  try {
    const direct = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry', false) : undefined
    if (direct) return mount(ctx)
    if (typeof ctx?.inject === 'function') return ctx.inject(['workspaceRegistry'], (scope) => mount(scope))
    warn('[session-admin] 拿不到 workspaceRegistry，也没有 inject：不注册任何工具')
  } catch (err) {
    warn(`[session-admin] apply 失败（不抛异常）：${errText(err)}`)
  }
}
