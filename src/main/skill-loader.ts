import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { getSkillsDir } from './paths'
import { AILA_SKILL_FILE, type LoadedSkill, parseSkillDocument } from './skills'

const SKILL_BUNDLED_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])

export interface SkillLoadError {
  directory: string
  message: string
}

export interface SkillLoadResult {
  skills: LoadedSkill[]
  errors: SkillLoadError[]
}

async function listSkillBundledFiles(directory: string): Promise<string[]> {
  const files: string[] = []

  const walk = async (current: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.')) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKILL_BUNDLED_IGNORED_DIRECTORIES.has(entry.name)) continue
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      if (current === directory && entry.name === AILA_SKILL_FILE) continue
      files.push(path)
    }
  }

  await walk(directory)
  return files
}

export async function loadSkillFromDir(directory: string): Promise<LoadedSkill> {
  const resolved = resolve(directory)
  const skillPath = join(resolved, AILA_SKILL_FILE)
  const raw = await readFile(skillPath, 'utf-8')
  const { definition, body } = parseSkillDocument(raw)
  const directoryName = basename(resolved)
  if (definition.name !== directoryName) {
    throw new Error(
      `skill name "${definition.name}" must match its directory name "${directoryName}"`,
    )
  }
  return {
    directory: resolved,
    skillPath,
    definition,
    body,
    bundledFiles: await listSkillBundledFiles(resolved),
  }
}

export async function loadSkillsFromDir(dir = getSkillsDir()): Promise<SkillLoadResult> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return { skills: [], errors: [] }
  }

  const skills: LoadedSkill[] = []
  const errors: SkillLoadError[] = []
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue
    const directory = join(dir, entry)
    try {
      const info = await stat(directory)
      if (!info.isDirectory()) continue
      skills.push(await loadSkillFromDir(directory))
    } catch (error) {
      errors.push({
        directory,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { skills, errors }
}
