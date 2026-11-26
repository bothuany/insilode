// The Agents page: a session list and one xterm. Each session's bytes are kept here so switching replays them;
// the daemon keeps the authoritative ring buffer and replays it on every attach.
const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const log = msg => invoke('log', { msg: String(msg) })
window.addEventListener('error', e => log(`error: ${e.message}`))
console.error = (...a) => log(`console.error: ${a.join(' ')}`)

const MAX = 1 << 20
const term = new Terminal({ cols: 100, rows: 30, fontSize: 13, theme: { background: '#16181d' } })
term.open(document.getElementById('term'))
const bufs = new Map()
let sessions = []
let selected = null
let cfg = {}

const send = obj => invoke('send', { line: JSON.stringify(obj) })
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

function select(id) {
  selected = id
  term.reset()
  for (const chunk of bufs.get(id) ?? []) term.write(chunk)
  render()
  term.focus()
}

function render() {
  const ul = document.getElementById('sessions')
  ul.replaceChildren(...sessions.map(s => {
    const li = document.createElement('li')
    li.textContent = `${s.kind} ${s.id}  pid ${s.pid}${s.alive ? '' : ' (exited)'}`
    li.className = `${s.id === selected ? 'sel' : ''} ${s.alive ? '' : 'dead'}`
    li.onclick = () => select(s.id)
    return li
  }))
}

listen('daemon', e => {
  const m = JSON.parse(e.payload)
  if (m.ev === 'sessions') {
    const known = new Set(sessions.map(s => s.id))
    sessions = m.sessions
    const fresh = sessions.filter(s => !known.has(s.id))
    // A session the user just created takes the focus; on attach the last one does.
    if (fresh.length) select(fresh[fresh.length - 1].id)
    else render()
  } else if (m.ev === 'out') {
    const bytes = b64(m.data)
    const list = bufs.get(m.id) ?? []
    list.push(bytes)
    let total = list.reduce((n, c) => n + c.length, 0)
    while (total > MAX && list.length > 1) total -= list.shift().length
    bufs.set(m.id, list)
    if (m.id === selected) term.write(bytes)
  } else if (m.ev === 'ide') {
    const el = document.getElementById('ide')
    el.textContent = m.ide?.connected ? `IDE connected (pid ${m.ide.windows.map(w => w.pid).join(', ')})` : 'IDE not running'
    el.className = `ide ${m.ide?.connected ? 'on' : 'off'}`
    log(`ide: ${el.textContent}`)
  } else if (m.ev === 'gone') {
    log('daemon connection closed')
  }
}).then(async () => {
  cfg = await invoke('config')
  await invoke('attach')
  await invoke('ready')
})

term.onData(data => selected && send({ op: 'input', id: selected, data }))

const spawn = kind => send({ op: 'spawn', kind, cwd: cfg.cwd ?? undefined })
document.getElementById('new-shell').onclick = () => spawn('shell')
document.getElementById('new-agent').onclick = () => spawn('agent')
document.getElementById('open-ide').onclick = async () => {
  const s = sessions.find(s => s.id === selected)
  if (!s) return
  try { log(`open in IDE: ${await invoke('open_in_ide', { cwd: s.cwd })}`) } catch (err) { log(`open in IDE failed: ${err}`) }
}
// Stub: the IDE would get a `flow.showFlow` request over its bridge (README).
document.getElementById('show-flow').onclick = () => log('show in flow: stub')

// Closing asks first while anything runs; yes closes this window only, the daemon keeps the sessions.
const modal = document.getElementById('modal')
listen('close-requested', () => {
  const running = sessions.filter(s => s.alive).length
  if (!running) return invoke('really_close', { running })
  document.getElementById('modal-text').textContent = `${running} agent${running === 1 ? '' : 's'} running, close?`
  modal.hidden = false
  document.getElementById('modal-yes').focus()
  log(`confirm shown: ${running}`)
  // The probe's auto-yes still shows the dialog first, so its screenshot and log prove the dialog is there.
  if (cfg.autoconfirm) setTimeout(() => document.getElementById('modal-yes').click(), 2500)
})
document.getElementById('modal-yes').onclick = () => invoke('really_close', { running: sessions.filter(s => s.alive).length })
document.getElementById('modal-no').onclick = () => { modal.hidden = true; term.focus() }
