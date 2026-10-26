import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { inside, safePath } from '../../bin/paths.mjs'
import { requiredInputs } from '../../bin/tasks.mjs'

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
  return (await requiredInputs(root, job)).map(item => item.path)
}

export async function assertMaterialsRead(exec, root, job, hostPath) {
  if (job.runtime !== DSH_RUNTIME) return
  const directory = await safePath(root, job.directory)
  const state = readings.get(exec.agent.session)
  let required = state?.jobs.get(job.id)
  if (!required) {
    required = await requiredFiles(root, job)
    state?.jobs.set(job.id, required)
  }
  if (['prompt.md', 'context.json'].some(name => key(resolve(directory, name)) === key(hostPath)) ||
    required.some(path => key(path) === key(hostPath)) || ['chapters', 'text'].some(name => inside(resolve(directory, name), hostPath))) throw new Error('任务提示与阅读材料只读，不能覆盖输入来绕过取证')
  if (!state) throw new Error('尚无成功的read回执；先真实读取promptPath、contextPath、岗位卡及完整阅读视图，不接受聊天内联代替')
  const missing = []
  for (const path of required) {
    const file = state.files.get(key(path))
    if (!file || file.seen.size !== file.total) {
      let offset = 1
      while (file?.seen.has(offset)) offset++
      missing.push(`${path}：用read从第${offset}行继续分页`)
    }
  }
  if (missing.length) throw new Error(`尚未完整读取以下${missing.length}份材料；一次列出全部缺项，读完后再提交：\n${missing.join('\n')}`)
  if (key(hostPath) !== key(resolve(directory, 'result.json')) || state.receipted.has(job.id)) return
  const path = await safePath(root, `.novel-workshop/read-receipts/${job.id}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ task: job.id, agent: job.agent, scopeRevision: job.scopeRevision, complete: true,
    files: required.map(path => ({ path, lines: state.files.get(key(path)).total })), time: new Date().toISOString() }) + '\n', 'utf8')
  state.receipted.add(job.id)
}
