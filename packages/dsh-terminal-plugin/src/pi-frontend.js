import { appendFileSync } from 'node:fs'
import { Renderer } from './renderer.js'
import { InputClosed, InputInterrupted } from './input.js'
import { formatTokens, shortenPath } from './utils.js'
import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  Markdown,
  ProcessTerminal,
  Text,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '')
}

function paint(open, close = '39') {
  return text => `\x1b[${open}m${text}\x1b[${close}m`
}

const themeColor = {
  bold: paint('1', '22'),
  dim: paint('2', '22'),
  italic: paint('3', '23'),
  underline: paint('4', '24'),
  inverse: paint('7', '27'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  gray: paint('90'),
}

function fitLine(line, width) {
  const text = String(line)
  if (width <= 0) return ''
  if (visibleWidth(text) <= width) return text
  return truncateToWidth(text, width, '')
}

function isChrome(line) {
  const plain = stripAnsi(line)
  return plain.length > 0 && /^[─\s]+$/.test(plain)
}

function highlightCode(code) {
  return String(code).replace(/\n$/, '').split('\n').map(line => line
    .replace(/'[^'\n]*'|"[^"\n]*"/g, match => themeColor.green(match))
    .replace(/\b(const|let|var|function|return|if|else|new)\b/g, match => themeColor.magenta(match))
    .replace(/\b(true|false|null|undefined)\b/g, match => themeColor.yellow(match)))
}

const markdownTheme = {
  heading: themeColor.cyan,
  link: themeColor.blue,
  linkUrl: themeColor.dim,
  code: themeColor.yellow,
  codeBlock: text => text,
  codeBlockBorder: () => '',
  quote: themeColor.dim,
  quoteBorder: themeColor.dim,
  hr: themeColor.dim,
  listBullet: themeColor.cyan,
  bold: themeColor.bold,
  italic: themeColor.italic,
  strikethrough: themeColor.dim,
  underline: themeColor.underline,
  highlightCode,
  codeBlockIndent: '  ',
}

const editorTheme = {
  borderColor: themeColor.dim,
  selectList: {
    selectedPrefix: text => text,
    selectedText: text => themeColor.inverse(text),
    description: text => themeColor.dim(text),
    scrollInfo: text => themeColor.dim(text),
    noMatch: text => themeColor.dim(text),
  },
}

class ReplyMarkdown {
  constructor() {
    this.text = ''
    this.md = new Markdown('', 0, 0, markdownTheme)
  }

  append(chunk) {
    this.text += chunk
    this.md.setText(this.text)
  }

  invalidate() {
    this.md.invalidate()
  }

  render(width) {
    return this.md.render(width)
      .filter(line => !/^```/.test(stripAnsi(line).trim()))
      .map(line => fitLine(line, width))
  }
}

class Transcript {
  constructor() {
    this.blocks = []
  }

  invalidate() {
    for (const block of this.blocks) block.invalidate?.()
  }

  render(width) {
    const lines = []
    for (const block of this.blocks) {
      for (const line of block.render(width)) lines.push(fitLine(line, width))
    }
    return lines
  }
}

class Footer {
  constructor(view) {
    this.view = view
  }

  invalidate() {}

  render(width) {
    const info = this.view.renderer?.currentInfo ?? {}
    const model = info.model?.model || info.model?.provider || 'no-model'
    const cwd = info.cwd ? shortenPath(info.cwd) : ''
    const line = `${model} · context ${this.view.usageLabel()} · ${cwd}`
    return [fitLine(themeColor.dim(line), width)]
  }
}

class PromptEditor extends Editor {
  constructor(tui, theme, options, prefixFor) {
    super(tui, theme, options)
    this.prefixFor = prefixFor
  }

  render(width) {
    const prefix = this.prefixFor()
    const prefixWidth = Math.min(visibleWidth(prefix), Math.max(0, width - 2))
    const inner = Math.max(2, width - prefixWidth)
    const kept = super.render(inner).filter(line => !isChrome(line))
    if (kept.length === 0) kept.push('')
    const pad = ' '.repeat(prefixWidth)
    return kept.map((line, index) => fitLine(`${index === 0 ? prefix : pad}${line}`, width))
  }
}

class LiveSlash {
  constructor(entries) {
    this.entries = entries
  }

  commands() {
    try {
      return (this.entries?.() ?? []).map(entry => ({
        name: String(entry.name ?? '').replace(/^\//, ''),
        description: entry.description ?? '',
      })).filter(entry => entry.name !== '')
    } catch {
      return []
    }
  }

  async getSuggestions(lines, cursorLine, cursorCol, options) {
    const provider = new CombinedAutocompleteProvider(this.commands(), process.cwd())
    return provider.getSuggestions(lines, cursorLine, cursorCol, options)
  }

  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const provider = new CombinedAutocompleteProvider(this.commands(), process.cwd())
    return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }
}

class PiView {
  constructor(terminal) {
    this.terminal = terminal
    this.transcript = new Transcript()
    this.tui = new TUI(terminal)
    this.totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    this.phase = ''
    this.liveReply = undefined
    this.liveReason = undefined
    this.reasonText = ''
    this.stopped = false
    this.editor = new PromptEditor(this.tui, editorTheme, { autocompleteMaxVisible: 8 }, () => this.prefix())
    this.footer = new Footer(this)
    this.tui.addChild(this.transcript)
    this.tui.addChild(this.editor)
    this.tui.addChild(this.footer)
    this.tui.setFocus(this.editor)
  }

  prefix() {
    if (this.input?.modal?.prompt) return themeColor.yellow(this.input.modal.prompt)
    return `${themeColor.bold(themeColor.blue('›'))} `
  }

  usageLabel() {
    const total = (this.totals.inputTokens ?? 0)
      + (this.totals.outputTokens ?? 0)
      + (this.totals.cacheReadTokens ?? 0)
      + (this.totals.cacheWriteTokens ?? 0)
    return total > 0 ? formatTokens(total) : '—'
  }

  start(input) {
    this.input = input
    this.editor.onSubmit = text => input.onEditorSubmit(text)
    this.editor.onChange = () => input.onEditorChange()
    this.editor.setAutocompleteProvider(new LiveSlash(() => input.slashEntries?.() ?? []))
    this.tui.addInputListener(data => {
      if (matchesKey(data, Key.ctrl('c'))) {
        input.onCtrlC()
        return { consume: true }
      }
      // Readline's unix-line-discard cleared the whole composer draft. A
      // multi-line paste is one draft, so Ctrl+U drops every line, not just
      // the cursor's visual row (which left the rest glued to the next prompt).
      if (matchesKey(data, Key.ctrl('u'))) {
        input.replaceEditorText('')
        input.disarmExit()
        return { consume: true }
      }
      return undefined
    })
    this.tui.start()
  }

  refresh() {
    if (!this.stopped) this.tui.requestRender()
  }

  setPhase(label) {
    this.phase = label ? String(label) : ''
    this.refresh()
  }

  noteUsage(usage) {
    if (!usage || typeof usage !== 'object') return
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'uncachedInputTokens']) {
      const value = usage[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        const bucket = key === 'uncachedInputTokens' ? 'inputTokens' : key
        this.totals[bucket] = (this.totals[bucket] ?? 0) + value
      }
    }
    this.refresh()
  }

  appendPlain(text) {
    const value = String(text).replace(/\s+$/g, '')
    if (stripAnsi(value).trim() === '') return
    this.transcript.blocks.push(new Text(value, 0, 0))
    this.refresh()
  }

  appendAssistant(chunk) {
    if (!chunk) return
    if (!this.liveReply) {
      this.liveReply = new ReplyMarkdown()
      this.transcript.blocks.push(this.liveReply)
    }
    this.liveReply.append(chunk)
    this.refresh()
  }

  appendReasoning(chunk) {
    if (!chunk) return
    if (!this.liveReason) {
      this.liveReason = new Text('', 0, 0)
      const index = this.liveReply ? this.transcript.blocks.indexOf(this.liveReply) : -1
      if (index >= 0) this.transcript.blocks.splice(index, 0, this.liveReason)
      else this.transcript.blocks.push(this.liveReason)
    }
    this.reasonText += chunk
    this.liveReason.setText(themeColor.dim(this.reasonText))
    this.refresh()
  }

  sealAssistant() {
    this.liveReply = undefined
    this.liveReason = undefined
    this.reasonText = ''
  }

  clearTranscript() {
    this.transcript.blocks = []
    this.sealAssistant()
    if (!this.stopped) this.tui.requestRender(true)
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    this.tui.stop()
  }
}

class PiInput {
  constructor(view) {
    this.view = view
    this.closed = false
    this.exitArmed = false
    this.exitTimer = undefined
    this.modal = undefined
    this.composerResolve = undefined
    this.composerReject = undefined
    this.slashEntries = () => []
    this.busyProvider = undefined
    this.interruptListener = undefined
    this.exitListener = undefined
    this.ignoreChange = false
  }

  setCompleter() {}

  setSlashEntries(provider) {
    this.slashEntries = typeof provider === 'function' ? provider : () => []
  }

  onInterrupt(listener) {
    this.interruptListener = listener
  }

  onExit(listener) {
    this.exitListener = listener
  }

  onEditorChange() {
    if (!this.ignoreChange && this.exitArmed) this.disarmExit()
  }

  armExit() {
    this.exitArmed = true
    if (this.exitTimer !== undefined) clearTimeout(this.exitTimer)
    this.exitTimer = setTimeout(() => this.disarmExit(), 1500)
    this.exitTimer.unref?.()
  }

  disarmExit() {
    this.exitArmed = false
    if (this.exitTimer !== undefined) clearTimeout(this.exitTimer)
    this.exitTimer = undefined
  }

  onCtrlC() {
    if (this.closed) return
    if (this.modal) {
      const modal = this.modal
      this.modal = undefined
      this.replaceEditorText('')
      modal.reject(new InputInterrupted(modal.context ?? 'approval'))
      this.view.refresh()
      return
    }
    const busy = Boolean(this.busyProvider?.())
    if (busy) {
      this.disarmExit()
      this.replaceEditorText('')
      this.interruptListener?.('idle')
      return
    }
    if (this.exitArmed) {
      this.disarmExit()
      this.exitListener?.()
      return
    }
    this.armExit()
    this.replaceEditorText('')
    this.rejectComposer(new InputInterrupted('composer'))
  }

  replaceEditorText(text) {
    this.ignoreChange = true
    try {
      this.view.editor.setText(text)
    } finally {
      this.ignoreChange = false
    }
  }

  onEditorSubmit(text) {
    this.disarmExit()
    if (this.modal) {
      const modal = this.modal
      this.modal = undefined
      modal.resolve(text)
      this.view.refresh()
      return
    }
    if (text === '') return
    const resolve = this.composerResolve
    this.composerResolve = undefined
    this.composerReject = undefined
    resolve?.(text)
  }

  rejectComposer(error) {
    const reject = this.composerReject
    this.composerResolve = undefined
    this.composerReject = undefined
    reject?.(error)
  }

  async multiline() {
    if (this.closed) throw new InputClosed()
    return new Promise((resolve, reject) => {
      this.composerResolve = resolve
      this.composerReject = reject
    })
  }

  async question(prompt, { context = 'input', trim = false } = {}) {
    if (this.closed) throw new InputClosed()
    const value = await new Promise((resolve, reject) => {
      this.modal = { prompt: String(prompt), context, resolve, reject }
      this.view.refresh()
    })
    return trim ? String(value).trim() : value
  }

  async confirm(prompt, { defaultValue = false, context = 'confirm' } = {}) {
    const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] '
    const answer = (await this.question(`${prompt}${suffix}`, { context, trim: true })).toLowerCase()
    if (answer === '') return defaultValue
    return answer === 'y' || answer === 'yes' || answer === '是'
  }

  async choose(prompt, count, { allowZero = false, context = 'choice' } = {}) {
    while (true) {
      const answer = await this.question(prompt, { context, trim: true })
      if (allowZero && (answer === '' || answer === '0')) return undefined
      const index = Number(answer)
      if (Number.isInteger(index) && index >= 1 && index <= count) return index - 1
      this.view.renderer?.warning(`请输入 1-${count}${allowZero ? '，或 0 取消' : ''}。`)
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.disarmExit()
    this.modal?.reject(new InputClosed())
    this.modal = undefined
    this.rejectComposer(new InputClosed())
    this.view.stop()
  }
}

class PiRenderer extends Renderer {
  constructor(options) {
    super(options)
    this.view = options.view
    this.view.renderer = this
  }

  write(text) {
    const value = String(text)
    if (value.includes('\x1b]') || (value.includes('\x1b[') && stripAnsi(value).trim() === '')) {
      this.output.write(value)
      if (process.env.DSH_OSC_LOG && value.includes('\x1b]9999;')) {
        try { appendFileSync(process.env.DSH_OSC_LOG, value) } catch { /* score log is best-effort */ }
      }
      return
    }
    this.view.appendPlain(value)
  }

  line(text = '') {
    this.finishAssistantStream()
    if (text !== '') this.view.appendPlain(String(text))
  }

  assistant(text) {
    this.view.sealAssistant()
    if (text == null || text === '') return
    this.view.appendAssistant(String(text))
    this.view.sealAssistant()
  }

  assistantDelta(text) {
    if (typeof text !== 'string' || text === '') return
    this.view.appendAssistant(text)
  }

  finishAssistantStream() {
    this.view.sealAssistant()
  }

  reasoningDelta(text) {
    if (typeof text === 'string' && text !== '') this.view.appendReasoning(text)
  }

  noteUsage(usage) {
    this.view.noteUsage(usage)
  }

  resetStepPresentation() {
    this.view.sealAssistant()
  }

  activityStart(label) {
    this.view.setPhase(label)
  }

  activityUpdate(label) {
    this.view.setPhase(label)
  }

  activityStop() {
    this.view.setPhase('')
  }

  clearActivity() {}

  renderActivity() {}

  clearScreen() {
    this.view.clearTranscript()
  }

  close() {
    this.view.stop()
    super.close()
  }
}

export function createPiFrontend({ input, output, errorOutput, verbose = false, debug = false, terminal } = {}) {
  const term = terminal ?? new ProcessTerminal()
  const view = new PiView(term)
  const renderer = new PiRenderer({ output, errorOutput, verbose, debug, view })
  const piInput = new PiInput(view)
  view.start(piInput)
  return { renderer, input: piInput, view }
}
