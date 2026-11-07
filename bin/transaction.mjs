import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { safePath } from './paths.mjs'

const markerPattern = /^owner-([1-9]\d*)-[a-f0-9-]{36}$/u
const renameConflicts = new Set(['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'])

function validPid(pid) { return Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff }

function ownerIsAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

async function lockInfo(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

async function removeEmpty(path) {
  try { await rmdir(path) } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  }
}

async function recoverHolder(root, path) {
  let entries
  try { entries = await readdir(await safePath(root, path), { withFileTypes: true }) } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return
    throw error
  }
  if (entries.length) {
    const [marker] = entries
    const pid = marker.isDirectory() ? Number(markerPattern.exec(marker.name)?.[1]) : NaN
    if (entries.length !== 1 || !validPid(pid)) throw new Error(`无法识别提交锁的所有者标记：${path}`)
    if (ownerIsAlive(pid)) return
    await removeEmpty(join(path, marker.name))
  }
  // 活锁总含有自己的标记。两个进程回收同一残锁时也只能删除空目录。
  await removeEmpty(path)
}

async function recoverLegacyFile(path, current) {
  let contents
  try { contents = await readFile(path, 'utf8') } catch (error) {
    if (['ENOENT', 'EISDIR'].includes(error.code)) return 'retry'
    throw error
  }
  const owner = Number(contents)
  // 旧版本可能仍在写入 PID。无法确定空文件的持有者时，留给操作者核实。
  if (!validPid(owner)) return 'legacy-unknown'
  if (ownerIsAlive(owner)) return 'retry'
  const latest = await lockInfo(path)
  if (!latest?.isFile() || latest.ino !== current.ino || latest.dev !== current.dev) return 'retry'
  try { await unlink(path) } catch (error) {
    if (!['ENOENT', 'EISDIR'].includes(error.code)) {
      const replacement = await lockInfo(path)
      if (replacement && !replacement.isDirectory()) throw error
    }
  }
  return 'retry'
}

async function prepareLockDirectory(root, path) {
  // mkdir 与旧版创建锁文件互斥，后续重命名只发生在目录内部。
  try { await mkdir(path); return 'ready' } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const current = await lockInfo(await safePath(root, path))
  if (!current) return 'retry'
  if (current.isDirectory()) return 'ready'
  if (!current.isFile()) throw new Error(`无法识别提交锁：${path}`)
  return await recoverLegacyFile(path, current)
}

// 文笔逐章提交与队长范围变更共用此入口；跨进程也在章边界串行落账。
export async function withProjectTransaction(root, operation) {
  const directory = await safePath(root, '.novel-workshop')
  await mkdir(directory, { recursive: true })
  const path = await safePath(root, join(directory, 'commit.lock'))
  const holder = join(path, 'holder')
  const marker = `owner-${process.pid}-${randomUUID()}`
  const prepared = join(directory, `${marker}.pending`)
  const deadline = Date.now() + 15000
  await mkdir(prepared)
  let owned = prepared
  try {
    // 所有者标记随目录一起发布，进程在发布前退出不会留下共享空锁。
    await mkdir(join(prepared, marker))
    for (;;) {
      const status = await prepareLockDirectory(root, path)
      if (status === 'ready') {
        try { await rename(prepared, holder); owned = holder } catch (error) {
          if (!renameConflicts.has(error.code)) throw error
          await recoverHolder(root, holder)
        }
        if (owned === holder) return await operation()
      }
      if (Date.now() >= deadline) {
        if (status === 'legacy-unknown') throw new Error(`旧版提交锁缺少有效 PID。确认旧版进程已停止后，移走 ${path} 再重试`)
        throw new Error('当前项目仍在提交上一项制作操作，待章边界完成后重试')
      }
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  } finally {
    await removeEmpty(join(owned, marker))
    await removeEmpty(owned)
    if (owned === holder) await removeEmpty(path)
  }
}
