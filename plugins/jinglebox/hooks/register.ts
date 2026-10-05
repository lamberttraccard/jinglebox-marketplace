import type { Engine, Register } from 'claude-code'

type Jingle = 'turn-done' | 'needs-answer' | 'long-turn' | 'tests-passed' | 'tests-failed' | 'pr-created'

type CachedAudio = { data: string; mime: string; title: string }

// A fixed sound, a pick among chosen sounds, or a random sound of the workspace (or of one tag).
type Choice = number | readonly number[] | { random: true; tag?: string }

type PoolSound = { id: number; duration_ms: number }

type Pool = { fetchedAt: number; ids: readonly number[] }

type Workspace = { slug: string; name: string }

type Settings = { workspace: string; server: string; randomMaxMs: number }

type Blocks = ReadonlyArray<Record<string, unknown>>

type SoundMetadata = { title?: string; play_url?: string }

const DESCRIPTIONS: Record<Jingle, string> = {
  'turn-done': 'Answer waiting',
  'needs-answer': 'Question waiting',
  'long-turn': 'Long turn done',
  'tests-passed': 'Tests passed',
  'tests-failed': 'Tests failed',
  'pr-created': 'Merge request created',
}

const JINGLES = Object.keys(DESCRIPTIONS) as Jingle[]
const DEFAULT_CHOICE: Choice = { random: true }

const TEST_COMMAND = /\b(artisan\s+test|pest|phpunit|pytest|jest|vitest|go\s+test|cargo\s+test|(npm|pnpm|yarn|bun)\s+(run\s+)?test)\b/
const PR_CREATE_COMMAND = /\b(glab\s+mr\s+create|gh\s+pr\s+create)\b/
const QUESTION_TOOLS = ['AskUserQuestion', 'ExitPlanMode']
const NEEDS_ANSWER_DEBOUNCE_MS = 3000
const QUESTION_TAIL_CHARS = 400
const POOL_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_LIMIT = 40
const SAVED_BLOB = /\(([^,()]+),[^)]*\) saved to (\S+?\.bin)/

const READ_TOOLS = ['get-sound', 'search-sounds', 'get-workspace', 'list-workspaces']

let settings: Settings = { workspace: '', server: 'jinglebox', randomMaxMs: 4000 }
let lastNeedsAnswerAt = 0
const lastPlayed: Partial<Record<Jingle, number>> = {}
const upcoming: Partial<Record<Jingle, number>> = {}

const permissionHint = (): string =>
  `Add ${READ_TOOLS.map(tool => `"mcp__${settings.server}__${tool}"`).join(', ')} to permissions.allow in ~/.claude/settings.json`

const explain = (error: unknown): string =>
  /classifier|refused|denied/i.test(String(error)) ? `call refused. ${permissionHint()}` : String(error)

// The last paragraph of an answer asking something of the person.
const endsWithQuestion = (answer: string): boolean => {
  const paragraphs = answer.trim().split(/\n\s*\n/)
  const last = paragraphs[paragraphs.length - 1] ?? ''

  return last.slice(-QUESTION_TAIL_CHARS).includes('?')
}

// 329, #329, or a Jinglebox URL ending in /sounds/329.
const parseSoundId = (value: string): number | undefined => {
  const match = /^#?(\d+)$/.exec(value) ?? /\/sounds\/(\d+)\/?(?:[?#].*)?$/.exec(value)

  return match === null ? undefined : Number(match[1])
}

const isJingle = (value: string): value is Jingle => value in DESCRIPTIONS

function jsonFrom(blocks: Blocks): Record<string, unknown> | undefined {
  for (const block of blocks) {
    if (block.type !== 'text') {
      continue
    }
    const text = String(block.text)
    try {
      return JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>
    } catch {
      continue
    }
  }

  return undefined
}

async function callJinglebox($: Engine, tool: string, args: Record<string, unknown>): Promise<Blocks> {
  const result = await $.mcp.call(settings.server, tool, args)
  if (result.isError) {
    throw new Error(`Jinglebox ${tool} failed`)
  }

  return result.content as Blocks
}

async function listWorkspaces($: Engine): Promise<readonly Workspace[]> {
  const json = jsonFrom(await callJinglebox($, 'list-workspaces', {}))

  return (json?.workspaces ?? []) as readonly Workspace[]
}

// The configured workspace, the one picked with /jinglebox workspace, or the only one there is.
async function workspaceOf($: Engine): Promise<string> {
  if (settings.workspace !== '') {
    return settings.workspace
  }
  const picked = (await $.store.get('workspace')) as string | undefined
  if (picked !== undefined) {
    return picked
  }
  const workspaces = await listWorkspaces($)
  const [only] = workspaces
  if (workspaces.length !== 1 || only === undefined) {
    throw new Error('pick a workspace with /jinglebox workspace <slug>')
  }
  await $.store.set('workspace', only.slug)

  return only.slug
}

const cacheKey = (workspace: string, soundId: number): string => `audio:${workspace}:${soundId}`

async function choiceFor($: Engine, jingle: Jingle): Promise<Choice> {
  const workspace = await workspaceOf($)
  const choices = ((await $.store.get(`sounds:${workspace}`)) ?? {}) as Partial<Record<Jingle, Choice>>

  return choices[jingle] ?? DEFAULT_CHOICE
}

async function searchSounds($: Engine, workspace: string, tags: readonly string[], query?: string): Promise<readonly (PoolSound & { title: string })[]> {
  const json = jsonFrom(
    await callJinglebox($, 'search-sounds', { workspace_slug: workspace, status: 'ready', tags, query: query ?? null, limit: 50 }),
  )

  return (json?.sounds ?? []) as readonly (PoolSound & { title: string })[]
}

async function workspaceTags($: Engine, workspace: string): Promise<readonly string[]> {
  const json = jsonFrom(await callJinglebox($, 'get-workspace', { workspace_slug: workspace }))

  return (json?.tags ?? []) as readonly string[]
}

// The short sounds of the workspace or of one tag, refreshed once a day.
async function poolFor($: Engine, workspace: string, tag?: string): Promise<readonly number[]> {
  const key = `pool:${workspace}:${tag ?? '*'}:${settings.randomMaxMs}`
  const now = await $.clock.now()
  const stored = (await $.store.get(key)) as Pool | undefined
  if (stored !== undefined && now - stored.fetchedAt < POOL_TTL_MS && stored.ids.length > 0) {
    return stored.ids
  }
  // A search answers 50 sounds at most: the union over every tag reaches the rest.
  const groups = tag === undefined
    ? [await searchSounds($, workspace, []), ...(await Promise.all((await workspaceTags($, workspace)).map(one => searchSounds($, workspace, [one]))))]
    : [await searchSounds($, workspace, [tag])]
  const ids = [...new Set(groups.flat().filter(sound => sound.duration_ms <= settings.randomMaxMs).map(sound => sound.id))]
  await $.store.set(key, { fetchedAt: now, ids })

  return ids
}

async function candidatesFor($: Engine, workspace: string, choice: Choice): Promise<readonly number[]> {
  if (typeof choice === 'number') {
    return [choice]
  }
  if (Array.isArray(choice)) {
    return choice
  }

  return poolFor($, workspace, (choice as { tag?: string }).tag)
}

async function pickSound($: Engine, jingle: Jingle): Promise<number> {
  const workspace = await workspaceOf($)
  const candidates = await candidatesFor($, workspace, await choiceFor($, jingle))
  const fresh = candidates.filter(id => id !== lastPlayed[jingle])
  const among = fresh.length > 0 ? fresh : candidates
  const picked = among[Math.floor(Math.random() * among.length)]
  if (picked === undefined) {
    throw new Error('no sound to pick from')
  }

  return picked
}

async function audioFrom($: Engine, blocks: Blocks, metadata: SoundMetadata): Promise<{ data: string; mime: string }> {
  const inline = blocks.find(block => block.type === 'audio')
  if (inline !== undefined) {
    return { data: String(inline.data), mime: String(inline.mimeType ?? 'audio/mp4') }
  }
  // Claude Code saves a binary MCP block to a file and hands over its path.
  const saved = blocks
    .filter(block => block.type === 'text')
    .map(block => SAVED_BLOB.exec(String(block.text)))
    .find(match => match !== null)
  if (saved !== undefined && saved !== null) {
    const { base64 } = await $.fs.read(saved[2], { as: 'bytes' })

    return { data: base64, mime: saved[1].trim() }
  }
  if (metadata.play_url !== undefined) {
    return { data: '', mime: metadata.play_url }
  }
  throw new Error('no audio in the Jinglebox answer')
}

async function remember($: Engine, workspace: string, soundId: number): Promise<void> {
  const order = ((await $.store.get('cache-order')) ?? []) as readonly string[]
  const key = cacheKey(workspace, soundId)
  const kept = [...order.filter(one => one !== key), key]
  const evicted = kept.slice(0, Math.max(0, kept.length - CACHE_LIMIT))
  await Promise.all(evicted.map(one => $.store.delete(one)))
  await $.store.set('cache-order', kept.slice(evicted.length))
}

async function download($: Engine, soundId: number): Promise<CachedAudio> {
  const workspace = await workspaceOf($)
  const cached = (await $.store.get(cacheKey(workspace, soundId))) as CachedAudio | undefined
  if (cached !== undefined) {
    return cached
  }
  const blocks = await callJinglebox($, 'get-sound', { workspace_slug: workspace, sound_id: soundId, include_audio: true })
  const metadata = (jsonFrom(blocks)?.sound ?? {}) as SoundMetadata
  const audio = await audioFrom($, blocks, metadata)
  const title = metadata.title ?? `#${soundId}`
  if (audio.data === '') {
    // Only a signed, expiring URL: play it without caching.
    return { data: '', mime: audio.mime, title }
  }
  const fetched: CachedAudio = { data: audio.data, mime: audio.mime, title }
  await $.store.set(cacheKey(workspace, soundId), fetched)
  await remember($, workspace, soundId)

  return fetched
}

async function playAudio($: Engine, audio: CachedAudio): Promise<void> {
  if (audio.data === '') {
    await $.audio.play({ url: audio.mime })

    return
  }
  await $.audio.play({ base64: audio.data, mime: audio.mime })
}

// Picks and downloads the next sound ahead, so the next play starts at once.
async function prepare($: Engine, jingle: Jingle): Promise<void> {
  const soundId = await pickSound($, jingle)
  await download($, soundId)
  upcoming[jingle] = soundId
}

async function play($: Engine, jingle: Jingle): Promise<void> {
  if ((await $.store.get('muted')) === true) {
    return
  }
  let audio: CachedAudio
  let soundId: number
  try {
    soundId = upcoming[jingle] ?? (await pickSound($, jingle))
    delete upcoming[jingle]
    lastPlayed[jingle] = soundId
    audio = await download($, soundId)
  } catch (error) {
    $.ui.toast(`🎵 ${DESCRIPTIONS[jingle]}: no sound (${explain(error)})`)

    return
  }
  $.ui.toast(`🎵 ${DESCRIPTIONS[jingle]}: « ${audio.title} » (#${soundId})`)
  void prepare($, jingle).catch(() => undefined)
  await playAudio($, audio).catch(error => {
    $.ui.toast(`🎵 cannot play: ${String(error)}`)
  })
}

async function needsAnswer($: Engine): Promise<void> {
  const now = await $.clock.now()
  if (now - lastNeedsAnswerAt < NEEDS_ANSWER_DEBOUNCE_MS) {
    return
  }
  lastNeedsAnswerAt = now
  await play($, 'needs-answer')
}

async function prefetch($: Engine): Promise<void> {
  for (const jingle of JINGLES) {
    await prepare($, jingle).catch(() => undefined)
  }
}

async function diagnose($: Engine): Promise<string> {
  const lines: string[] = [`server=${settings.server}`]
  try {
    const workspace = await workspaceOf($)
    lines.push(`workspace=${workspace}`)
    const soundId = await pickSound($, 'turn-done')
    await $.store.delete(cacheKey(workspace, soundId))
    const audio = await download($, soundId)
    lines.push(`download ok: #${soundId} « ${audio.title} » ${audio.data === '' ? 'url only' : `${audio.mime}, ${audio.data.length} base64 chars`}`)
    await playAudio($, audio)
    lines.push('audio.play ok')
  } catch (error) {
    lines.push(`failed: ${explain(error)}`)
  }
  lines.push(`stored keys: ${(await $.store.keys()).length}`)

  return lines.join('\n')
}

async function describeSound($: Engine, workspace: string, soundId: number): Promise<string> {
  const cached = (await $.store.get(cacheKey(workspace, soundId))) as CachedAudio | undefined

  return `#${soundId}${cached === undefined ? '' : ` « ${cached.title} »`}`
}

async function describeChoice($: Engine, workspace: string, choice: Choice): Promise<string> {
  if (typeof choice === 'number') {
    return describeSound($, workspace, choice)
  }
  if (Array.isArray(choice)) {
    return `random among ${(await Promise.all(choice.map(id => describeSound($, workspace, id)))).join(', ')}`
  }
  const { tag } = choice as { tag?: string }

  return `random from ${tag === undefined ? 'the whole workspace' : `tag ${tag}`} (sounds ≤ ${settings.randomMaxMs / 1000} s)`
}

// default | random [tag] | 329 | #329 | URL | 21,349,336 | 21 349 336
function parseChoice(values: readonly string[]): Choice | 'default' | undefined {
  const [first = ''] = values
  if (first === 'default') {
    return 'default'
  }
  if (first === 'random') {
    return values[1] === undefined ? { random: true } : { random: true, tag: values[1] }
  }
  const ids = values.flatMap(value => value.split(',')).filter(token => token !== '').map(parseSoundId)
  if (ids.length === 0 || ids.some(id => id === undefined)) {
    return undefined
  }
  const unique = [...new Set(ids as number[])]

  return unique.length === 1 ? (unique[0] as number) : unique
}

async function describeMapping($: Engine, workspace: string): Promise<string> {
  const rows = await Promise.all(
    JINGLES.map(async jingle => `- ${jingle} (${DESCRIPTIONS[jingle]}): ${await describeChoice($, workspace, await choiceFor($, jingle))}`),
  )

  return rows.join('\n')
}

async function search($: Engine, query: string): Promise<string> {
  const sounds = await searchSounds($, await workspaceOf($), [], query)

  return sounds.map(sound => `- #${sound.id} « ${sound.title} » (${(sound.duration_ms / 1000).toFixed(1)} s)`).join('\n') || 'No sound found.'
}

async function chooseWorkspace($: Engine, slug: string): Promise<string> {
  const workspaces = await listWorkspaces($)
  const listing = workspaces.map(workspace => `- ${workspace.slug} (${workspace.name})`).join('\n')
  if (slug === '') {
    return `Workspaces:\n${listing}\n\nPick one with /jinglebox workspace <slug>.`
  }
  if (!workspaces.some(workspace => workspace.slug === slug)) {
    return `Unknown workspace "${slug}". Workspaces:\n${listing}`
  }
  await $.store.set('workspace', slug)
  for (const jingle of JINGLES) {
    delete upcoming[jingle]
  }
  void prefetch($)

  return `Workspace set to ${slug}.`
}

const USAGE = [
  'Usage:',
  '/jinglebox — current sounds',
  '/jinglebox workspace [slug] — list or pick the workspace',
  '/jinglebox set <event> <329 | #329 | sound URL> — a fixed sound',
  '/jinglebox set <event> 21,349,336 — random among these',
  '/jinglebox set <event> random [tag] — random short sound of the workspace or of a tag',
  '/jinglebox set <event> default — back to the default (random)',
  '/jinglebox search <words>',
  '/jinglebox test <event>',
  '/jinglebox mute | unmute',
  '/jinglebox debug',
  `Events: ${JINGLES.join(', ')}`,
].join('\n')

export const register: Register = (on, options) => {
  const longTurnMs = Number(options.long_turn_seconds ?? 60) * 1000
  settings = {
    workspace: String(options.workspace ?? ''),
    server: String(options.mcp_server ?? 'jinglebox'),
    randomMaxMs: Number(options.random_max_seconds ?? 4) * 1000,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jinglebox',
      description: 'Jinglebox sounds: workspace, set, search, test, mute, unmute, debug',
    })
    void prefetch($)

    return next(e)
  })

  on('command.run', { command: 'jinglebox' }, async ($, e) => {
    const [action = '', ...rest] = e.args.trim().split(/\s+/)
    const [target = ''] = rest

    try {
      if (action === 'mute' || action === 'unmute') {
        await $.store.set('muted', action === 'mute')

        return { text: action === 'mute' ? 'Jinglebox muted.' : 'Jinglebox unmuted.' }
      }
      if (action === 'debug') {
        return { text: await diagnose($) }
      }
      if (action === 'workspace') {
        return { text: await chooseWorkspace($, target) }
      }
      if (action === 'test' && isJingle(target)) {
        void play($, target)

        return { text: `Playing ${target}.` }
      }
      if (action === 'search' && rest.length > 0) {
        return { text: await search($, rest.join(' ')) }
      }
      if (action === 'set') {
        if (!isJingle(target)) {
          return { text: `Unknown event "${target}". Events: ${JINGLES.join(', ')}` }
        }
        const choice = parseChoice(rest.slice(1))
        if (choice === undefined) {
          return { text: `Cannot read "${rest.slice(1).join(' ')}": give 329, #329, a sound URL, 21,349,336, random [tag], or default.` }
        }
        const workspace = await workspaceOf($)
        const choices = ((await $.store.get(`sounds:${workspace}`)) ?? {}) as Partial<Record<Jingle, Choice>>
        const { [target]: _previous, ...others } = choices
        const updated = choice === 'default' ? others : { ...others, [target]: choice }
        await $.store.set(`sounds:${workspace}`, updated)
        delete upcoming[target]
        void play($, target)

        return { text: `${target} → ${await describeChoice($, workspace, updated[target] ?? DEFAULT_CHOICE)}` }
      }
      const workspace = await workspaceOf($)
      const muted = (await $.store.get('muted')) === true

      return { text: `Jinglebox is ${muted ? 'muted' : 'on'} (workspace ${workspace}).\n${await describeMapping($, workspace)}\n\n${USAGE}` }
    } catch (error) {
      return { text: `Jinglebox: ${explain(error)}\n\n${USAGE}` }
    }
  })

  // A permission prompt waits for the person.
  on('classic.PermissionRequest', ($, e, next) => {
    void needsAnswer($)

    return next(e)
  })

  // A question or a plan waits for the person.
  on('tool.call', ($, e, next) => {
    if (QUESTION_TOOLS.includes(e.tool)) {
      void needsAnswer($)
    }

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || e.agentId !== undefined) {
      return ran
    }
    if (TEST_COMMAND.test(e.command)) {
      void play($, ran.isError === true ? 'tests-failed' : 'tests-passed')
    }
    if (PR_CREATE_COMMAND.test(e.command) && ran.isError !== true) {
      void play($, 'pr-created')
    }

    return ran
  })

  // The end of a main-loop turn: a question when the answer ends on one, else done.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || e.isAborted) {
      return next(e)
    }
    if (endsWithQuestion(e.answer)) {
      void needsAnswer($)

      return next(e)
    }
    void play($, e.durationMs >= longTurnMs ? 'long-turn' : 'turn-done')

    return next(e)
  })
}
