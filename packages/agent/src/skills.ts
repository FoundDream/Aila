/**
 * Agent Skills loader and the `skill` tool.
 *
 * Implements the Agent Skills format: each skill is a directory containing a
 * SKILL.md file with YAML frontmatter (`name`, `description`, optional
 * `license`, `compatibility`, `metadata`, `allowed-tools`) followed by
 * markdown instructions for the model.
 *
 * Progressive disclosure happens in three levels:
 *   1. Skill names + descriptions are embedded in the `skill` tool
 *      description, so the model always knows what is available.
 *   2. Invoking the `skill` tool returns the SKILL.md body.
 *   3. Bundled files (scripts/, references/, assets/) are listed in the tool
 *      result; the model reads them on demand with the `read` tool.
 */

import matter from 'gray-matter'
import type { ToolRegistration } from './tools'

export const AILA_SKILL_FILE = 'SKILL.md'
export const SKILL_TOOL_NAME = 'skill'

const SKILL_NAME_MAX_CHARS = 64
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_DESCRIPTION_MAX_CHARS = 1024
const SKILL_COMPATIBILITY_MAX_CHARS = 500
const SKILL_BUNDLED_FILE_LIMIT = 100

export interface SkillDefinition {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string[]
}

export interface LoadedSkill {
  directory: string
  skillPath: string
  definition: SkillDefinition
  body: string
  bundledFiles?: readonly string[]
}

export interface ParsedSkillDocument {
  definition: SkillDefinition
  body: string
}

function frontmatterString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`skill frontmatter \`${label}\` must be a non-empty string`)
  }
  if (value.length > maxChars) {
    throw new Error(`skill frontmatter \`${label}\` must be at most ${maxChars} characters`)
  }
  return value
}

function parseSkillName(value: unknown): string {
  const name = frontmatterString(value, 'name', SKILL_NAME_MAX_CHARS)
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      'skill frontmatter `name` must use lowercase letters, numbers, and single hyphens (e.g. "pdf-processing")',
    )
  }
  return name
}

function parseSkillMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('skill frontmatter `metadata` must be a map of string keys to string values')
  }
  const metadata: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`skill frontmatter \`metadata.${key}\` must be a string`)
    }
    metadata[key] = entry
  }
  return metadata
}

function parseSkillAllowedTools(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : null
  if (entries === null) {
    throw new Error('skill frontmatter `allowed-tools` must be a string or a list of tool names')
  }
  const tools: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new Error('skill frontmatter `allowed-tools` entries must be strings')
    }
    const trimmed = entry.trim()
    if (trimmed) tools.push(trimmed)
  }
  return tools
}

export function parseSkillDocument(raw: string): ParsedSkillDocument {
  let parsed: { data: unknown; content: string }
  try {
    parsed = matter(raw)
  } catch (error) {
    throw new Error(
      `invalid SKILL.md frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const data = parsed.data
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
    throw new Error('SKILL.md must start with YAML frontmatter containing `name` and `description`')
  }
  const frontmatter = data as Record<string, unknown>

  const definition: SkillDefinition = {
    name: parseSkillName(frontmatter.name),
    description: frontmatterString(
      frontmatter.description,
      'description',
      SKILL_DESCRIPTION_MAX_CHARS,
    ),
  }
  if (frontmatter.license !== undefined) {
    definition.license = frontmatterString(frontmatter.license, 'license', Number.POSITIVE_INFINITY)
  }
  if (frontmatter.compatibility !== undefined) {
    definition.compatibility = frontmatterString(
      frontmatter.compatibility,
      'compatibility',
      SKILL_COMPATIBILITY_MAX_CHARS,
    )
  }
  if (frontmatter.metadata !== undefined) {
    definition.metadata = parseSkillMetadata(frontmatter.metadata)
  }
  if (frontmatter['allowed-tools'] !== undefined) {
    const allowedTools = parseSkillAllowedTools(frontmatter['allowed-tools'])
    if (allowedTools.length > 0) definition.allowedTools = allowedTools
  }

  const body = parsed.content.trim()
  if (!body) {
    throw new Error('SKILL.md must contain markdown instructions after the frontmatter')
  }

  return { definition, body }
}

function renderSkillInvocation(skill: LoadedSkill): string {
  const bundledFiles = skill.bundledFiles ?? []
  const lines = [
    `<skill name="${skill.definition.name}" directory="${skill.directory}">`,
    skill.body,
    '</skill>',
  ]

  if (bundledFiles.length > 0) {
    const shown = bundledFiles.slice(0, SKILL_BUNDLED_FILE_LIMIT)
    lines.push('', 'Bundled files (read on demand with the `read` tool):')
    for (const file of shown) lines.push(`- ${file}`)
    if (bundledFiles.length > shown.length) {
      lines.push(`- …and ${bundledFiles.length - shown.length} more files in ${skill.directory}`)
    }
  }

  if (skill.definition.allowedTools && skill.definition.allowedTools.length > 0) {
    lines.push(
      '',
      `This skill expects to use these tools: ${skill.definition.allowedTools.join(', ')}.`,
    )
  }
  if (skill.definition.compatibility) {
    lines.push('', `Compatibility notes: ${skill.definition.compatibility}`)
  }

  return lines.join('\n')
}

function buildSkillToolDescription(skills: readonly LoadedSkill[]): string {
  const lines = [
    'Load a skill: a packaged set of instructions for performing a specialized task.',
    'The result contains the full skill instructions plus a list of bundled files; follow the instructions and read bundled files with the `read` tool when they are referenced.',
    'Invoke the matching skill BEFORE attempting the task yourself whenever the user request matches a skill description below.',
    '',
    'Available skills:',
    ...skills.map((skill) => `- ${skill.definition.name}: ${skill.definition.description}`),
  ]
  return lines.join('\n')
}

export function createSkillTool(skills: readonly LoadedSkill[]): ToolRegistration | null {
  if (skills.length === 0) return null

  const skillsByName = new Map(skills.map((skill) => [skill.definition.name, skill]))

  return {
    spec: {
      type: 'function',
      function: {
        name: SKILL_TOOL_NAME,
        description: buildSkillToolDescription(skills),
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              enum: [...skillsByName.keys()],
              description: 'Name of the skill to load.',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      metadata: {
        name: SKILL_TOOL_NAME,
        readOnly: true,
        destructive: false,
        requiresApproval: false,
        access: ['read'],
        scope: ['workspace'],
      },
    },
    run: async (args) => {
      const name = args.name
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('`name` must be a non-empty string')
      }
      const skill = skillsByName.get(name)
      if (!skill) {
        throw new Error(
          `unknown skill: "${name}". Available skills: ${[...skillsByName.keys()].join(', ')}`,
        )
      }

      return renderSkillInvocation(skill)
    },
  }
}
