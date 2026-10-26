#!/usr/bin/env node
/**
 * 把《我要成为天才小说作家》铺到非 DSH 的宿主项目里。
 *
 *   node bin/install.mjs --target codex --dir <项目目录>
 *   node bin/install.mjs --target zcode --dir <项目目录>
 *   node bin/install.mjs --target dsh
 *
 * 做的事：
 *   1. 复制 core/ 与全部运行模块到 <项目>/.novel-workshop/
 *   2. 把 adapters/<宿主>/AGENTS.md 追加到 <项目>/AGENTS.md（带标记，可重复执行）
 *   3. target=codex 时安装项目级 .agents/skills/tiancai-novel/；ZCode 入口保留待后续适配。
 */

import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CORE = join(REPO, 'core')
const SKILL = join(REPO, 'skills', 'tiancai-novel')

const MARK_BEGIN = '<!-- tiancai-novel:begin -->'
const MARK_END = '<!-- tiancai-novel:end -->'

function parseArgv(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

function fail(message) {
  process.stderr.write(`install: ${message}\n`)
  process.exit(1)
}

async function prepareWorkshop(projectDir) {
  const workshop = join(projectDir, '.novel-workshop')
  await mkdir(join(workshop, 'bin'), { recursive: true })
  await mkdir(join(workshop, 'drafts'), { recursive: true })
  await mkdir(join(workshop, 'tasks'), { recursive: true })
  await cp(CORE, join(workshop, 'core'), { recursive: true, force: true })
  for (const name of (await readdir(join(REPO, 'bin'))).filter(name => name.endsWith('.mjs') && name !== 'install.mjs')) {
    await copyFile(join(REPO, 'bin', name), join(workshop, 'bin', name))
  }
  return workshop
}

async function writeAgentsFile(projectDir, target) {
  const source = join(REPO, 'adapters', target, 'AGENTS.md')
  if (!existsSync(source)) fail(`缺少适配文件：${source}`)
  const block = await readFile(source, 'utf8')
  const override = join(projectDir, 'AGENTS.override.md')
  const file = target === 'codex' && existsSync(override) && (await readFile(override, 'utf8')).trim()
    ? override : join(projectDir, 'AGENTS.md')
  const current = existsSync(file) ? await readFile(file, 'utf8') : ''
  const wrapped = `${MARK_BEGIN}\n${block.trim()}\n${MARK_END}\n`

  if (current.includes(MARK_BEGIN)) {
    if (!current.includes(MARK_END)) fail(`${file} 的小说工坊标记块缺少结束标记，请先补齐`)
    const pattern = new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`)
    await writeFile(file, current.replace(pattern, () => wrapped), 'utf8')
    return file
  }
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  await writeFile(file, `${current}${separator}${wrapped}`, 'utf8')
  return file
}

async function installSkill() {
  const zcodeHome = process.env.ZCODE_HOME?.trim() || join(homedir(), '.zcode')
  const dest = join(zcodeHome, 'skills', 'tiancai-novel')
  await mkdir(dest, { recursive: true })
  await cp(SKILL, dest, { recursive: true, force: true })
  return dest
}

async function installCodexSkill(projectDir) {
  const dest = join(projectDir, '.agents', 'skills', 'tiancai-novel')
  await mkdir(dest, { recursive: true })
  await cp(join(REPO, 'adapters', 'codex', 'skills', 'tiancai-novel'), dest, { recursive: true, force: true })
  const entry = join(dest, 'SKILL.md')
  await writeFile(entry, (await readFile(entry, 'utf8')).replaceAll('](../../../../core/', '](../../../.novel-workshop/core/'), 'utf8')
  return dest
}

async function main() {
  const flags = parseArgv(process.argv.slice(2))
  const target = typeof flags.target === 'string' ? flags.target : undefined

  if (target === undefined) {
    fail('用法：node bin/install.mjs --target dsh|codex|zcode [--dir 项目目录] [--no-skill]')
  }

  if (target === 'dsh') {
    process.stdout.write(
      [
        'DSH 不需要这个脚本：插件是预设包。',
        '',
        '在 DSH 会话里执行：',
        '  plugin_manager action=install_bundle target="<本仓库绝对路径>"',
        '',
        '然后新建会话，在预设里选「我要成为天才小说作家」。',
        '钩子会自动把 core/ 同步到 ~/.dsh/novel-workshop/。',
      ].join('\n') + '\n',
    )
    return
  }

  if (target !== 'codex' && target !== 'zcode') fail(`不支持的宿主：${target}（只支持 dsh / codex / zcode）`)

  const projectDir = resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd())
  await mkdir(projectDir, { recursive: true })

  const agentsFile = await writeAgentsFile(projectDir, target)
  const workshop = await prepareWorkshop(projectDir)
  const lines = [
    `宿主：${target}`,
    `项目：${projectDir}`,
    `规则文件：${agentsFile}`,
    `核心资产：${workshop}`,
  ]

  if (target === 'zcode' && flags['no-skill'] !== true) {
    const skillDir = await installSkill()
    lines.push(`技能：${skillDir}`)
  }

  if (target === 'codex' && flags['no-skill'] !== true) {
    lines.push(`项目技能：${await installCodexSkill(projectDir)}`)
  }

  lines.push('', target === 'codex'
    ? '安装完成，尚未启动小说流程。仅在明确使用 $tiancai-novel 或点选本插件时运行；普通写小说请求不主动调用。若新技能尚未显示，在该项目新开聊天。'
    : '下一步：给智能体发一句「按 AGENTS.md 检查项目」；ZCode 专门适配仍待后续。')
  process.stdout.write(lines.join('\n') + '\n')
}

await main()
