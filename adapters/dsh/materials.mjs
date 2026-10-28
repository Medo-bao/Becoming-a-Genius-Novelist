import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { inside, safePath } from '../../bin/paths.mjs'
import { requiredInputs, assertReadReceipt } from '../../bin/tasks.mjs'

export const DSH_RUNTIME = 'dsh-worker-v1'
const readings = new WeakMap()
const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

export function observeReading(exec, result) {
  const session = exec.agent?.session, value = result.value
  if (!session || result.isError || typeof value?.path !== 'string' || !Array.isArray(value.lines) || !Number.isSafeInteger(value.totalLines)) return
  let state = readings.get(session)
  if (!state) readings.set(session, state = { files: new Map(), jobs: new Map(), receipted: new Set() })
  const path = key(value.path)
  let file = state.files.get(path)
  if (!file || file.total !== value.totalLines) state.files.set(path, file = { total: value.totalLines, seen: new Set() })
  for (const line of value.lines) if (Number.isSafeInteger(line.number) && line.number > 0 && line.number <= file.total &&
    typeof line.text === 'string' && !line.text.includes('... (line truncated to ')) file.seen.add(line.number)
}

async function requiredFiles(root, job) {
  return await requiredInputs(root, job)
}

export async function assertMaterialsRead(exec, root, job, hostPath, { measure = false } = {}) {
  if (job.runtime !== DSH_RUNTIME) return
  const directory = await safePath(root, job.directory)
  const state = readings.get(exec.agent.session)
  const correcting = job.role === '复核' && job.resultCorrection?.pending === true
  if (correcting) await assertReadReceipt(root, job)
  const cacheId = correcting ? `${job.id}:correction:${job.resultCorrection.attempts}` : job.id
  let required = state?.jobs.get(cacheId)
  if (!required) {
    required = await requiredFiles(root, job)
    // 同一原复核代理只回修结果；保留其已验证的完整阅读回执，不把他人的阅读转给新代理。
    if (correcting) required = [...required.slice(0, 3), { path: resolve(directory, 'result.json'), lines: null }]
    state?.jobs.set(cacheId, required)
  }
  const input = ['prompt.md', 'context.json'].some(name => key(resolve(directory, name)) === key(hostPath)) ||
    required.some(item => key(item.path) === key(hostPath) && !(correcting && key(item.path) === key(resolve(directory, 'result.json')))) || ['chapters', 'text'].some(name => inside(resolve(directory, name), hostPath))
  if (input && !measure) throw new Error('任务提示与阅读材料只读，不能覆盖输入来绕过取证')
  if (!state) throw new Error('尚无成功的read回执；先真实读取promptPath、contextPath、岗位卡及完整阅读视图，不接受聊天内联代替')
  const missing = []
  for (const item of required) {
    const file = state.files.get(key(item.path))
    const expected = item.lines ?? file?.total
    if (!file || expected === undefined || file.seen.size < expected) {
      let offset = 1
      while (file?.seen.has(offset)) offset++
      missing.push(`${item.path}：用read从第${offset}行继续分页`)
    }
  }
  if (missing.length) throw new Error(`尚未完整读取以下${missing.length}份材料；一次列出全部缺项，读完后再提交：\n${missing.join('\n')}`)
  if (correcting || measure || key(hostPath) !== key(resolve(directory, 'result.json')) || state.receipted.has(job.id)) return
  const path = await safePath(root, `.novel-workshop/read-receipts/${job.id}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ task: job.id, agent: job.agent, scopeRevision: job.scopeRevision, complete: true,
    files: required.map(item => ({ path: item.path, lines: item.lines ?? state.files.get(key(item.path)).total })), time: new Date().toISOString() }) + '\n', 'utf8')
  state.receipted.add(job.id)
}
