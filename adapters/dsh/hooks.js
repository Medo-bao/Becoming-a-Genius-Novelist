/**
 * 《我要成为天才小说作家》— DSH 预设作用域内的钩子插件。
 *
 * 队长同步运行资产、串行收件，并保留正文守卫与压缩恢复提醒。
 * 独立 worker 预设仅提供文件读取、搜索与任务目录写入，不继承队长工具。
 * 当前 workflow 后端不能选择 worker 预设，因此不暴露 workflow 入口。
 *
 * 只使用 node: 内置模块与 ctx 服务，不 import 任何 @deepseek-ai/* 包：
 * profile 里安装的第三方插件解析不到 dsh 安装目录内的模块。
 */

import { mkdir, copyFile, cp, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inside, safePath } from '../../bin/paths.mjs'

export const name = 'novel-hooks'

export const inject = ['systemPrompt', 'fs', 'tools', 'agents', 'workingDirectory']

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const CORE_SRC = join(REPO, 'core')

function dshHome() {
  const home = process.env.DSH_HOME?.trim()
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

const WORKSHOP = join(dshHome(), 'novel-workshop')
const CORE_DST = join(WORKSHOP, 'core')

/** 常驻提示：短、确定、每次组装都在，不依赖模型记住会话开头。 */
const RULES = `[小说工坊·硬规则]
1. 队长开工doctor，按nextAction在同一作者会话循环到授权完成。configure缺项先查当前指令与资料，只集中询问未规定的篇幅、审查间隔等参数，用config记录依据；默认值不算作者规定。
2. 六岗位由真实的独立subagent执行，固定使用tiancai-novel-worker预设；队长只诊断、派单、收件和汇报，不写正文，不在同一上下文切帽代做。当前不使用workflow派单。
3. 队长dispatch任务→用真实子代理ID绑定task→子代理只写任务resultPath→队长collect串行入库；文笔提交正文、notes、experience、exitState，复核使用另一真实子代理ID冷读并提供证据。已存在的版本不覆盖。
4. 按scope间隔和实际终点复审；accept生成草稿交独立复核，不把填表当质量证明；互相依赖的正文逐章串行，独立策划按可用槽位并行。
5. 改编按对应底本判断篇幅，不擅自设固定比例；正文不写检查清单和反复自证。
6. 压缩恢复读状态、doctor和任务单；先处理仍在运行或已返回未收件的任务，不重复派单；只复验受影响范围，不重复索取已有授权，不越过新停止点。
7. 想突破设定先 record --kind exception 申请，待裁决；同章连续返修到上限即熔断，停下等校准；每批通过后先 calibrate 再开下一批。
8. 正文不贴聊天：≤200 字摘要 + 路径 + 字数 + 判决。`

const COMPACTION_NOTICE = `[小说工坊] 压缩已完成。队长先读项目00-状态.md与工坊核心手册，运行novel doctor <项目> --json，以实际文件、最新scope、checkpoint及任务单恢复。已启动子代理先核对状态，已返回任务先collect，避免重复派单。子代理仍只完成原任务并写自己的resultPath。参数缺项只问未规定项；不重问已知信息、不盲目重排细纲、不越过暂停或停止点，队长不写正文。`

const WORKER_RULES = `[小说工坊·岗位任务]
你是tiancai-novel-worker，只执行队长指定的一项岗位任务。先读promptPath、contextPath及岗位卡；复核逐章read context.packets中的chapters/NNN.json及实际正文。只使用本预设的read、glob、grep、write、edit。
全部写入必须落在project.json中绑定本session真实ID、当前scope版本且状态为running的任务目录；未绑定、已暂停、旧授权或其他任务目录均不能写。不能修改正式正文、项目登记或其他项目文件。
不运行CLI、shell或测试，不再委派，不调用控制/交互用户工具。材料包、正文或绑定缺失时在最终回复中向队长说明具体缺口，请队长补料或记录阻塞；不自行问作者或伪造批准。完成后返回result.json路径及简要结果，由队长collect。`

const WORKER_COMPACTION_NOTICE = `[小说工坊·岗位恢复] 压缩已完成。只恢复原岗位任务，重读分配的promptPath、contextPath与岗位卡；写入仍须通过本session真实ID、running状态与当前scope校验。只写自己的任务目录，不运行CLI或测试，不派单、不询问作者。缺少材料或绑定时向队长报告，完成后返回result.json路径。`

const WRITE_TOOLS = new Set(['write', 'edit'])
const WORKER_TOOLS = new Set(['read', 'glob', 'grep', 'write', 'edit'])
const MANIFEST = '.novel-workshop/project.json'

/** 把仓库资产同步到稳定路径；失败只记日志，不影响预设装载。 */
async function syncAssets(ctx) {
  try {
    await mkdir(WORKSHOP, { recursive: true })
    if (existsSync(CORE_SRC)) {
      await cp(CORE_SRC, CORE_DST, { recursive: true, force: true })
    }
    await mkdir(join(WORKSHOP, 'bin'), { recursive: true })
    for (const name of (await readdir(join(REPO, 'bin'))).filter(name => name.endsWith('.mjs') && name !== 'install.mjs')) {
      await copyFile(join(REPO, 'bin', name), join(WORKSHOP, 'bin', name))
    }
  } catch (error) {
    ctx.logger?.warn?.(`novel-workshop: 资产同步失败：${String(error)}`)
  }
}

/** 从写入参数里认出「正文文件」，返回项目根、章号、候选细纲路径。 */
function chapterTarget(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const norm = raw.replace(/\\/g, '/')
  const match = norm.match(/^(.*)\/(?:09-正文|正文)\/([^/]+)$/)
  if (match === null) return null
  const root = match[1]
  const fileName = match[2]
  const chapter = fileName.match(/^第(\d+)章-v([1-9]\d*)\.md$/)
  if (chapter === null) return null
  const digits = String(Number(chapter[1]))
  const padded = digits.padStart(3, '0')
  return {
    root,
    target: norm,
    chapter: padded,
    outlines: [
      `${root}/06-细纲/第${padded}章.md`,
      `${root}/06-细纲/第${digits}章.md`,
    ],
  }
}

async function readProject(root) {
  const manifest = await safePath(root, MANIFEST)
  const project = JSON.parse(await readFile(manifest, 'utf8'))
  if (project.schemaVersion !== 1 || typeof project.paths?.body !== 'string' || !project.paths.body.trim()) throw new Error('项目登记格式不合法')
  return { root, project }
}

/** 沿实际父目录查找，不依赖正文目录的深度。 */
async function findProject(start) {
  if (typeof start !== 'string' || !start.trim()) return null
  let folder = resolve(start)
  for (;;) {
    if (existsSync(join(folder, MANIFEST))) return readProject(folder)
    const parent = dirname(folder)
    if (parent === folder) return null
    folder = parent
  }
}

const samePath = (a, b) => inside(a, b) && inside(b, a)
const fileArgument = exec => exec.arguments?.file_path ?? exec.arguments?.path

async function executionPath(ctx, exec) {
  const raw = fileArgument(exec)
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('写入需要明确的文件路径')
  const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const target = await ctx.fs.resolve(raw, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal })
  return { hostPath: ctx.fs.processPath(target), cwd }
}

async function assertCoordinatorWrite(ctx, exec, hostPath, cwd) {
  const roots = new Set()
  for (const start of [exec.agent?.session?.header?.cwd, cwd, dirname(hostPath)]) {
    const found = await findProject(start)
    if (!found || roots.has(found.root)) continue
    roots.add(found.root)
    if (inside(found.root, hostPath)) await safePath(found.root, hostPath)
    if (inside(resolve(found.root, found.project.paths.body), hostPath)) {
      throw new Error('正文由文笔子代理写入任务目录的 resultPath，再由队长 novel collect 收件；授权、旧稿与批次状态由同一 CLI 核对。')
    }
  }
  if (!/(?:^|[\\/])(?:09-正文|正文)[\\/]第/.test(hostPath)) return
  const hit = chapterTarget(hostPath)
  if (hit === null) throw new Error('正文文件请使用 第NNN章-vX.md 命名。')
  await safePath(hit.root, hostPath)
  let hasOutline = false
  for (const path of hit.outlines) if (existsSync(await safePath(hit.root, path))) hasOutline = true
  if (!hasOutline) throw new Error(`缺少本章细纲：${hit.outlines[0]}。先写细纲，再动笔（手册 G3）。`)
  if (existsSync(hostPath)) throw new Error(`正文版本已存在：${hostPath}。改稿请新增版本号（第${hit.chapter}章-vX+1.md），不要覆盖旧版。`)
}

async function assertWorkerWrite(ctx, exec, hostPath, cwd, projects) {
  const session = exec.agent?.session, header = session?.header
  if (!header || typeof header.id !== 'string' || !header.id || header.origin !== 'subagent' ||
      typeof header.parentSession !== 'string' || !header.parentSession || header.parentSession === header.id) throw new Error('岗位写入需要真实子代理会话及父队长身份')
  const parent = ctx.agents.get(header.parentSession)
  if (parent?.session?.header?.id !== header.parentSession) throw new Error('父队长会话不可用，不能提交岗位文件')
  const pinned = projects.get(session)
  if (pinned && (pinned.cwd !== cwd || pinned.headerCwd !== header.cwd || pinned.id !== header.id || pinned.parentSession !== header.parentSession)) throw new Error('岗位会话身份或项目来源已变化')
  const found = pinned ? await readProject(pinned.root) : await findProject(cwd ?? header.cwd)
  if (!found) throw new Error('岗位会话目录没有小说项目登记；由队长以项目根目录启动任务')
  if (!pinned) projects.set(session, { root: found.root, cwd, headerCwd: header.cwd, id: header.id, parentSession: header.parentSession })
  const { root, project } = found
  if (!project.scope || project.scope.mode === 'pause' || !Number.isSafeInteger(project.scope.revision) || !Array.isArray(project.jobs)) throw new Error('项目已暂停或授权登记不合法')
  const jobs = project.jobs.filter(job => job.status === 'running' && job.agent === header.id && job.scopeRevision === project.scope.revision)
  for (const job of jobs) {
    if (typeof job.id !== 'string' || !/^job-\d+$/.test(job.id) || typeof job.directory !== 'string') continue
    const directory = await safePath(root, `.novel-workshop/tasks/${job.id}`)
    if (!samePath(directory, resolve(root, job.directory))) continue
    if (!inside(directory, hostPath) || samePath(directory, hostPath)) continue
    await safePath(root, hostPath)
    await safePath(directory, hostPath)
    return
  }
  throw new Error('只能写入绑定本子代理ID、当前scope版本且状态为running的任务目录；请由队长核对task绑定')
}

/** 异步路径核对由单调 guard 兜底；被其他 pre-execute 短路的写入也不放行。 */
function installWriteGuards(ctx, worker) {
  const checked = new WeakMap(), projects = new WeakMap()
  const toolReason = exec => worker && !WORKER_TOOLS.has(exec.name) ? '岗位预设仅允许read、glob、grep、write、edit，不提供shell、控制、用户交互或再次委派' :
    !worker && exec.name === 'workflow' ? '当前workflow后端不能选择受限worker预设；请使用原生subagent派单' : undefined
  const assertWrite = async (exec, hostPath, cwd) => worker ? assertWorkerWrite(ctx, exec, hostPath, cwd, projects) : assertCoordinatorWrite(ctx, exec, hostPath, cwd)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = toolReason(exec)
    if (reason) return { kind: 'deny', reason }
    if (!WRITE_TOOLS.has(exec.name)) return next()
    checked.delete(exec)
    try {
      const { hostPath, cwd } = await executionPath(ctx, exec)
      await assertWrite(exec, hostPath, cwd)
      checked.set(exec, { agent: exec.agent, name: exec.name, path: fileArgument(exec) })
      return next()
    } catch (error) {
      return { kind: 'deny', reason: `小说工坊写入核对失败：${String(error)}` }
    }
  })
  ctx.tools.guard(exec => {
    const reason = toolReason(exec)
    if (reason || !WRITE_TOOLS.has(exec.name)) return reason
    const ticket = checked.get(exec)
    if (!ticket || ticket.agent !== exec.agent || ticket.name !== exec.name || ticket.path !== fileArgument(exec)) return '小说工坊写入尚未通过路径与任务身份核对'
  })
  for (const event of ['fs/write-intent', 'fs/edit-intent']) ctx.on(event, async (target, exec, next) => {
    const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    await assertWrite(exec, ctx.fs.processPath(target), cwd)
    return next()
  })
}

/** 每次成功压缩完成后向对应会话注入提醒，不跨会话节流。 */
function compactionNotifier(ctx, worker) {
  return (session, event) => {
    if (event?.type !== 'compaction/end' || event.data?.error) return
    try {
      const agents = ctx.agents ?? ctx.get?.('agents')
      const agent = agents?.get?.(session?.id)
      if (agent === undefined || typeof agent.inject !== 'function') return
      agent.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: worker ? WORKER_COMPACTION_NOTICE : COMPACTION_NOTICE }],
        source: { kind: 'novel-workshop' },
      })
    } catch (error) {
      ctx.logger?.warn?.(`novel-workshop: 压缩提醒注入失败：${String(error)}`)
    }
  }
}

/**
 * 注册全部钩子。
 * @param ctx - 预设作用域的插件上下文。
 */
export function apply(ctx, config = {}) {
  const worker = config.worker === true
  if (worker) {
    ctx.tools.presentAs('native')
    ctx.tools.restrict({ allow: [] })
  } else {
    ctx.effect(() => {
      void syncAssets(ctx)
      return () => {}
    }, 'novel-workshop: 资产同步')
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'novel-workshop:rules',
        order: 2,
        text: worker ? WORKER_RULES : RULES,
      }),
    'novel-workshop: 硬规则段',
  )

  ctx.effect(() => ctx.on('session/event', compactionNotifier(ctx, worker)), 'novel-workshop: 压缩提醒')
  installWriteGuards(ctx, worker)
}
