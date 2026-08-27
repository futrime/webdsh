/**
 * The tools a session gets when the machine is a browser.
 *
 * The third machine, and the one whose tool set had to be invented rather than
 * adapted. `src/host/jsh-tool.ts` describes a shell honestly; `src/host/vm-tools.ts`
 * describes a screen and a keyboard honestly. Neither vocabulary fits here.
 * There is no filesystem to read, no command to run and no exit status to
 * report — the thing being driven is a *document*, and the questions worth
 * asking of a document are what is on it, what can be clicked, and what
 * happened when something was.
 *
 * ## Three ways to see the same page, offered on purpose
 *
 * A page is available in three modes, and they are not alternatives so much as
 * different resolutions of the same thing:
 *
 * - **The DOM** — `browser_snapshot`, and the `ref`s it hands out. This is the
 *   one to reach for first, nearly always. It is exact where a picture is
 *   approximate, it is a few dozen lines where the markup is tens of
 *   kilobytes, and every line of it names something the click and type tools
 *   accept. A model working from a snapshot is working from what the page
 *   *is*.
 * - **The pixels** — `browser_screenshot`. For when the layout is the
 *   question: a chart, a map, a CAPTCHA, a page whose markup says nothing
 *   about what it looks like. It is also the only mode that shows a page the
 *   way a person would see it, which is what makes it the one to check work
 *   against.
 * - **The console** — `browser_eval`, and `browser_console` for what the page
 *   said on its own. This is the escape hatch, and it is a real one: it is the
 *   page's own JavaScript context, so anything the page can do to itself, this
 *   can do.
 *
 * The tools say all of that to the model, because a model that reaches for a
 * screenshot to read a heading is spending twenty times the tokens on a worse
 * answer.
 *
 * ## What this machine is not
 *
 * It is not the page the harness runs in, and it is not a browser profile that
 * has ever been logged into anything. `src/browser/engine.ts` has the whole
 * argument; what the model needs from it is in {@link machinePrompt}, and the
 * two limits that will actually be hit — no cookies on the wire, so no logins;
 * and most hosts needing the CORS proxy — are stated where they will be read
 * rather than left to be discovered.
 */

import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError, type ContentBlock, type ImageBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { VIEWPORT, browserMachine, type TabInfo } from '../browser/engine.ts'
import { volume } from '../vfs/volume.ts'
import { WORKSPACE_ROOT } from './seed.ts'
import { dirname } from '../vfs/path.ts'
import { proxyConfig } from '../net/cors-proxy.ts'
import { fitToBudget, routeSeesImages, type Attachments } from './vision.ts'

/** Services this row waits for before it applies. */
export const inject = ['tools', 'systemPrompt']

/** The row's id in the composition. */
export const name = 'web-browser'

/** Turn a tool-call abort into the error the loop recognises. */
function aborted(): never {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  throw error
}

/** The machine, which starts itself on first use. */
function machine(): ReturnType<typeof browserMachine> {
  return browserMachine()
}

/** One node of a snapshot, as the frame builds it. */
interface SnapshotNode {
  ref: string
  role: string
  name: string
  tag: string
  value?: string
  href?: string
  checked?: boolean
  disabled?: boolean
  rect: { x: number, y: number, width: number, height: number }
  children: SnapshotNode[]
}

/** What the frame returns for a snapshot. */
interface SnapshotResult {
  url: string
  title: string
  tree: SnapshotNode | null
  viewport: { width: number, height: number }
  scroll: { x: number, y: number }
  size: { width: number, height: number }
}

/**
 * Render the accessibility tree the way it is cheapest to read.
 *
 * One line per node, indented by depth, in the shape a model has seen in
 * every other browser-driving harness: role, name, then the reference to act
 * on. Deliberately not JSON — the same tree as JSON is roughly three times the
 * tokens and no clearer, and the tokens come out of the budget for the page
 * itself.
 * @param node - the node to render.
 * @param depth - how far to indent.
 * @returns the lines.
 */
function renderTree(node: SnapshotNode, depth = 0): string[] {
  const lines: string[] = []
  const indent = '  '.repeat(depth)
  const named = node.name === '' ? '' : ` ${JSON.stringify(node.name)}`
  if (node.ref !== '') {
    const extras: string[] = [`ref=${node.ref}`]
    if (node.value !== undefined && node.value !== '') extras.push(`value=${JSON.stringify(node.value)}`)
    if (node.checked === true) extras.push('checked')
    if (node.disabled === true) extras.push('disabled')
    if (node.href !== undefined) extras.push(`href=${node.href}`)
    lines.push(`${indent}- ${node.role}${named} [${extras.join(' ')}]`)
  } else if (node.children.length > 0) lines.push(`${indent}- ${node.role}`)
  for (const child of node.children) lines.push(...renderTree(child, node.ref === '' && depth === 0 ? depth : depth + 1))
  return lines
}

/** A one-line description of a tab, for the tools that list them. */
function describeTab(tab: TabInfo): string {
  const marks = [
    tab.active ? 'active' : '',
    tab.loading ? 'loading' : '',
    tab.error === undefined ? '' : `error: ${tab.error}`,
  ].filter((mark) => mark !== '')
  return `${tab.id}  ${tab.title}\n    ${tab.url}${marks.length === 0 ? '' : `\n    (${marks.join(', ')})`}`
}

/** The shared `tab` parameter, which every tool takes and few sessions need. */
const TAB_PARAMETER = {
  type: 'string',
  description: 'Which tab to act on. Defaults to the active one, which is what a single-tab session always wants.',
} as const

/** The shared way of naming an element. */
const TARGET_PARAMETERS = {
  ref: {
    type: 'string',
    description: 'The element reference from the most recent browser_snapshot, such as `e12`. This is the '
      + 'reliable way to name an element; references are replaced by the next snapshot.',
  },
  selector: {
    type: 'string',
    description: 'A CSS selector, as an alternative to `ref`. Use it when you know the page\'s markup or when '
      + 'a snapshot did not name what you want.',
  },
} as const

/**
 * What the model is told about the machine it is on.
 * @returns the system-prompt section.
 */
function machinePrompt(): string {
  const proxy = proxyConfig()
  return [
    'This session does not run in a container and it does not run on an emulated PC. Its machine is a '
    + '**browser**: real tabs, showing real pages off the real web, rendered by the browser engine this '
    + 'page is itself running in. There is no shell, no Node, no Python and no `bash` tool, because none '
    + 'of them exists on this machine.',

    'You drive it with the `browser_*` tools, and a page is available three ways. `browser_snapshot` gives '
    + 'you the page as a labelled tree with a reference for everything clickable — reach for this first, '
    + 'almost always, because it is exact and small. `browser_screenshot` gives you the pixels, which is '
    + 'what you want when the layout is the question or when you are checking your own work. '
    + '`browser_eval` runs JavaScript in the page itself, which is the escape hatch when the other two '
    + 'cannot express what you need.',

    'Two filesystems, and only one of them is yours. Your `read`, `write`, `edit`, `grep` and `glob` '
    + 'tools operate on this browser\'s own workspace — your notes, your reports, and anything the user '
    + 'gave you. The pages you browse have no filesystem at all, and nothing you do in a tab touches the '
    + 'workspace except a screenshot, which is saved into it.',

    'Read these two limits before you plan around them, because they are the ones you will hit:',

    '  **You cannot log in to anything.** Cookies work inside a page — a site\'s own scripts set and read '
    + 'them, and they persist between visits — but no cookie travels on a network request, because '
    + '`Cookie` is a header a browser forbids a page to set, and no `set-cookie` comes back, because CORS '
    + 'does not expose it. Anything behind a login is out of reach. Do not spend turns trying; say so.',

    proxy.enabled
      ? '  **Most sites are reached through the CORS proxy.** A host that refuses cross-origin reads — '
        + 'which is most of the web — is retried automatically through the proxy configured in '
        + 'Settings → Network. That proxy is a third party and it sees the whole request, so never send a '
        + 'credential, a token or anything private through this machine.'
      : '  **Most sites cannot be reached at all right now.** This session has no CORS proxy configured, so '
        + 'only hosts that send `access-control-allow-origin` can be browsed — a small fraction of the web. '
        + 'If a page will not load, that is almost certainly why, and Settings → Network is where the user '
        + 'turns a proxy on. Tell them rather than retrying.',

    'Each tab is sandboxed with an opaque origin, so a page cannot reach this harness, its storage, its '
    + 'keys, or another site\'s data — and it starts logged out of everything, because the profile is this '
    + 'machine\'s own and not the user\'s real browser.',

    `Tabs are ${String(VIEWPORT.width)}×${String(VIEWPORT.height)}. The user can watch them in the Machine `
    + 'panel, so what you click, they see.',

    'What does not work, so you do not spend a turn proving it: WebSockets (there is no relay), '
    + '`indexedDB` and the Cache API (removed rather than faked, so sites fall back to `localStorage`, '
    + 'which does work), file downloads and uploads, and anything needing a real user gesture such as a '
    + 'permission prompt. Modal dialogs — `alert`, `confirm`, `prompt` — are answered with their dismissed '
    + 'default and recorded; `browser_console` shows them.',
  ].join('\n\n')
}

/**
 * Mount the row.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    // The same slot the other machines' advice takes, so a session gets one
    // description of its machine rather than two that disagree.
    name: 'machine:browser',
    order: 105,
    text: machinePrompt(),
  })

  registerNavigate(ctx)
  registerTabs(ctx)
  registerSnapshot(ctx)
  registerClick(ctx)
  registerType(ctx)
  registerSelect(ctx)
  registerKey(ctx)
  registerScroll(ctx)
  registerScreenshot(ctx)
  registerEval(ctx)
  registerConsole(ctx)
  registerText(ctx)
  registerWait(ctx)
  registerHistory(ctx)
  registerStorage(ctx)
}

/** The schema every tool returning a tab's state validates against. */
const TAB_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    active: { type: 'boolean', required: true },
    loading: { type: 'boolean', required: true },
    error: { type: 'string' },
    canGoBack: { type: 'boolean', required: true },
    canGoForward: { type: 'boolean', required: true },
  },
} as const

/** Render a tab result the way every navigation reports itself. */
function renderTab(tab: TabInfo): string {
  return `${tab.title}\n${tab.url}${tab.error === undefined ? '' : `\n[${tab.error}]`}`
    + '\nTake a browser_snapshot to see what is on it.'
}

/** Going to a URL. */
function registerNavigate(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: [
      'Open a URL in this machine\'s browser.',
      '',
      'Opens a tab if none is open yet, so this is the tool that starts a session. A bare host such as',
      '`example.com` is treated as `https://example.com`.',
      '',
      'The result is the tab, not the page: nothing about what is *on* it comes back here, because a page',
      'is far too large to return whole and you almost never want all of it. Follow this with',
      '`browser_snapshot` to see what can be interacted with, `browser_text` to read it, or',
      '`browser_screenshot` to look at it.',
      '',
      'A page that will not load reports why, and the reason is usually one of two: the host refuses',
      'cross-origin reads and needs the CORS proxy, or it is simply down. Read the message rather than',
      'retrying the same URL.',
    ].join('\n'),
    parameters: {
      url: { type: 'string', required: true, description: 'Where to go.' },
      newTab: {
        type: 'boolean',
        description: 'Open it in a new tab instead of reusing the current one. Defaults to false.',
      },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: TAB_OUTPUT,
      render: (_args, value) => [{ type: 'text' as const, text: renderTab(value as unknown as TabInfo) }],
    },
    async execute(args: { url: string, newTab?: boolean, tab?: string }, exec): Promise<TabInfo> {
      if (exec.signal.aborted) aborted()
      const url = String(args.url ?? '').trim()
      if (url === '') throw new Error('invalid url: expected a non-empty string')
      const browser = machine()
      if (args.newTab === true) {
        const id = await browser.newTab(url)
        return browser.tabs().find((tab) => tab.id === id) ?? { ...(browser.tabs()[0] as TabInfo) }
      }
      return browser.navigate(url, args.tab)
    },
    presentCall: (args: { url: string }) => ({
      card: 'generic' as const, title: String(args.url), kind: 'read' as const,
    }),
  }))
}

/** Managing tabs. */
function registerTabs(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: [
      'List, open, close and switch between this machine\'s tabs.',
      '',
      'Tabs here work the way tabs work: each has its own page, its own history and its own console, and',
      'they share one profile, so a cookie set in one is visible in another on the same site. Every other',
      'tool acts on the active tab unless you name one.',
      '',
      'Use several when a task genuinely needs two pages at once — comparing them, or keeping a search',
      'result open while reading a link from it. A tab left open costs memory and nothing else, but a',
      'session with nine tabs open is one where it is easy to act on the wrong one.',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'new', 'close', 'select'],
        description: 'What to do. `list` reports every tab; `new` opens one; `close` and `select` need a tab id.',
      },
      url: { type: 'string', description: 'For `new`: where to open it. Omitted, it opens blank.' },
      tab: { type: 'string', description: 'For `close` and `select`: which tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabs: {
            type: 'array',
            required: true,
            items: TAB_OUTPUT,
          },
        },
      },
      render: (_args, value) => {
        const { tabs } = value as unknown as { tabs: TabInfo[] }
        if (tabs.length === 0) return [{ type: 'text' as const, text: 'No tabs are open.' }]
        return [{
          type: 'text' as const,
          text: `${String(tabs.length)} tab${tabs.length === 1 ? '' : 's'}:\n${tabs.map(describeTab).join('\n')}`,
        }]
      },
    },
    async execute(args: { action: string, url?: string, tab?: string }, exec): Promise<{ tabs: TabInfo[] }> {
      if (exec.signal.aborted) aborted()
      const browser = machine()
      await browser.open()
      if (args.action === 'new') await browser.newTab(args.url)
      else if (args.action === 'close') {
        if (args.tab === undefined) throw new Error('close needs a tab id; browser_tabs list reports them')
        browser.closeTab(args.tab)
      } else if (args.action === 'select') {
        if (args.tab === undefined) throw new Error('select needs a tab id; browser_tabs list reports them')
        browser.selectTab(args.tab)
      }
      return { tabs: browser.tabs() }
    },
    presentCall: (args: { action: string }) => ({
      card: 'generic' as const, title: `tabs: ${String(args.action)}`, kind: 'read' as const,
    }),
  }))
}

/** The DOM mode. */
function registerSnapshot(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: [
      'Read the page as a tree of everything on it that can be interacted with.',
      '',
      'THIS IS THE TOOL TO REACH FOR FIRST. It is exact — it reads the page\'s own structure rather than',
      'guessing from pixels — and it is small, usually a few dozen lines for a page of tens of kilobytes',
      'of markup. Nearly every task on a page is snapshot, act, snapshot again.',
      '',
      'Each line is a role, a name, and a `ref` in brackets. That `ref` is what `browser_click`,',
      '`browser_type` and `browser_select` take, and it is the reliable way to name an element — far more',
      'so than a CSS selector you guessed.',
      '',
      'REFS DO NOT SURVIVE. They are handed out fresh by every snapshot and the old ones stop working, on',
      'purpose: a ref that outlived a re-render would point at an element the page had replaced, and',
      'clicking it would quietly do nothing. After anything that changes the page — a click, a',
      'navigation, a wait — take a new snapshot before acting again.',
      '',
      'Only visible elements are listed. Something you expect and cannot find is usually behind a menu, or',
      'below the fold on a page that renders lazily, or in a dialog that has not opened yet — scroll,',
      'click the thing that reveals it, or use `browser_wait`, then snapshot again.',
    ].join('\n'),
    parameters: {
      all: {
        type: 'boolean',
        description: 'Include every visible element rather than only the interactive and structural ones. '
          + 'Much larger; use it when something you need is definitely on the page and not in the normal tree.',
      },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          snapshot: { type: 'string', required: true },
          viewport: {
            type: 'object',
            additionalProperties: false,
            properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } },
          },
          scroll: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } },
          },
          size: {
            type: 'object',
            additionalProperties: false,
            properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } },
          },
        },
      },
      render: (_args, value) => {
        const result = value as unknown as {
          url: string, title: string, snapshot: string
          scroll: { x: number, y: number }, size: { width: number, height: number }
          viewport: { width: number, height: number }
        }
        const below = result.size.height - result.scroll.y - result.viewport.height
        return [{
          type: 'text' as const,
          text: `${result.title}\n${result.url}\n\n${result.snapshot === '' ? '(nothing on the page)' : result.snapshot}`
            + (below > 40
              ? `\n\n${String(Math.round(below))}px of page below the fold — browser_scroll to reach it.`
              : ''),
        }]
      },
    },
    async execute(args: { all?: boolean, tab?: string }, exec): Promise<SnapshotResult & { snapshot: string }> {
      if (exec.signal.aborted) aborted()
      const result = await machine().run('snapshot', { all: args.all === true }, args.tab) as SnapshotResult
      return {
        ...result,
        snapshot: result.tree === null ? '' : renderTree(result.tree).join('\n'),
        tree: null,
      }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'page snapshot', kind: 'read' as const }),
  }))
}

/** Clicking. */
function registerClick(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: [
      'Click something on the page.',
      '',
      'Name the element with `ref` from the most recent `browser_snapshot` — that is the reliable way. A',
      '`selector` works too when you know the markup. Coordinates are the last resort and are only right',
      'when you have just taken a screenshot: they are viewport pixels, they are relative to the visible',
      'area rather than the whole page, and anything that scrolls invalidates them.',
      '',
      'The full pointer sequence is sent, not just a `click` event — pointerdown, mousedown, mouseup,',
      'click — because a menu that opens on mousedown never opens for anything less.',
      '',
      'A click that navigates leaves the page you were on; a click that opens a dialog does not. Either',
      'way the refs you were holding are stale, so snapshot again before you act.',
    ].join('\n'),
    parameters: {
      ...TARGET_PARAMETERS,
      x: { type: 'number', description: 'Viewport x, when clicking by position. Needs `y` as well.' },
      y: { type: 'number', description: 'Viewport y, when clicking by position.' },
      doubleClick: { type: 'boolean', description: 'Click twice in quick succession.' },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Which button. Defaults to left.',
      },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tag: { type: 'string' },
          name: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const result = value as unknown as { tag?: string, name?: string }
        return [{
          type: 'text' as const,
          text: result.tag === undefined
            ? 'Clicked. Take a fresh browser_snapshot — the page may have changed.'
            : `Clicked <${result.tag}>${result.name === undefined || result.name === '' ? '' : ` ${JSON.stringify(result.name)}`}. `
              + 'Take a fresh browser_snapshot — the page may have changed.',
        }]
      },
    },
    async execute(
      args: { ref?: string, selector?: string, x?: number, y?: number, doubleClick?: boolean, button?: string, tab?: string },
      exec,
    ): Promise<{ ok: boolean, tag?: string, name?: string }> {
      if (exec.signal.aborted) aborted()
      const button = args.button === 'right' ? 2 : args.button === 'middle' ? 1 : 0
      const count = args.doubleClick === true ? 2 : 1
      if (args.ref === undefined && args.selector === undefined) {
        if (args.x === undefined || args.y === undefined) {
          throw new Error('expected a ref, a selector, or an x and y')
        }
        return await machine().run('clickAt', { x: args.x, y: args.y }, args.tab) as { ok: boolean, tag?: string, name?: string }
      }
      return await machine().run('click', {
        ...(args.ref === undefined ? {} : { ref: args.ref }),
        ...(args.selector === undefined ? {} : { selector: args.selector }),
        button,
        count,
      }, args.tab) as { ok: boolean }
    },
    presentCall: (args: { ref?: string, selector?: string }) => ({
      card: 'generic' as const,
      title: `click ${args.ref ?? args.selector ?? 'at position'}`,
      kind: 'execute' as const,
    }),
  }))
}

/** Typing. */
function registerType(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: [
      'Type into a text field.',
      '',
      'The value is set through the browser\'s own native setter and then `input` and `change` are fired,',
      'which is what makes this work on sites built with React and everything like it. Assigning to the',
      'element\'s `value` — which is what `browser_eval` would do — updates what is drawn and leaves the',
      'framework\'s own state untouched, and the form then submits empty. Use this tool rather than that.',
      '',
      '`submit` presses Enter afterwards, which is how most search boxes are used.',
    ].join('\n'),
    parameters: {
      ...TARGET_PARAMETERS,
      text: { type: 'string', required: true, description: 'What to type.' },
      append: {
        type: 'boolean',
        description: 'Add to what is already in the field rather than replacing it. Defaults to false.',
      },
      submit: { type: 'boolean', description: 'Press Enter afterwards. Defaults to false.' },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: (args) => [{
        type: 'text' as const,
        text: `Typed ${JSON.stringify(String((args as { text?: string }).text ?? ''))}.`
          + ((args as { submit?: boolean }).submit === true ? ' Pressed Enter.' : '')
          + ' Take a fresh browser_snapshot.',
      }],
    },
    async execute(
      args: { ref?: string, selector?: string, text: string, append?: boolean, submit?: boolean, tab?: string },
      exec,
    ): Promise<{ ok: boolean }> {
      if (exec.signal.aborted) aborted()
      return await machine().run('type', {
        ...(args.ref === undefined ? {} : { ref: args.ref }),
        ...(args.selector === undefined ? {} : { selector: args.selector }),
        text: String(args.text ?? ''),
        replace: args.append !== true,
        enter: args.submit === true,
      }, args.tab) as { ok: boolean }
    },
    presentCall: (args: { ref?: string, selector?: string }) => ({
      card: 'generic' as const, title: `type into ${args.ref ?? args.selector ?? 'field'}`, kind: 'execute' as const,
    }),
  }))
}

/** Dropdowns. */
function registerSelect(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_select',
    description: [
      'Choose an option in a `<select>` dropdown.',
      '',
      'Clicking a native dropdown does not work — the list it opens is drawn by the operating system and',
      'is not part of the page — so this sets the value directly and fires the events the page listens',
      'for. The value may be either the option\'s `value` or the text shown for it; a value that is',
      'neither reports what the options actually are.',
    ].join('\n'),
    parameters: {
      ...TARGET_PARAMETERS,
      value: { type: 'string', required: true, description: 'The option\'s value or its visible text.' },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, value: { type: 'string', required: true } },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: `Selected ${JSON.stringify((value as { value: string }).value)}.`,
      }],
    },
    async execute(
      args: { ref?: string, selector?: string, value: string, tab?: string },
      exec,
    ): Promise<{ ok: boolean, value: string }> {
      if (exec.signal.aborted) aborted()
      return await machine().run('select', {
        ...(args.ref === undefined ? {} : { ref: args.ref }),
        ...(args.selector === undefined ? {} : { selector: args.selector }),
        value: String(args.value ?? ''),
      }, args.tab) as { ok: boolean, value: string }
    },
    presentCall: (args: { value: string }) => ({
      card: 'generic' as const, title: `select ${String(args.value)}`, kind: 'execute' as const,
    }),
  }))
}

/** The keyboard. */
function registerKey(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_key',
    description: [
      'Press a key at whatever currently has focus.',
      '',
      'For the keys that mean something on their own — Enter, Tab, Escape, the arrows, PageDown — and for',
      'shortcuts, with `modifiers`. To put text in a field use `browser_type`, which is both faster and',
      'more reliable than pressing one key at a time.',
      '',
      'Key names are the ones the web platform uses: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`,',
      '`ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, or a single',
      'character.',
    ].join('\n'),
    parameters: {
      key: { type: 'string', required: true, description: 'The key, as `KeyboardEvent.key` spells it.' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'] },
        description: 'Modifiers held while it is pressed.',
      },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (args) => [{
        type: 'text' as const,
        text: `Pressed ${String((args as { key?: string }).key ?? '')}. Take a fresh browser_snapshot.`,
      }],
    },
    async execute(args: { key: string, modifiers?: string[], tab?: string }, exec): Promise<{ ok: boolean }> {
      if (exec.signal.aborted) aborted()
      return await machine().run('key', {
        key: String(args.key ?? ''),
        modifiers: args.modifiers ?? [],
      }, args.tab) as { ok: boolean }
    },
    presentCall: (args: { key: string }) => ({
      card: 'generic' as const, title: `key ${String(args.key)}`, kind: 'execute' as const,
    }),
  }))
}

/** Scrolling. */
function registerScroll(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: [
      'Scroll the page, or bring an element into view.',
      '',
      'Give a `ref` or `selector` to scroll that element to the middle of the window, which is usually',
      'what you want; give `x` and `y` to scroll to an absolute position. `browser_snapshot` reports how',
      'much page is left below the fold, and pages that load more as you scroll need this before the rest',
      'of them exists.',
    ].join('\n'),
    parameters: {
      ...TARGET_PARAMETERS,
      x: { type: 'number', description: 'Absolute horizontal scroll position, in page pixels.' },
      y: { type: 'number', description: 'Absolute vertical scroll position, in page pixels.' },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } },
      },
      render: (_args, value) => {
        const at = value as unknown as { x: number, y: number }
        return [{ type: 'text' as const, text: `Scrolled to ${String(at.x)}, ${String(at.y)}.` }]
      },
    },
    async execute(
      args: { ref?: string, selector?: string, x?: number, y?: number, tab?: string },
      exec,
    ): Promise<{ x: number, y: number }> {
      if (exec.signal.aborted) aborted()
      return await machine().run('scroll', {
        ...(args.ref === undefined ? {} : { ref: args.ref }),
        ...(args.selector === undefined ? {} : { selector: args.selector }),
        ...(args.x === undefined ? {} : { x: args.x }),
        ...(args.y === undefined ? {} : { y: args.y }),
      }, args.tab) as { x: number, y: number }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'scroll', kind: 'execute' as const }),
  }))
}

/** What a screenshot produced. */
interface Shot {
  path: string
  width: number
  height: number
  bytes: number
  url: string
  scale?: number
  of?: { width: number, height: number }
  image?: {
    attachmentId: string
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
    name?: string
  }
}

/** The visual mode. */
function registerScreenshot(ctx: Context): void {
  let counter = 0
  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: [
      'Photograph the page. The picture comes back with the result, the way `read_image` returns a file.',
      '',
      'It is also saved into the workspace as a PNG, so the user can open it from the Files panel. On a',
      'model that does not accept images you get the path and the size and nothing to look at.',
      '',
      'REACH FOR `browser_snapshot` FIRST for anything you could read as text. A screenshot costs roughly',
      'twenty times the tokens of the snapshot of the same page and tells you less about what is',
      'clickable. This is the right tool when the layout itself is the question — a chart, a map, a',
      'rendering problem — and when you want to check that what you did looks like what you meant.',
      '',
      'By default it takes the visible window. `fullPage` takes the whole document, which for a long page',
      'is a tall thin image that survives downscaling badly; prefer scrolling and taking two.',
      '',
      'READ THIS BEFORE USING A COORDINATE. A picture bigger than the model\'s image budget is made',
      'smaller before it reaches you, so a position read off it is a *picture* pixel and not a page one.',
      'Every result says what the picture is, what the page is, and the arithmetic between them; use those',
      'numbers rather than assuming 1:1.',
      '',
      'What it cannot draw: a nested frame, a plugin, and video. Text and layout are the browser\'s own',
      'rendering and are accurate.',
    ].join('\n'),
    parameters: {
      fullPage: { type: 'boolean', description: 'Take the whole document rather than the visible window.' },
      path: {
        type: 'string',
        description: 'Where to save it, relative to the workspace. Defaults to screenshots/page-<n>.png.',
      },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          scale: { type: 'number' },
          of: {
            type: 'object',
            additionalProperties: false,
            properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } },
          },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true, enum: ['image/png'] },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        const shot = value as unknown as Shot
        const mapping = shot.of === undefined
          ? ''
          : `\nThis picture is ${String(shot.width)}×${String(shot.height)} of a `
            + `${String(shot.of.width)}×${String(shot.of.height)} page. To turn a position (x, y) you read `
            + `off it into page pixels: x_page = x ÷ ${String(shot.scale ?? 1)}, y_page = y ÷ ${String(shot.scale ?? 1)}.`
        const parts: ContentBlock[] = [{
          type: 'text',
          text: `${shot.url}\n${String(shot.width)}×${String(shot.height)}, saved ${shot.path}${mapping}`
            + (shot.image === undefined
              ? '\nThis model does not accept images, so the picture is not attached; the file is there for the user.'
              : ''),
        }]
        if (shot.image !== undefined) {
          parts.push({ type: 'image', attachment: shot.image as unknown as ImageBlock['attachment'] })
        }
        return parts
      },
    },
    async execute(args: { fullPage?: boolean, path?: string, tab?: string }, exec): Promise<Shot> {
      if (exec.signal.aborted) aborted()
      const browser = machine()
      const taken = await browser.run('screenshot', { fullPage: args.fullPage === true }, args.tab) as {
        dataUrl: string, width: number, height: number
      }
      const base64 = taken.dataUrl.slice(taken.dataUrl.indexOf(',') + 1)
      const binary = atob(base64)
      const raw = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) raw[index] = binary.charCodeAt(index)

      const fitted = await fitToBudget(raw, taken.width, taken.height)
      const relative = args.path ?? `screenshots/page-${String(++counter)}.png`
      const path = relative.startsWith('/') ? relative : `${WORKSPACE_ROOT}/${relative}`
      volume.mkdirp(dirname(path))
      volume.writeFile(path, fitted.bytes)

      const tabs = browser.tabs()
      const current = args.tab === undefined
        ? tabs.find((tab) => tab.active)
        : tabs.find((tab) => tab.id === args.tab)
      const result: Shot = {
        path,
        width: fitted.width,
        height: fitted.height,
        bytes: fitted.bytes.length,
        url: current?.url ?? '',
        ...(fitted.scale === undefined ? {} : { scale: fitted.scale, of: { width: taken.width, height: taken.height } }),
      }

      const attachments = ctx.get('attachments') as Attachments | undefined
      if (attachments === undefined || !await routeSeesImages(ctx, exec)) return result
      try {
        const saved = await attachments.saveImage({
          data: fitted.bytes,
          mediaType: 'image/png',
          name: path.slice(path.lastIndexOf('/') + 1),
        })
        return { ...result, image: { ...saved, mediaType: 'image/png' } }
      } catch {
        return result
      }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'page screenshot', kind: 'read' as const }),
  }))
}

/** The console mode. */
function registerEval(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_eval',
    description: [
      'Run JavaScript inside the page, and get what it evaluates to.',
      '',
      'This is the page\'s own console: the same globals, the same DOM, the same libraries the site',
      'loaded. `document.querySelectorAll(...)`, a site\'s own `window.__DATA__`, a quick',
      '`[...document.links].map(a => a.href)` — anything the page can do to itself.',
      '',
      'The last expression is the result, or use `return` explicitly for several statements. `await`',
      'works at the top level. The result is reduced to plain data on the way back — functions and DOM',
      'nodes come back as short descriptions rather than as objects — so extract what you want inside the',
      'expression rather than returning a node and hoping.',
      '',
      'Prefer `browser_click` and `browser_type` over doing the same thing here. Setting `input.value`',
      'from JavaScript updates what is drawn and does not tell the framework behind the page, which is',
      'the single most common way an agent fills a form that then submits empty.',
      '',
      'This runs in the page, which is sandboxed away from the harness — there is nothing here that can',
      'reach the workspace, the session, or anything outside the tab.',
    ].join('\n'),
    parameters: {
      source: { type: 'string', required: true, description: 'The JavaScript to run.' },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string', required: true },
          type: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const held = value as unknown as { value: string, type: string }
        return [{
          type: 'text' as const,
          text: held.value === '' ? `(empty ${held.type})` : held.value,
        }]
      },
    },
    async execute(args: { source: string, tab?: string }, exec): Promise<{ value: string, type: string }> {
      if (exec.signal.aborted) aborted()
      const source = String(args.source ?? '')
      if (source.trim() === '') throw new Error('invalid source: expected a non-empty string')
      const result = await machine().run('evaluate', { source }, args.tab) as { value: unknown }
      const held = result.value
      // Rendered here rather than carried as an arbitrary value: a result
      // schema has to say what shape it is, and "whatever the page returned"
      // is not one. The type is reported beside it so `null` and `"null"` are
      // still distinguishable.
      return {
        value: typeof held === 'string' ? held : JSON.stringify(held, null, 2) ?? String(held),
        type: held === null ? 'null' : Array.isArray(held) ? 'array' : typeof held,
      }
    },
    presentCall: (args: { source: string }) => ({
      card: 'terminal' as const,
      title: String(args.source).split('\n')[0]?.slice(0, 120) ?? '',
      description: 'evaluate in the page',
    }),
  }))
}

/** What the page said on its own. */
function registerConsole(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_console',
    description: [
      'Read what the page logged, what it failed at, and what it fetched.',
      '',
      'Every `console.*` call, every uncaught error and every unhandled rejection is recorded as it',
      'happens, so this shows what went wrong even for things that failed before you looked. The request',
      'log shows every fetch the page made through this machine and what came back, which is how to tell',
      '"the site is broken" from "the request was refused and needs the CORS proxy".',
      '',
      'Modal dialogs are here too. `alert`, `confirm` and `prompt` cannot be shown to anybody, so they are',
      'answered with the value a dismissed dialog returns and recorded here — if a page seems to have done',
      'nothing, check whether it was waiting on one.',
    ].join('\n'),
    parameters: {
      limit: { type: 'integer', description: 'How many of the most recent entries to return. Defaults to 100.' },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['console', 'requests', 'dialogs'] },
        description: 'Which logs to return. Defaults to all three.',
      },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          console: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                level: { type: 'string', required: true },
                text: { type: 'string', required: true },
                at: { type: 'number', required: true },
              },
            },
          },
          requests: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                method: { type: 'string', required: true },
                status: { type: 'integer', required: true },
                at: { type: 'number', required: true },
                error: { type: 'string' },
              },
            },
          },
          dialogs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                message: { type: 'string', required: true },
                at: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const logs = value as unknown as {
          console: { level: string, text: string }[]
          requests: { url: string, method: string, status: number, error?: string }[]
          dialogs: { kind: string, message: string }[]
        }
        const sections: string[] = []
        if (logs.console.length > 0) {
          sections.push(`console (${String(logs.console.length)}):\n`
            + logs.console.map((entry) => `  [${entry.level}] ${entry.text}`).join('\n'))
        }
        if (logs.requests.length > 0) {
          sections.push(`requests (${String(logs.requests.length)}):\n`
            + logs.requests.map((entry) => `  ${entry.method} ${String(entry.status)} ${entry.url}`
              + (entry.error === undefined ? '' : ` — ${entry.error}`)).join('\n'))
        }
        if (logs.dialogs.length > 0) {
          sections.push(`dialogs (${String(logs.dialogs.length)}):\n`
            + logs.dialogs.map((entry) => `  ${entry.kind}: ${entry.message}`).join('\n'))
        }
        return [{ type: 'text' as const, text: sections.length === 0 ? 'Nothing logged.' : sections.join('\n\n') }]
      },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(args: { limit?: number, include?: string[], tab?: string }, exec) {
      if (exec.signal.aborted) aborted()
      const limit = args.limit ?? 100
      const wanted = new Set(args.include ?? ['console', 'requests', 'dialogs'])
      const logs = machine().logs(args.tab)
      return {
        console: wanted.has('console') ? logs.console.slice(-limit) : [],
        requests: wanted.has('requests') ? logs.requests.slice(-limit) : [],
        dialogs: wanted.has('dialogs') ? logs.dialogs.slice(-limit) : [],
      }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'page console', kind: 'read' as const }),
  }))
}

/** Reading the page. */
function registerText(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_text',
    description: [
      'Read the page as text, the way it appears to somebody looking at it.',
      '',
      'This is the rendered text — what `innerText` gives — so it follows the layout and skips markup,',
      'scripts and hidden elements. For reading an article, a search result page or a table of numbers,',
      'this is the tool: it is a fraction of the tokens of the HTML and none of the noise.',
      '',
      '`selector` narrows it to one part of the page, which is worth doing on anything large.',
      '',
      'It says nothing about what can be clicked — that is `browser_snapshot` — so a task that involves',
      'both reading and acting wants one of each.',
    ].join('\n'),
    parameters: {
      selector: { type: 'string', description: 'A CSS selector to read instead of the whole page.' },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const page = value as unknown as { text: string, url: string, title: string }
        return [{ type: 'text' as const, text: `${page.title}\n${page.url}\n\n${page.text.trim()}` }]
      },
    },
    async execute(args: { selector?: string, tab?: string }, exec): Promise<{ text: string, url: string, title: string }> {
      if (exec.signal.aborted) aborted()
      return await machine().run('text', {
        ...(args.selector === undefined ? {} : { selector: args.selector }),
      }, args.tab) as { text: string, url: string, title: string }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'read page', kind: 'read' as const }),
  }))
}

/** Waiting. */
function registerWait(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_wait',
    description: [
      'Wait for something on the page to appear.',
      '',
      'Pages finish loading after they finish arriving: a click starts a request, the request comes back,',
      'and the thing you are waiting for renders some time later. Waiting for the *thing* is right; a',
      'fixed sleep is either too short or wasted.',
      '',
      'Give a `selector` to wait for an element to exist and be visible, or `text` to wait for it to',
      'appear anywhere on the page. With neither, it waits for the document to finish loading.',
      '',
      'A wait that times out is not an error — it reports that the condition was not met and what the page',
      'is now, which is usually the more useful answer.',
    ].join('\n'),
    parameters: {
      selector: { type: 'string', description: 'A CSS selector to wait for.' },
      text: { type: 'string', description: 'Text to wait for anywhere on the page.' },
      timeoutMs: { type: 'number', description: 'How long to wait. Defaults to 10000.' },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          waitedMs: { type: 'number', required: true },
          title: { type: 'string' },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const result = value as unknown as { found: boolean, title?: string, url?: string }
        return [{
          type: 'text' as const,
          text: result.found
            ? 'Found it. Take a browser_snapshot to see the page now.'
            : `Timed out; that did not appear. The page is now ${result.title ?? ''} (${result.url ?? ''}).`,
        }]
      },
    },
    async execute(
      args: { selector?: string, text?: string, timeoutMs?: number, tab?: string },
      exec,
    ): Promise<{ found: boolean, waitedMs: number, title?: string, url?: string }> {
      if (exec.signal.aborted) aborted()
      return await machine().run('waitFor', {
        ...(args.selector === undefined ? {} : { selector: args.selector }),
        ...(args.text === undefined ? {} : { text: args.text }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      }, args.tab) as { found: boolean, waitedMs: number }
    },
    presentCall: (args: { selector?: string, text?: string }) => ({
      card: 'generic' as const,
      title: `wait for ${args.selector ?? args.text ?? 'the page to settle'}`,
      kind: 'read' as const,
    }),
  }))
}

/** Back, forward, reload. */
function registerHistory(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_history',
    description: [
      'Go back, go forward, or reload the current page.',
      '',
      'Each tab keeps its own history, exactly as a browser tab does, including the entries a page adds',
      'to it without navigating — a single-page application that changes its URL as you click through it',
      'is recorded here, and back does what its own back button does.',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['back', 'forward', 'reload'],
        description: 'Which way to go.',
      },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: TAB_OUTPUT,
      render: (_args, value) => [{ type: 'text' as const, text: renderTab(value as unknown as TabInfo) }],
    },
    async execute(args: { action: string, tab?: string }, exec): Promise<TabInfo> {
      if (exec.signal.aborted) aborted()
      const browser = machine()
      if (args.action === 'reload') {
        const tabs = browser.tabs()
        const current = args.tab === undefined ? tabs.find((tab) => tab.active) : tabs.find((tab) => tab.id === args.tab)
        if (current === undefined) throw new Error('no tab to reload')
        return browser.navigate(current.url, current.id, 'replace')
      }
      return browser.go(args.action === 'back' ? -1 : 1, args.tab)
    },
    presentCall: (args: { action: string }) => ({
      card: 'generic' as const, title: String(args.action), kind: 'execute' as const,
    }),
  }))
}

/** Cookies and stored data. */
function registerStorage(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_storage',
    description: [
      'Read or clear this machine\'s cookies and per-site storage.',
      '',
      'The profile is this machine\'s own: it starts empty, it is shared between tabs, it persists between',
      'sessions, and it has nothing in common with the user\'s real browser. Nothing here is the user\'s',
      'browsing.',
      '',
      'Worth knowing before drawing conclusions from it: these cookies are the ones page JavaScript set.',
      'No cookie is sent on a network request and no `set-cookie` comes back, so a session cookie from a',
      'server will never appear here. See the machine notes.',
      '',
      '`clear` is how to start a site fresh — a page stuck in a bad state, a consent banner that will not',
      'stay dismissed, a cached preference to be rid of.',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'clear'],
        description: 'Read the profile, or empty it.',
      },
      area: {
        type: 'string',
        enum: ['cookies', 'local', 'session', 'all'],
        description: 'Which part. Defaults to all of it.',
      },
      tab: TAB_PARAMETER,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cookies: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                value: { type: 'string', required: true },
                domain: { type: 'string', required: true },
                path: { type: 'string', required: true },
                expires: { type: 'number' },
                secure: { type: 'boolean', required: true },
              },
            },
          },
          origins: { type: 'array', required: true, items: { type: 'string' } },
          cleared: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const state = value as unknown as {
          cookies: { name: string, value: string, domain: string, path: string }[]
          origins: string[]
          cleared: boolean
        }
        if (state.cleared) return [{ type: 'text' as const, text: 'Cleared.' }]
        const lines: string[] = []
        lines.push(state.cookies.length === 0
          ? 'No cookies.'
          : `${String(state.cookies.length)} cookies:\n`
            + state.cookies.map((cookie) => `  ${cookie.domain}${cookie.path} ${cookie.name}=${cookie.value}`).join('\n'))
        lines.push(state.origins.length === 0
          ? 'No site has stored anything.'
          : `Storage held for: ${state.origins.join(', ')}`)
        return [{ type: 'text' as const, text: lines.join('\n\n') }]
      },
    },
    async execute(
      args: { action: string, area?: string, tab?: string },
      exec,
    ): Promise<{
      cookies: { name: string, value: string, domain: string, path: string, expires?: number, secure: boolean }[]
      origins: string[]
      cleared: boolean
    }> {
      if (exec.signal.aborted) aborted()
      const browser = machine()
      await browser.open()
      if (args.action === 'clear') {
        await browser.clearProfile()
        return { cookies: [], origins: [], cleared: true }
      }
      return {
        cookies: browser.cookies().map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
          secure: cookie.secure,
        })),
        origins: browser.profile.storedOrigins(),
        cleared: false,
      }
    },
    presentCall: (args: { action: string }) => ({
      card: 'generic' as const, title: `storage: ${String(args.action)}`, kind: 'read' as const,
    }),
  }))
}

export default { apply, inject, name }
