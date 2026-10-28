import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { run } from '../../bin/novel.mjs'
import { runtime } from '../../bin/runtime.mjs'
import * as P from '../../bin/project.mjs'
import * as T from '../../bin/tasks.mjs'
import * as W from '../../bin/production.mjs'
import { DSH_RUNTIME } from './materials.mjs'

const commands = ['doctor', 'documents', 'init', 'import', 'config', 'scope', 'source', 'gate', 'map', 'record', 'calibrate', 'checkpoint', 'check', 'merge', 'dispatch', 'collect', 'correct-result', 'task', 'archive']
const readOnly = new Set(['doctor', 'documents', 'check', 'task'])
const string = { type: 'string' }, number = { type: 'integer', description: '≥0' }, boolean = { type: 'boolean' }
const list = { type: 'array', items: number, description: '至少一项；空数组不要传' }
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) })
const choice = values => ({ type: 'string', enum: values })
const span = { from: number, to: number }, source = { type: 'string', description: '用户原话或当前有效文档依据' }
const config = object({ mode: choice(['原创', '改编精修']), plan: object({ start: number, end: number }, ['start', 'end']),
  words: { type: 'integer', description: '≥1' }, interval: { type: 'integer', description: '≥1' }, maxRepairRounds: { type: 'integer', description: '≥1' },
  length: object({ type: choice(['fixed', 'source']), minRatio: { type: 'number', description: '≥0；不设上限时留空' }, maxRatio: { type: 'number', description: '≥0；不设上限时留空' }, note: string, source }, ['type']),
  metadata: object({ author: string, description: string, language: string, cover: { type: 'string', description: '封面路径；无封面时留空' } }),
  documents: object(Object.fromEntries(['idea', 'world', 'characters', 'outline', 'style', 'synopsis', 'notes', 'experience'].map(kind => [kind, { type: 'string', description: '项目内已有MD/TXT文档路径；绑定须说明source，不自动批准内容' }]))), source })
config.properties.outlines = { type: 'array', description: '按当前执行依据一次绑定整册/范围，逐章map优先于此绑定',
  items: object({ path: string, ...span, source }, ['path', 'from', 'to']) }
config.properties.progressFiles = { type: 'array', items: string, description: '已有进度MD文档；程序原位同步当前状态，空数组停用，保留历史原文' }
config.properties.autoArchive = { type: 'boolean', description: '默认true，目标完成后自动分类归档过程资料；false仅关闭自动归档，仍可手动archive' }
for (const name of ['minRatio', 'maxRatio']) config.properties.length.properties[name] = { oneOf: [{ type: 'number' }, { type: 'null' }], description: '作者规定的非负比例；未规定传null' }
const specs = {
  doctor: { options: object({ fix: { type: 'boolean', description: '修复登记；必须放在options内，inspect=true时不能使用' },
    inspect: { type: 'boolean', description: '新请求仅读取资料/确认进度时设true，不改登记或派单；作者明确要求恢复制作后设false。同一制作任务中的普通进度提问不切换此模式。' } }) },
  documents: { options: object({ kind: choice(['idea', 'world', 'characters', 'outline', 'style', 'synopsis', 'notes', 'experience', 'chapters', 'source']), query: string, offset: number, limit: { type: 'integer', description: '≥1' } }) },
  init: { options: object({ title: string, mode: choice(['原创', '改编精修']), start: number, end: number, chapters: number, words: number,
    interval: number, length: choice(['fixed', 'source']), volumes: number, source }) },
  import: { options: object({ title: string, mode: choice(['原创', '改编精修']), body: string, baseline: string, encoding: string,
    outline: string, notes: string, experience: string, start: number, end: number, words: number, interval: number, length: choice(['fixed', 'source']), source }) },
  config: { data: config, required: ['data'] },
  scope: { options: object({ mode: choice(['continue', 'review', 'revise', 'pause', 'export']), ...span, source, deliver: boolean, format: string,
    automatic: { type: 'boolean', description: '默认true，本会话明确scope后，成功collect自动启动诊断给出的下一岗位；false仅手动派单。只读、暂停或中止后不自动续作。' },
    'revise-approved': boolean, interval: { type: 'integer', description: '仅作者明确修改审查间隔时传；普通范围变更不要传' } }, ['mode', 'source']), required: ['options'] },
  source: { options: object({ file: { type: 'string', description: '小说底本，必须含第N章/引子标题；现行要求文件用record保存，不用source' }, encoding: string }, ['file']), required: ['options'] },
  gate: { options: object({ gate: { type: 'integer', enum: [0, 1, 2, 3] }, through: { type: 'integer', enum: [0, 1, 2, 3] },
    evidence: { type: 'string', description: '已有证据文件路径；不要填说明段落' }, source }, ['evidence', 'source']), required: ['options'] },
  map: { data: object({ chapter: number, sourceIds: list, treatment: choice(['保留', '改写', '合并', '删除', '新增', '校正', '联动']), outline: string,
    dependencies: { type: 'array', items: number }, entities: { type: 'array', items: string }, factIds: { type: 'array', items: string },
    entryState: {}, exitState: {}, note: string }, ['chapter', 'treatment']), required: ['data'] },
  record: { options: object({ kind: choice(['requirement', 'fact', 'issue', 'experience', 'material', 'exception']) }, ['kind']),
    data: { type: 'object', description: 'requirement: text/source；fact或issue: text/evidence{path,quote}；experience: text；material: path/kind，工作临时资料另填temporary:true和category(temporary/cleanup/research)，目标完成后归档；exception: text/cost。更新用原id，作用范围from/to。', additionalProperties: true }, required: ['options', 'data'] },
  calibrate: { data: { type: 'object', description: '批次校准outline/note；作者熔断校准chapters/note/source', additionalProperties: true }, required: ['data'] },
  checkpoint: { data: { type: 'object', additionalProperties: true }, required: ['data'] },
  check: {},
  merge: { options: object({ artifact: choice(['adaptation', 'source', 'analysis']), edition: choice(['partial', 'final']), ...span, format: string }) },
  dispatch: { options: object({ role: choice(['主编', '世界', '人物', '剧情', '文笔', '复核']),
    action: choice(['plan', 'capture-requirements', 'decision', 'facts', 'outline', 'map-source', 'calibrate', 'write', 'repair', 'repair-length', 'repair-format', 'finish', 'review', 'final-review']),
    chapter: number, chapters: list, ...span, review: { type: 'string', description: '仅calibrate对应的已登记审阅ID，不是额外提示词' } }, ['role', 'action']), required: ['options'] },
  collect: { options: object({ id: string }, ['id']), required: ['options'] },
  'correct-result': { options: object({ id: { type: 'string', description: '原running复核任务ID；仅回叫原执行者修结果字段/连续引文，不重派冷读' } }, ['id']), required: ['options'] },
  task: { options: object({ id: string, status: choice(['failed', 'cancelled']), reason: string }) },
  archive: { options: object({ preview: boolean, offset: number, limit: number }) },
}
const optionList = commands.filter(action => specs[action].options).map(action => `${action}:${Object.keys(specs[action].options.properties).join('/') || '(无)'}`).join('；')
const dataList = commands.filter(action => specs[action].data).map(action => {
  const shape = specs[action].data
  return `${action}:${shape.properties ? Object.keys(shape.properties).join('/') : '按动作字段'}`
}).join('；')
// OpenAI兼容供应商要求function的parameters是object根；根级oneOf/anyOf会被判非法schema。
// 具体动作的键约束由validateCall与下面描述承担，根结构保持供应商已验证的object。
function mergedProperties(name) {
  const result = {}
  for (const spec of Object.values(specs)) for (const [key, value] of Object.entries(spec[name]?.properties ?? {})) {
    const old = result[key]
    result[key] = old?.enum && value.enum ? { ...value, enum: [...new Set([...old.enum, ...value.enum])] } : value
  }
  return result
}
const parameters = {
  type: 'object',
  properties: {
    action: choice(commands),
    project: string,
    options: { type: 'object', properties: mergedProperties('options'), additionalProperties: false, description: `按动作的命名参数（不带--）；${optionList}` },
    data: { type: 'object', properties: { ...mergedProperties('data'), source: {},
      text: string, from: number, to: number, temporary: boolean, category: { type: 'string', description: 'temporary=true时用temporary/cleanup/research；只标记实际工作临时资料' },
      evidence: object({ path: string, quote: string }, ['path', 'quote']) },
      additionalProperties: true, description: `按动作的JSON数据；${dataList}。map.treatment用改写/联动等枚举，不用重写；record的kind放options，内容放data。` },
  },
  required: ['action'],
  additionalProperties: false,
}
function validateShape(value, shape, path) {
  if (!shape) return
  if (shape.oneOf) {
    if (!shape.oneOf.some(item => { try { validateShape(value, item, path); return true } catch { return false } })) throw new Error(`${path}类型不符合定义`)
    return
  }
  const valid = shape.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) :
    shape.type === 'array' ? Array.isArray(value) : shape.type === 'integer' ? Number.isSafeInteger(value) :
      shape.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : shape.type === 'null' ? value === null : !shape.type || typeof value === shape.type
  if (!valid) throw new Error(`${path}需要${({ object: '对象', array: '数组', integer: '整数', number: '数值', string: '字符串', boolean: '布尔值', null: 'null' })[shape.type]}`)
  if (shape.enum && !shape.enum.includes(value)) throw new Error(`${path}支持${shape.enum.join('、')}`)
  if (shape.type === 'array') for (const item of value) validateShape(item, shape.items, `${path}[]`)
  if (shape.type === 'object') {
    for (const key of shape.required ?? []) if (value[key] === undefined) throw new Error(`${path}缺少${key}`)
    for (const [key, item] of Object.entries(value)) {
      if (shape.additionalProperties === false && !Object.hasOwn(shape.properties ?? {}, key)) throw new Error(`${path}不支持${key}；支持${Object.keys(shape.properties ?? {}).join('、')}`)
      validateShape(item, shape.properties?.[key], `${path}.${key}`)
    }
  }
}
function validateCall(args) {
  for (const key of Object.keys(args)) if (!['action', 'project', 'options', 'data'].includes(key)) throw new Error(`根参数不支持${key}；动作参数放options，结构化内容放data`)
  const spec = specs[args.action]
  if (!spec) throw new Error('不支持该工坊动作；正文与复核只能由独立岗位经collect提交')
  for (const name of spec.required ?? []) if (args[name] === undefined) throw new Error(`${args.action}需要${name}；请按本动作工具参数结构填写`)
  for (const name of ['options', 'data']) {
    const value = args[name]
    if (value === undefined) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}需要对象`)
    const shape = spec[name]
    if (!shape && Object.keys(value).length) throw new Error(`${args.action}不接收${name}，请使用本动作规定的参数位置`)
    validateShape(value, shape, `${args.action}.${name}`)
  }
}
const examples = {
  doctor: { action: 'doctor', options: { fix: true } },
  scope: { action: 'scope', options: { mode: 'continue', from: 481, to: 483, source: '作者本轮原话' } },
  gate: { action: 'gate', options: { through: 3, evidence: 'docs/现行要求与执行计划.md', source: '已核实的真实批准依据' } },
  map: { action: 'map', data: { chapter: 481, sourceIds: [481], treatment: '改写', outline: 'docs/现行细纲.md' } },
  record: { action: 'record', options: { kind: 'requirement' }, data: { text: '当前有效要求', source: '作者或文档真实依据', from: 481, to: 483 } },
  source: { action: 'source', options: { file: 'docs/正式小说底本.txt', encoding: 'utf-8' } },
  config: { action: 'config', data: { outlines: [{ path: 'docs/现行分册细纲.md', from: 481, to: 483 }], source: '当前要求明确采用此册' } },
}
function publicResult(result) {
  if (!result?.id?.startsWith('job-')) return result
  const { id, directory, role, action, chapters, scopeRevision, status, agent, runtime, reason, promptPath, resultPath, contextPath, archive, archivedIn } = result
  const value = { id, directory, role, action, chapters, scopeRevision, status, agent, runtime, reason, promptPath, resultPath, contextPath,
    ...(archive ? { archive } : {}), ...(archivedIn ? { archivedIn } : {}) }
  if (result.output) {
    const { path, version, length, review } = result.output
    value.output = { path, version, length, ...(result.output.receipts ? { registeredChapters: result.output.receipts.map(row => row.chapter) } : {}), ...(review ? { review: { id: review.id, verdict: review.verdict,
      chapters: review.chapters.map(row => ({ chapter: row.chapter, version: row.version, verdict: P.rowVerdict(review, row) })), issues: review.issues.length,
      resolved: review.resolutions?.filter(item => item.status === 'resolved').map(item => item.id) ?? [] } } : {}) }
  }
  return value
}
// 保持CLI原有JSON输出语义；旧台账缺项、记录history中的undefined不能直接进入宿主typed结果。
const jsonValue = value => JSON.parse(JSON.stringify(value))

function options(argv, flags) {
  if (flags === undefined) return
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) throw new Error('options需要命名参数对象')
  for (const [name, value] of Object.entries(flags)) {
    if (!/^[a-z][a-z-]*$/.test(name)) throw new Error(`无效选项：${name}`)
    if (value === false && argv[0] === 'scope' && ['revise-approved', 'deliver'].includes(name)) { argv.push(`--${name}=false`); continue }
    if (value === false || value === null) continue
    if (value === true) argv.push(`--${name}`)
    else if (['string', 'number'].includes(typeof value)) argv.push(`--${name}=${value}`)
    else if (Array.isArray(value) && value.every(item => ['string', 'number'].includes(typeof item))) argv.push(`--${name}=${value.join(',')}`)
    else throw new Error(`选项${name}只接受字符串、数值、布尔值或列表；结构化数据放在data`)
  }
}

export function registerWorkshop(ctx) {
  const inspecting = new WeakSet()
  const continuing = new WeakMap()
  const definition = {
    name: 'novel_workshop',
    description: '小说工坊专用入口。仅查资料/确认进度用doctor options.inspect=true，只读汇报不恢复旧任务；明确恢复制作后inspect=false。doctor修复用options.fix=true，不能放根级。documents检索、config绑定已有资料；scope保存真实作者范围；dispatch启动岗位worker，完成后collect续作。',
    parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] } },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent || ctx.agents.get(parent.session.header.id) !== parent) throw new Error('工坊操作需要真实存活的队长会话')
      if (args.action === 'task' && args.options?.status && !['failed', 'cancelled'].includes(args.options.status)) throw new Error('真实执行者由dispatch自动绑定，不能手填或替换agent')
      try { validateCall(args) } catch (error) {
        throw new Error(`${error.message}${examples[args.action] ? `；本动作调用示例（路径与依据须换为实际值）：${JSON.stringify(examples[args.action])}` : ''}`)
      }
      if (args.project !== undefined && (typeof args.project !== 'string' || !args.project.trim())) throw new Error('project需要明确的项目根目录')
      const cwd = await ctx.workingDirectory.ensure(parent, exec.signal)
      // 相对路径按会话当前工作目录解析；绝对路径由 resolve 原样保留。
      const root = resolve(cwd, args.project ?? '.')
      const flags = args.options ?? {}
      if (args.action === 'doctor' && flags.inspect === true && flags.fix === true) throw new Error('inspect只读，不能同时fix；当前只确认进度时不要修复登记或派finish')
      if (args.action === 'doctor' && flags.inspect === false) inspecting.delete(parent.session)
      const preview = args.action === 'archive' && flags.preview === true
      const mutation = !readOnly.has(args.action) && !preview || args.action === 'doctor' && flags.fix === true || args.action === 'task' && flags.status !== undefined
      if (inspecting.has(parent.session) && mutation) throw new Error('本会话当前仅确认进度，不执行修复登记、scope、派单或收件；待作者明确恢复制作后doctor options.inspect=false，再按真实授权继续')
      const argv = [args.action, root]
      const { automatic, ...scopeFlags } = flags
      options(argv, args.action === 'scope' ? scopeFlags : flags)
      if (args.action === 'task' && flags.status && !['failed', 'cancelled'].includes(flags.status)) throw new Error('真实执行者由dispatch自动绑定，不能手填或替换agent')
      if (args.action === 'task' && flags.status === 'failed') {
        const job = (await P.load(root)).jobs.find(job => job.id === flags.id)
        if (job?.resultCorrection?.pending) throw new Error('原复核代理正在回修结果，先等完成通知后collect；作者取消时用scope pause或明确cancelled，不把字段回修冒充执行失败')
      }
      if (args.action === 'dispatch') {
        const project = await P.load(root)
        let job = await T.dispatch(root, project, { ...flags, chapters: flags.chapters === undefined ? undefined : String(flags.chapters).split(',') })
        if (job.status === 'running' && job.runtime === DSH_RUNTIME) return jsonValue({ result: publicResult(job), waiting: true, instruction: '该任务已启动，等完成通知后collect，不重复派单或轮询' })
        if (job.agent) {
          await T.updateTask(root, project, { id: job.id, status: 'cancelled', reason: '旧宿主任务未通过当前DSH派单入口，保留产物后重新派发' })
          job = await T.dispatch(root, project, { ...flags, chapters: flags.chapters === undefined ? undefined : String(flags.chapters).split(',') })
        }
        const current = project.jobs.find(item => item.id === job.id), childId = randomUUID()
        current.runtime = DSH_RUNTIME
        current.parentSession = parent.session.header.id
        await T.updateTask(root, project, { id: job.id, status: 'running', agent: childId })
        try {
          const activation = await ctx.subagents.startActivation({ childId, provider: 'spawn', label: `${job.id} · ${job.role} · ${job.action}`,
            request: { parent, cwd: root, agentPreset: 'tiancai-novel-worker', maxDepth: ctx.subagents.resolveMaxDepth(1),
              prompt: [{ type: 'text', text: `项目：${root}\n任务已绑定你的真实ID。只完成这一单；实际read以下输入后再写结果，不接受内联材料或在聊天交正文。\npromptPath：${job.promptPath}\ncontextPath：${job.contextPath}\nresultPath：${job.resultPath}\n按任务单、岗位卡与context.json的requiredReads完整读取；复核任务优先reviewReadings/sharedReviewReading，不再逐份重复已整合的packets/textFiles。材料或工具不可用即报告阻塞，不凭记忆补写、不转任复核、不自行接下一章。` }] },
            signal: exec.signal, delivery: 'parent' })
          if (activation.childId !== childId) throw new Error('宿主返回的子代理ID与预留绑定不一致')
        } catch (error) {
          await T.updateTask(root, await P.load(root), { id: job.id, status: 'failed', reason: `原生派单失败：${error.message}` })
          throw error
        }
        return jsonValue({ result: publicResult(T.taskInfo(root, current)), waiting: true, instruction: '等待宿主完成通知后collect；不要睡眠轮询、发送追加正文要求或复用本worker写下一章' })
      }
      if (args.action === 'correct-result') {
        const project = await P.load(root), job = T.requireJob(project, flags.id, '复核', undefined, ['review', 'final-review'])
        if (job.runtime !== DSH_RUNTIME || job.parentSession && job.parentSession !== parent.session.header.id) throw new Error('仅原DSH父会话可回叫该复核代理修原单结果，不替换执行者')
        await T.assertReadReceipt(root, job)
        await T.assertTaskBasis(root, project, job)
        if (job.resultCorrection?.pending) return jsonValue({ result: publicResult(T.taskInfo(root, job)), waiting: true, instruction: '原代理已收到结果回修要求，等宿主完成通知后collect，不重复回叫' })
        let problem
        try {
          const checked = await T.inspectResult(root, project, job.id)
          return jsonValue({ result: publicResult(T.taskInfo(root, job)), checked, recovery: { call: { action: 'collect', project: root, options: { id: job.id } } } })
        } catch (error) { problem = error.message }
        const previous = job.resultCorrection, attempts = (previous?.attempts ?? 0) + 1
        if (attempts > 3) return jsonValue({ result: publicResult(T.taskInfo(root, job)), blocked: true, error: problem, instruction: '本单结果回修已达3次，保留原报告并汇报具体缺口，不伪造通过或循环重派整批冷读' })
        if (exec.signal?.aborted) throw new Error('当前操作已中止，不回叫复核代理')
        job.resultCorrection = { attempts, pending: true, error: problem, time: new Date().toISOString() }
        await P.save(root, project)
        try {
          const info = T.taskInfo(root, job)
          const messageId = await ctx.subagents.sendMessage(parent, job.agent, [{ type: 'text', text:
            `原单结果回修：${job.id}，项目${root}。你仍是原复核代理，只修自己的result.json字段或引文，不接新章、不写正文、不改主账。\npromptPath：${info.promptPath}\ncontextPath：${info.contextPath}\nresultPath：${info.resultPath}\n本单材料与版本已重新核实，你原有完整阅读回执仍有效。先read原prompt、context、岗位卡与当前result.json；无需重新冷读整批，必要时只回查相关原句。只能写result.json。\n以下为程序校验错误，不是作者新要求：\n${problem}\n按context.resultContract和模板修正；保留实质判断，不为过校验抬分、降级阻塞或伪造通过。若原判决本身矛盾，按已读事实如实报告，不重做全批文学判断。保存后处理宿主预检反馈，完成后返回同一结果路径。` }], { signal: exec.signal })
          job.resultCorrection.messageId = messageId
          await P.save(root, project)
        } catch (error) {
          if (previous) job.resultCorrection = previous
          else delete job.resultCorrection
          await P.save(root, project)
          throw new Error(`无法回叫原复核代理，原报告已保留：${error.message}`)
        }
        return jsonValue({ result: publicResult(T.taskInfo(root, job)), waiting: true, correction: { attempts, sameAgent: job.agent }, instruction: '原复核代理只回修原结果，等完成通知后collect；不取消旧单或新派整批冷读' })
      }
      let advance = false
      if (args.action === 'collect') {
        const project = await P.load(root), job = project.jobs.find(item => item.id === flags.id)
        if (!job || job.runtime !== DSH_RUNTIME && job.status !== 'completed') throw new Error('该单未通过当前DSH真实派单入口；保留旧产物，取消旧单后重新dispatch')
        advance = job.status === 'running' && continuing.get(parent.session)?.get(root) === project.scope.revision
        if (job.role === '复核' && job.status === 'running') {
          await T.assertReadReceipt(root, job)
          await T.assertTaskBasis(root, project, job)
          try { await T.inspectResult(root, project, job.id) } catch (error) {
            if (job.resultCorrection?.pending) { job.resultCorrection.pending = false; await P.save(root, project) }
            if (!exec.signal?.aborted && (!job.parentSession || job.parentSession === parent.session.header.id)) {
              try {
                const corrected = await definition.execute({ action: 'correct-result', project: root, options: { id: job.id } }, exec)
                return jsonValue({ ...corrected, collected: false, error: error.message,
                  instruction: corrected.waiting ? '原报告未作废，已回叫原复核代理只修同一结果。等其完成通知后collect，不标failed、不另派整批冷读。' : corrected.instruction })
              } catch (correctionError) {
                return jsonValue({ result: publicResult(T.taskInfo(root, job)), collected: false, error: error.message, correctionError: correctionError.message,
                  recovery: { call: { action: 'correct-result', project: root, options: { id: job.id } } }, instruction: '原结果已保留，先处理原代理回修的具体阻塞，不手工重建issues或伪造通过。' })
              }
            }
            return jsonValue({ result: publicResult(T.taskInfo(root, job)), collected: false, error: error.message,
              recovery: { call: { action: 'correct-result', project: root, options: { id: job.id } } },
              instruction: '正文与报告尚未正式收件。仅结果字段/连续引文错误，按recovery.call回叫原代理修同一文件；保留本单、原阅读和实质判断，不标failed、不手工重建issues、不重派整批冷读。' })
          }
        }
      }
      const result = await run(argv, args.data)
      if (args.action === 'doctor' && flags.inspect === true) { inspecting.add(parent.session); continuing.delete(parent.session) }
      if (args.action === 'scope') {
        let roots = continuing.get(parent.session)
        if (!roots) continuing.set(parent.session, roots = new Map())
        if (automatic !== false && ['continue', 'revise', 'review'].includes(result.mode)) roots.set(root, result.revision)
        else roots.delete(root)
      }
      if ((readOnly.has(args.action) || preview) && !(args.action === 'task' && flags.status)) return jsonValue({ result: Array.isArray(result) ? result.map(publicResult) : publicResult(result),
        ...(args.action === 'doctor' ? { runtime } : {}) })
      const diagnosis = await W.diagnose(root, await P.load(root)), next = diagnosis.nextAction
      if (advance && !exec.signal?.aborted && continuing.get(parent.session)?.get(root) === diagnosis.scope?.revision && !next.requiresUser && next.call?.action === 'dispatch') {
        try {
          const started = await definition.execute({ ...next.call, project: root }, exec)
          return jsonValue({ result: publicResult(result), diagnosis, continuation: started.result, waiting: started.waiting,
            instruction: '前单已收件，下一岗位已按本会话当前授权自动启动；等continuation的完成通知后collect，不重复派单、不结束为目标完成。' })
        } catch (error) {
          return jsonValue({ result: publicResult(result), diagnosis: await W.diagnose(root, await P.load(root)), continuationError: error.message,
            instruction: '前单已成功收件；下一岗位启动失败，按具体错误恢复，不重复提交前单或冒充完成。' })
        }
      }
      return jsonValue({ result: publicResult(result), diagnosis })
    },
  }
  ctx.tools.register(definition)
  return (session, event) => {
    const aborted = event?.type === 'turn/end' && event.data?.reason?.kind === 'aborted'
    const paused = event?.type === 'goal/change' && event.data?.goal?.phase === 'paused'
    if (!aborted && !paused) return
    const agent = ctx.agents.get(session?.id ?? session?.header?.id)
    if (agent?.session) continuing.delete(agent.session)
    const owner = ctx.agents.get(agent?.session?.header?.parentSession ?? session?.header?.parentSession)
    if (owner?.session) continuing.delete(owner.session)
  }
}
