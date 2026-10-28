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
import { assertMaterialsRead, observeReading } from './materials.mjs'
import { registerWorkshop } from './workshop.mjs'
import { inspectDraft, inspectResult } from '../../bin/tasks.mjs'
import { runtime } from '../../bin/runtime.mjs'

export const name = 'novel-hooks'

export const inject = ['systemPrompt', 'fs', 'tools', 'agents', 'workingDirectory', 'subagents']

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
核心手册绝对路径：${runtime.manual}；派单协议：${runtime.protocol}。沿用doctor.runtime中的同一路径，不重复读稳定副本和源码副本，不把~当原生read可展开的路径。
1. 新会话仅查看资料/确认进度用doctor options.inspect=true，不修登记、不派finish、不恢复旧scope；明确恢复制作后inspect=false。正在制作中的普通进度提问简报后继续原授权。队长开工用novel_workshop action=doctor，按nextAction.call在同一作者会话续作到授权完成。configure缺项先查当前指令与资料，只集中询问未规定参数，用config记录依据；默认值不算作者规定。
现有文档用action=documents按用途、标题和目录查找，再read相关段落；config.data.documents可绑定现有路径。默认文件不存在不代表没有资料；先复用，必要时原位补丁，无缺口时artifacts为空，多份候选先分析选择，不直接新建同类文档。
选定分册用config.data.outlines按path/from/to及source一次绑定范围，逐章map仍优先；不逐章重选同一册。已有进度MD由程序原位同步，保留作者原要求与历史，无须另派抄录或重问维护授权。
2. 项目没有 .novel-workshop/project.json 时，第一步必须 import（既有稿）或 init（新书）；登记前不得改任何正文。项目自带的 python/ps1 脚本与手写台账只作资料，不能代替工坊 CLI。
3. 六岗位由真实的独立subagent执行，固定使用tiancai-novel-worker预设；队长只诊断、派单、收件和汇报，不写正文，不在同一上下文切帽代做，不使用workflow。
4. novel_workshop dispatch自动建单、绑定真实ID并启动全新worker，无需手动subagent/task/send_message。本会话明确scope后，成功collect会按诊断自动启动下一岗位；返回continuation时只等该单完成通知，不重复dispatch或结束等作者催促。未自动启动才用nextAction.call，不重复doctor。scope options.automatic=false可仅手动派单；只读、暂停、中止后不自动续作。复核使用另一真实子代理ID，旧正文不覆盖。
5. 派单后等宿主完成通知，再collect；不轮询、不在聊天收正文、不发送内联材料让无工具worker继续写。队长仅有专用工坊工具与只读材料工具，没有shell或直接write/edit入口。工具列表若出现ops_bash、ops_read_files、ops_discover_tools、MCP或其他宿主通用工具，一律不调用；只用novel_workshop、read、glob、grep、ask_user_question、list_agents、interrupt_agent、todo_write与goal工具。
6. 从只读恢复先doctor options.inspect=false，再立即scope保存最新操作/范围/原话，之后才处理诊断待办；不先scope撞守卫、不先收旧scope任务。按scope间隔和实际终点复审；互相依赖的正文逐章串行，只有finish按nextAction.call批量补现稿记录。逐章verdict保留独立通过的未变章，仅复验未通过及受影响章，跨章阻塞仍完整处理。
7. 改编按对应底本判断篇幅，不从历史比例擅设95%门槛或逐句补字；返修用当前稿patches，排版用format避免重抄整章，字数相同不等于文本相同。提交后先独立复验resolutions，可选建议不阻塞通过，无当前作者依据不把井号/缩进偏好升级阻塞。
8. 压缩恢复读状态、doctor和任务单；先处理仍在运行或已返回未收件的任务，不重复派单；只复验受影响范围，不重复索取已有授权，不越过新停止点。
scope缩小按返回jobs.kept/cancelled核对本单是否继续，不在返回前承诺不中断；暂停、越界或依据变化仍停笔。
复核保存result.json会收到预检。collect遇到字段/引文错误时保留原单并自动回叫原复核代理，仅修同一报告；等完成通知再collect，不标failed、手工补issues或重派整批冷读。correct-result可恢复此操作，同单最多3次；真实材料变化或执行失败另按具体原因处理。
9. 想突破设定先 record --kind exception 申请，待裁决；同章连续返修到上限即熔断，停下等校准；每批通过后先 calibrate 再开下一批。
目标完成后程序自动archive过程资料；若nextAction=archive直接调用，不派整理子代理。未完成、暂停、仍有未收件任务不整理；inspect只读不整理。额外临时资料record material temporary/category登记，正式稿、现行文档、报告及当前引用保留。历史任务用task编号取归档路径。
10. 正文不贴聊天：≤200 字摘要 + 路径 + 字数 + 判决。`

const COMPACTION_NOTICE = `[小说工坊] 压缩已完成。队长先读项目00-状态.md与工坊核心手册，运行novel doctor <项目> --json，以实际文件、最新scope、checkpoint及任务单恢复。已启动子代理先核对状态，已返回任务先collect，避免重复派单。子代理仍只完成原任务并写自己的resultPath。参数缺项只问未规定项；不重问已知信息、不盲目重排细纲、不越过暂停或停止点，队长不写正文。`

const WORKER_RULES = `[小说工坊·岗位任务]
你是tiancai-novel-worker，只执行队长指定的一项岗位任务。按promptPath、contextPath、岗位卡及requiredReads清单读全实际输入，共享文件只读一次，独立read可同一步并行。复核任务优先读reviewReadings/sharedReviewReading，不逐份重复已整合的packets/textFiles。版本用材料里的实际路径；未提供的历史章先glob，不猜-vX。材料已切片，不额外通读整册、project.json或插件源码查协议。只使用read、glob、grep、write、edit及绑定本任务的novel_draft计量。
文笔写作/返修先完成完整稿，再集中修订与计量，不逐句补字追比例；已有完整草稿可用draftFile交稿。finish单只从manuscripts当前正文提取各章记录，不复制正文、不交text/draftFile/patches、不按写作流程重读底本或旧任务；保存result.json由宿主自动计量现稿，任务完成或归档后不要再调用novel_draft，补登记不代表独立复核通过。复核跨章问题用affectedChapters/from/to覆盖全部待改章，contract/stamp由宿主补齐，结论与真实引文仍由你独立给出。
复核按context.resultContract交字段：issues每项含text和evidence:{path,quote}；passed各维grade用A/B及真实reason，不填“良好”。quote逐字复制连续短句，不拼接或补引号，无需整段对话。保存result.json后先处理宿主预检反馈再结束。原单结果回修只读prompt/context/岗位卡/原result.json，已有完整阅读及依据仍有效时不重读整批，只能改result.json；保留实质判断，不为校验抬分、降级阻塞或伪造通过。
全部写入必须落在project.json中绑定本session真实ID、当前scope版本且状态为running的任务目录；未绑定、已暂停、旧授权或其他任务目录均不能写。不能修改正式正文、项目登记或其他项目文件。
不运行CLI、shell或测试，不再委派，不调用控制/交互用户工具。ops_bash、ops_read_files、ops_discover_tools、MCP或其他宿主工具即使出现在工具列表，也不得调用；只使用read、glob、grep、write、edit及novel_draft。工具不可用、read返回空或材料缺失时立即停止并在结果里报告具体缺口，绝不凭记忆补写正文或假装读过材料。完成后返回result.json路径及简要结果，由队长collect。`

const WORKER_COMPACTION_NOTICE = `[小说工坊·岗位恢复] 压缩已完成。只恢复原岗位任务，重读分配的promptPath、contextPath与岗位卡；写入仍须通过本session真实ID、running状态与当前scope校验。只写自己的任务目录，不运行CLI或测试，不派单、不询问作者。缺少材料或绑定时向队长报告，完成后返回result.json路径。`

const WRITE_TOOLS = new Set(['write', 'edit'])
const WORKER_TOOLS = new Set(['read', 'glob', 'grep', 'write', 'edit', 'novel_draft'])
const CAPTAIN_TOOLS = new Set(['novel_workshop', 'read', 'glob', 'grep', 'ask_user_question', 'list_agents', 'interrupt_agent', 'todo_write', 'get_goal', 'create_goal', 'update_goal'])
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

async function assertWorkerWrite(ctx, exec, hostPath, cwd, projects, options) {
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
    if (job.resultCorrection?.pending && !options?.measure && !samePath(hostPath, resolve(directory, 'result.json'))) throw new Error('本次仅回修原复核结果，只能修改本单result.json，不写草稿或其他文件')
    await safePath(root, hostPath)
    await safePath(directory, hostPath)
    await assertMaterialsRead(exec, root, job, hostPath, options)
    return { root, project, job }
  }
  throw new Error('只能写入绑定本子代理ID、当前scope版本且状态为running的任务目录；请由队长核对task绑定')
}

/** 异步路径核对由单调 guard 兜底；被其他 pre-execute 短路的写入也不放行。 */
function installWriteGuards(ctx, worker) {
  const checked = new WeakMap(), projects = new WeakMap()
  const toolReason = exec => worker && !WORKER_TOOLS.has(exec.name) ? '岗位预设仅允许文件工具及novel_draft计量，不提供shell、控制、用户交互或再次委派' :
    !worker && !CAPTAIN_TOOLS.has(exec.name) ? '队长读取文件用read/glob/grep，ops_read_files等额外宿主工具未接入本预设；制作用novel_workshop，不提供shell、直接写入或手动派单；不要用shell或插件源码排查替代正确工具参数' : undefined
  const assertWrite = async (exec, hostPath, cwd) => worker ? assertWorkerWrite(ctx, exec, hostPath, cwd, projects) : Promise.reject(new Error('队长文件提交只能经专用工坊工具，由collect维护版本与验收'))
  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = toolReason(exec)
    if (reason) return { kind: 'deny', reason }
    if (!WRITE_TOOLS.has(exec.name)) return next()
    checked.delete(exec)
    try {
      const { hostPath, cwd } = await executionPath(ctx, exec)
      const binding = await assertWrite(exec, hostPath, cwd)
      checked.set(exec, { agent: exec.agent, name: exec.name, path: fileArgument(exec), hostPath, binding })
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
    // actor 按宿主类型允许缺省；非工具写入没有可核对的身份，交给其他策略处理。
    if (exec === undefined || exec.agent === undefined) return next()
    const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    await assertWrite(exec, ctx.fs.processPath(target), cwd)
    return next()
  })
  if (worker) ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind === 'block' || result.isError) return decision
    if (exec.name === 'read') observeReading(exec, result)
    const ticket = WRITE_TOOLS.has(exec.name) && checked.get(exec)
    const binding = ticket?.binding
    if (!binding || !['文笔', '复核'].includes(binding.job.role) ||
        !samePath(ticket.hostPath, resolve(binding.root, binding.job.directory, 'result.json'))) return decision
    let feedback
    try {
      if (binding.job.role === '复核') {
        const checked = await inspectResult(binding.root, binding.project, binding.job.id)
        feedback = `result.json已保存，复核结果预检通过：${JSON.stringify(checked)}\n尚未正式收件；返回原结果路径即可，不再为了字段或引文重派整批冷读。`
      } else {
        const count = await inspectDraft(binding.root, binding.project, { task: binding.job.id, file: ticket.hostPath })
        feedback = `result.json已保存，宿主自动计量：${JSON.stringify(count)}\n本次结果无需重复调用novel_draft；按实际计量和场景完整性修订后再交回队长。`
      }
    } catch (error) {
      feedback = binding.job.role === '复核' ? `result.json已保存，但复核结果预检未通过：${error.message}\n只在本单修正原报告字段或连续引文，保留实质判断；不为校验抬分、降级阻塞或伪造通过，不结束为“已完成”、不重读整批或重派。修改后再次保存result.json。` :
        `result.json已保存，但尚不能计量：${error.message}。请在本任务内修正结果；这不是收件通过，也不必重新派单。`
    }
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), {
      id: randomUUID(), role: 'user', content: [{ type: 'text', text: feedback }], source: { kind: 'novel-workshop' },
    }] }
  })
  if (worker) ctx.tools.register({
    name: 'novel_draft', description: '文笔计量本任务草稿、patches/format结果；复核和finish读取本单当前正式稿计量，无须复制正文。排除章题，按Unicode汉字计数；字数相同不证明文本相同，返修另给comparison。result.json保存后宿主自动计量，任务完成后无需再调用。不改主账，不运行测试。',
    parameters: { type: 'object', additionalProperties: false, required: ['file_path'], properties: { file_path: { type: 'string', description: '本任务草稿或result.json绝对路径；当前稿也可使用本单manuscript/manuscripts或reviewReadings中的正文视图路径' } } },
    output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] } },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { hostPath, cwd } = await executionPath(ctx, { ...exec, arguments: args })
      const { root, project, job } = await assertWorkerWrite(ctx, exec, hostPath, cwd, projects, { measure: true })
      return inspectDraft(root, project, { task: job.id, file: hostPath })
    },
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
 * 钩子与工具先同步注册，最后等待资产同步完成再结束插件装载；
 * 这样首个模型步骤读到的手册与仓库 core 一致，不会读到上一版缓存。
 * @param ctx - 预设作用域的插件上下文。
 */
export async function apply(ctx, config = {}) {
  const worker = config.worker === true
  const allow = worker ? [...WORKER_TOOLS] : [...CAPTAIN_TOOLS]
  const requiredTools = worker ? [...WORKER_TOOLS] : ['novel_workshop', 'read', 'glob', 'grep', 'ask_user_question']
  const presetId = worker ? 'tiancai-novel-worker' : 'tiancai-novel'
  const applied = new WeakSet()
  const isolate = (agent) => {
    if (!agent?.ctx?.tools || applied.has(agent)) return
    applied.add(agent)
    try {
      ctx.effect(() => agent.ctx.tools.presentAs('native'), 'novel-workshop: 工具展示')
      ctx.effect(() => agent.ctx.tools.restrict({ allow }), 'novel-workshop: 工具隔离')
      for (const name of requiredTools) {
        if (!agent.ctx.tools.get(name, agent)) throw new Error(`小说预设缺少可用工具${name}，停止启动；请更新bundle并重启DSH，不以零工具继续制作`)
      }
    } catch (error) {
      applied.delete(agent)
      throw error
    }
  }
  // 预设是多个agent的父作用域，在实际实例上限制继承工具。
  ctx.on('agent/created', ({ agent }) => isolate(agent))
  // 标准会话在首轮前切到小说预设不会重发agent/created；这里补做实例级隔离。
  ctx.on('agent-preset/selected', (sessionId, selected) => {
    if (selected !== presetId) return
    const agent = ctx.agents?.get?.(sessionId)
    if (!agent) return
    try { isolate(agent) } catch (error) { ctx.logger?.warn?.(`novel-workshop: 切换预设后的工具隔离失败：${String(error)}`) }
  })
  const workshopEvents = worker ? null : registerWorkshop(ctx)

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'novel-workshop:rules',
        order: 2,
        text: worker ? WORKER_RULES : RULES,
      }),
    'novel-workshop: 硬规则段',
  )

  const notifyCompaction = compactionNotifier(ctx, worker)
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    workshopEvents?.(session, event)
    notifyCompaction(session, event)
  }), 'novel-workshop: 压缩提醒与中止续作')
  installWriteGuards(ctx, worker)
  // 插件热重载/已存在的会话：按当前composition补做隔离，避免只在agent/created时生效。
  for (const agent of ctx.agents?.list?.() ?? []) {
    try {
      if (ctx.get?.('agentPresets')?.composedPreset?.(agent.ctx) === presetId) isolate(agent)
    } catch (error) {
      ctx.logger?.warn?.(`novel-workshop: 核对既有agent失败：${String(error)}`)
    }
  }
  // 失败只记日志，不阻止预设装载；成功后才允许首个agent启动。
  if (!worker) await syncAssets(ctx)
}
