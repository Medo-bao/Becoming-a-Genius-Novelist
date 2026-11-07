import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { safePath } from './paths.mjs'

// 文笔逐章提交与队长范围变更共用此入口；跨进程也在章边界串行落账。
export async function withProjectTransaction(root, operation) {
  const directory = await safePath(root, '.novel-workshop')
  await mkdir(directory, { recursive: true })
  const path = await safePath(root, '.novel-workshop/commit.lock')
  const deadline = Date.now() + 15000
  let handle
  while (!handle) {
    try { handle = await open(path, 'wx') } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = Number(await readFile(path, 'utf8')) } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError }
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0) } catch (probe) {
          if (probe.code === 'ESRCH') { await unlink(await safePath(root, path)).catch(error => { if (error.code !== 'ENOENT') throw error }); continue }
          if (probe.code !== 'EPERM') throw probe
        }
      }
      if (Date.now() >= deadline) throw new Error('当前项目仍在提交上一项制作操作，待章边界完成后重试')
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  try { await handle.writeFile(String(process.pid), 'utf8'); return await operation() }
  finally { await handle.close(); await unlink(await safePath(root, path)) }
}
