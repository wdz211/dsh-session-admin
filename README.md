# dsh-session-admin

> Let the agent archive or unarchive a session itself: wraps `ctx.workspaceRegistry.archiveSession`, defaulting to never interrupting running work.

## 这是什么

DSH 里「归档会话」这个动作本来只能在界面上点。宿主侧的能力其实是齐的：`@deepseek-ai/dsh-api-workspace-controller` 的 `archiveSession` 就是 `ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity })`，`unarchiveSession` 也在同一个服务上。但**没有任何官方工具**把这一层暴露给模型。

结果是两头都难受：会话太大、太旧，想让 agent 自己收起来，做不到，得人去点界面；或者——更糟——模型自己去改 `storages` 里的状态文件，而那是个危险的歧路：宿主启动时把状态读进内存，手改的文件会被内存副本覆盖，两边还不一定一致。

本插件只做一件很窄的事：把服务层那一层包成三个工具（归档 / 取消归档 / 列出来看），**不发明新机制、不碰任何文件**。所有写操作都落到宿主自己的 registry 上，和界面上点按钮走的是同一条路径。

它解决的真实场景：「这台机器上会话堆了一百多个，哪些能收起来？」——先用 `session_admin_list` 拿体积和归档标记，再对确认没用的那几个调 `session_archive`。归档只隐藏、不删除，取消归档能回原位，所以这是一个**可逆**的收纳动作，而不是销毁。

## 前置条件

**诚实地说明**：这是 **DeepSeek Harness Desktop 的插件**，不是独立 npm 库。没有宿主提供的 `ctx`（cordis 运行时），`import` 进来只是一个导出 `apply` 的空模块，什么也跑不了。

它依赖的服务：

- `tools`：**硬依赖**，写在 `export const inject = ['tools']` 里。没有注册器就什么都不做。
- `workspaceRegistry`：**软依赖**，`apply` 里用 `ctx.inject(['workspaceRegistry'], …)` 订阅。**刻意不写进顶层 `inject` 数组**——它可能晚于本插件就绪，写进顶层会在服务缺失时让整个插件装载失败；软订阅的代价只是「此刻不注册工具」。
- 可选：`sessions` / `sessionPersistence` / `sessionTitle`，只用于「判断会话存不存在」「拿标题」「拿体积」。缺了不影响归档能力，只会让列表信息变少（标题为 `null`）。

## 安装

两步：目录 link 进 profile 的 `node_modules`，再在 composition 里加一条。`<dsh-home>` 表示 DSH 数据目录（Windows 通常是 `%USERPROFILE%\.dsh-beta`）。

```powershell
$src = '<dsh-home>\plugins\dsh-session-admin'
$dst = '<dsh-home>\profiles\desktop\node_modules\@local\dsh-session-admin'
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
cmd /c mklink /J "$dst" "$src"
```

```yaml
# 加进 profile 的 composition patch（或你自用 preset 的 composition，二选一）
- insert:
    - id: dsh-session-admin
      name: '@local/dsh-session-admin'
```

改 composition 是 **load-once**：必须整个 App 重启才会重读。只改 `index.js` 则可以走宿主自带的重建/刷新，不用请人重启。

装完验证：日志里出现

```
[session-admin] 已注册 session_archive / session_unarchive / session_admin_list（归档默认不强杀）
```

若看到的是「`workspaceRegistry` 服务不可用：不注册任何工具」，那就是软订阅没等到服务——先确认宿主里 workspace 相关插件是否启用，而不是怀疑本插件没装上。

## 配置

**无配置项。** 插件不读也不写任何配置文件，全部行为由调用参数决定。

## 对外能力

| 工具 | 入参 | 行为 |
|---|---|---|
| `session_archive` | `sessionId`（必填）、`stopActivity?`（默认 `false`） | 先自己探一次会话是否存在（活会话表 + 持久化 `stat()`），不存在直接 `session_not_found`，**绝不顺手建一个**；存在则调 `registry.archiveSession`。已归档过的会话宿主直接 resolve，天然幂等。 |
| `session_unarchive` | `sessionId`（必填） | 调 `registry.unarchiveSession`，让它回到原来的位置。本来就没归档的也直接成功（幂等）。 |
| `session_admin_list` | 无 | 枚举已落盘的会话：`sessionId` / `title`（仅活会话有，其余 `null`）/ `archived` / `sizeBytes`。**只读，不写任何文件。** |

### 默认不打断：`stopActivity` 为什么默认关

这是本插件唯一一个「设计取舍」值得写清的地方。

宿主侧 `archiveSession(sessionId)` 不带 `stopActivity` 时会先问一次 `workspace/session-activity` waterfall，**有活动就抛 `WorkspaceActiveSessionError`**；带 `{ stopActivity: true }` 则跳过活动检查，先落盘归档再派发停止事件。

本插件把这个参数原样交给调用方，且默认 `false`。理由：**「归档」和「打断正在跑的工作」是两件事**。模型看到「这个会话好大我想收起来」，并不等于它知道那个会话里正跑到一半的任务该不该被砍掉——让工具替调用方做这个决定，就会变成「一句话把别人的活停了」。

所以默认路径是「安全地失败」：返回 `code: 'session_active'`，把决定权交回去。真需要强杀时，调用方得显式写 `stopActivity: true`——它不是隐藏行为，而是一个必须自己敲出来的词。

### 错误码

失败一律是 `{ ok: false, code, error }`，**绝不 throw**（工具里抛异常会打断整个回合）。

| code | 含义 |
|---|---|
| `bad_session_id` | id 不是字符串，或为空 / 含空白字符 |
| `session_not_found` | 会话不存在（自己探的，或宿主抛的 `WorkspaceUnknownSessionError`） |
| `session_active` | 会话还有工作在跑，宿主拒结归档；要强制请传 `stopActivity: true` |
| `archive_failed` / `unarchive_failed` / `list_failed` | 其它异常，`error` 里是原文 |

## 已知限制

- **归档只隐藏、不删除。** 取消归档能回到原位。所以它不是「清理磁盘」的工具；如果目标是回收体积，归档只是让模型看不见它（会话文件还在盘上）。
- **读不到会话目录时，`session_admin_list` 可能报成「0 个会话」而不是「看不见」。** 别把后者当前者：一个空的列表可能意味着真的没有会话，也可能意味着持久化服务没拿到、目录不可读。看到 0 时，先确认服务在不在，别据此断言「这台机器没有会话」。
- **标题只有活会话拿得到。** `sessionTitle.get()` 需要一个 session 对象，非活会话一律 `null`——不是故障，是信息本身就不可读。
- **体积可能是 `null`。** 用 `persistence.stat(id).sizeBytes`；还在 pending、尚未落盘的会话拿不到，按 `null` 处理才是正常形态。
- **归档不会自动通知任何人。** 如果别的会话正引用着它（例如自动化任务挂在上面），归档之后那些引用会怎样，由宿主决定，本插件不做任何迁移或补救。
- **没有批量归档、没有「按体积阈值自动归档」。** 只按 id 一次一个。批量应该由调用方自己循环，并且自己承担误判断。

## 开发

本仓库目前**不带测试**（源码是从实际运行环境里提炼的单文件，没有可离线复跑的夹具）。CI 只做两件事：`node --check` 语法全检（必绿），以及「如果存在 `test/selftest.mjs` 就跑」的占位分支。

```bash
node --check index.js     # 本地最小校验
```

想加测试的话，正确做法是把 `ctx` 桩掉（`get('tools')` / `get('workspaceRegistry')` / `get('sessions')` / `get('sessionPersistence')`），断言：

- 三个工具都注册成功，且每个 `output` 都是 `{ schema, render }`；
- `stopActivity` 缺省时，传给 `archiveSession` 的 options **不含** `stopActivity`；传了 `true` 才带上；
- `WorkspaceActiveSessionError` → `session_active`，且不是 `archive_failed`；
- 不存在的会话 → 不发 `archiveSession` 调用；
- 服务缺席时不抛异常、不注册。

文件结构：

```
index.js     # 全部逻辑：JSON Schema / 三个工具 / 入口
```

读的时候注意两处**踩过坑的 schema 约束**（改回去会静默失效）：

1. `tools.register` 的 `parameters` 必须是标准 JSON Schema（顶层 `type: 'object'` + `properties` + `required` 数组），简写参数表会被静默拒登。
2. `output.schema` 走的是宿主强制子集（“one scalar type”）：可空字段**不能**写 `type: ['string','null']`，只能用恰一 `oneOf`；且它是 `additionalProperties: false`——`execute` 返回的每个键都必须登记，漏一个整条结果会被拒收。

## 许可

MIT。


