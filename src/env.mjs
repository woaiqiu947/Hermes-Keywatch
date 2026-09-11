/**
 * env.mjs — Hermes 环境探测基础设施
 *
 * 关键设计:零依赖。配置一律通过 `hermes config get <key> --json` 拿,
 * 复用 Hermes 自己的 YAML 解析,不引入 yaml 包,也不手写脆弱的正则解析。
 *
 * 跨平台:Hermes CLI 在 Windows/macOS/Linux 上都叫 `hermes`,路径差异
 * 交给 CLI 自己处理(用 `hermes config env-path` 问它 .env 在哪)。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 找到 hermes 可执行文件。PATH 里没有时回退到常见安装位置。 */
export function resolveHermesBin() {
  if (process.env.HERMES_BIN && existsSync(process.env.HERMES_BIN)) return process.env.HERMES_BIN

  const candidates = []
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    candidates.push(
      join(local, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
      join(local, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes'),
      'hermes.exe'
    )
  } else {
    candidates.push(
      join(homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'bin', 'hermes'),
      join(homedir(), '.local', 'bin', 'hermes'),
      '/usr/local/bin/hermes',
      'hermes'
    )
  }
  for (const c of candidates) {
    if (c === 'hermes' || c === 'hermes.exe' || existsSync(c)) return c
  }
  return 'hermes'
}

const HERMES_BIN = resolveHermesBin()

/** 调 `hermes config get <key> --json`,返回解析后的对象。失败返回 fallback。 */
export async function getConfig(key, fallback = null) {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, ['config', 'get', key, '--json'], {
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    const text = String(stdout).trim()
    if (!text) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 问 Hermes 私有 env 文件的绝对路径。 */
export async function getEnvPath() {
  if (process.env.HERMES_ENV_PATH && existsSync(process.env.HERMES_ENV_PATH)) {
    return process.env.HERMES_ENV_PATH
  }
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, ['config', 'env-path'], {
      timeout: 20000,
      windowsHide: true
    })
    const p = String(stdout).trim().split(/\r?\n/).pop().trim()
    if (p && existsSync(p)) return p
  } catch {
    /* fall through to defaults */
  }
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const guesses = [
    join(local, 'hermes', '.env'),
    join(homedir(), '.hermes', '.env'),
    join(homedir(), '.config', 'hermes', '.env')
  ]
  return guesses.find((g) => existsSync(g)) || guesses[0]
}

/**
 * 极简 .env 解析器:支持 KEY=VALUE、KEY="quoted"、KEY='quoted'、
 * 行内 # 注释、export 前缀、CRLF。返回 { KEY: value }。
 */
export function parseEnvFile(text) {
  const out = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1)
    } else {
      const hash = val.indexOf(' #')
      if (hash !== -1) val = val.slice(0, hash).trim()
    }
    out[key] = val
  }
  return out
}

/** 读 .env 文件(不存在则返回空对象)。 */
export function readEnvFile(path) {
  try {
    if (!existsSync(path)) return {}
    return parseEnvFile(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 合并的凭据视图:.env 文件 + 进程环境变量(进程环境优先,这样常驻服务
 * 被 Task Scheduler/systemd 拉起时注入的变量能覆盖文件)。
 */
export function loadCredentials(envPath) {
  return { ...readEnvFile(envPath), ...process.env }
}

export const HERMES_BIN_PATH = HERMES_BIN
