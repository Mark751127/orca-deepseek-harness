import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createPiFrontend } from '../src/pi-frontend.js'
import { shouldSurfaceSendError } from '../src/cli.js'
import { InputInterrupted } from '../src/input.js'

class Capture extends Writable {
  constructor() {
    super()
    this.text = ''
    this.isTTY = true
    this.columns = 96
    this.rows = 36
  }

  _write(chunk, _encoding, callback) {
    this.text += chunk.toString()
    callback()
  }
}

class FakeTerminal {
  constructor() {
    this.buf = ''
    this.columns = 96
    this.rows = 36
    this.onInput = undefined
  }

  start(onInput) {
    this.onInput = onInput
  }

  stop() {}

  write(data) {
    this.buf += data
  }

  moveBy() {}

  hideCursor() {}

  showCursor() {}

  clearLine() {}

  clearFromCursor() {}

  clearScreen() {}
}

function strip(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 40))
}

test('agent errors already shown by the controller are not surfaced again', () => {
  const error = new Error('model route unavailable')
  error.displayed = true
  assert.equal(shouldSurfaceSendError(error), false)
  assert.equal(shouldSurfaceSendError(new Error('other')), true)
})

test('pi-tui transcript renders markdown, reasoning, diffs, footer, and OSC', async () => {
  const output = new Capture()
  const terminal = new FakeTerminal()
  const { renderer, input, view } = createPiFrontend({
    output,
    errorOutput: output,
    terminal,
    verbose: false,
    debug: false,
  })
  renderer.banner({
    sessionId: 'session-9f3c2a7e1b',
    cwd: '/workspace/project',
    model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    approvalPolicy: 'ask',
    agentPreset: 'code',
    permission: 'workspace-write',
  })
  renderer.agentStatus('working', 'inspect project')
  renderer.reasoningDelta('Inspecting ')
  renderer.reasoningDelta('width and styles.')
  renderer.assistantDelta('## Plan\n\nI checked the **width** handling.\n\n```ts\nconst visible = true\n```\n')
  renderer.noteUsage({ inputTokens: 1200, outputTokens: 180, cacheReadTokens: 800 })
  renderer.toolCall('c2', 'str_replace_editor', '{}', {
    card: 'diff',
    diffs: [{ path: 'src/renderer.js', oldText: 'const a = 1\nconst b = 2\n', newText: 'const a = 1\nconst b = 3\nconst c = 4\n' }],
  })
  await settle()
  const text = strip(view.transcript.render(96).join('\n'))
  assert.match(text, /Inspecting width/)
  assert.match(text, /const visible = true/)
  assert.doesNotMatch(text, /\*\*|```|^\s*## /m)
  assert.match(text, /^\s*[+-] const/m)
  const footer = strip(view.footer.render(96).join('\n'))
  assert.match(footer, /deepseek-v4-flash/)
  assert.match(footer, /context/)
  assert.match(output.text, /\x1b\]9999;\{"state":"working","prompt":"inspect project","agentType":"deepseek-harness"\}\x07/)
  assert.match(output.text, /\x1b\]0;DeepSeek Harness working\x07/)
  input.close()
})

test('approval takes the editor while a composer submit is still pending', async () => {
  const output = new Capture()
  const terminal = new FakeTerminal()
  const { input, view } = createPiFrontend({ output, errorOutput: output, terminal })
  let composerSettled = false
  const composer = input.multiline().then(value => {
    composerSettled = true
    return value
  })
  const confirm = input.confirm('允许这次操作吗？', { defaultValue: false, context: 'approval' })
  await settle()
  const screen = strip(view.editor.render(96).join('\n'))
  assert.match(screen, /允许这次操作吗？/)
  assert.match(screen, /\[y\/N\]/)
  terminal.onInput('y')
  terminal.onInput('\r')
  assert.equal(await confirm, true)
  await settle()
  assert.equal(composerSettled, false)
  input.busyProvider = () => true
  const contexts = []
  input.onInterrupt(context => contexts.push(context))
  terminal.onInput('\x03')
  assert.deepEqual(contexts, ['idle'])
  assert.equal(input.exitArmed, false)
  for (const ch of 'steer this') terminal.onInput(ch)
  terminal.onInput('\r')
  assert.equal(await composer, 'steer this')
  input.close()
})

test('bracketed paste stays text and idle Ctrl+C arms exit without cancelling', async () => {
  const output = new Capture()
  const terminal = new FakeTerminal()
  const { input, view } = createPiFrontend({ output, errorOutput: output, terminal })
  const composer = input.multiline().catch(error => error)
  terminal.onInput('\x1b[200~Line one of the task\nLine two of the task\nLine three\x1b[201~')
  await settle()
  const visible = strip(view.editor.render(96).join('\n'))
  assert.match(visible, /Line one of the task/)
  assert.match(visible, /Line two of the task/)
  assert.doesNotMatch(visible, /__DSH_BRACKETED_PASTE_/)
  terminal.onInput('\x03')
  const error = await composer
  assert.ok(error instanceof InputInterrupted)
  assert.equal(input.exitArmed, true)
  input.close()
})
