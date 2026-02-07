import { LogDatabase, Database, showTable } from './squeel.js'

function base64Encode(byteArray) {
  let binaryString = ''
  for (let i = 0; i < byteArray.byteLength; i++) {
    binaryString += String.fromCharCode(byteArray[i])
  }
  return btoa(binaryString)
}

function base64Decode(base64) {
  const binary_string = window.atob(base64)
  const len = binary_string.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
      bytes[i] = binary_string.charCodeAt(i)
  }
  return bytes
}

function fileName (path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

async function onKeyDown (event) {
  if (event.key === 'g' && event.ctrlKey) {
    event.preventDefault()
    executeSQLMulti().catch(errorHandler)
    return
  }
  if (event.key === 'e' && event.ctrlKey) {
    event.preventDefault()
    executeSQL().catch(errorHandler)
    return
  }
  if (event.key === 'm' && event.ctrlKey) {
    event.preventDefault()
    toggleQueryDisplay()
    return
  }
  if (event.key === 's' && event.ctrlKey) {
    event.preventDefault()
    saveQuery()
    return
  }
  if (event.key === 'l' && event.ctrlKey) {
    event.preventDefault()
    window.table.settings.pvalues = window.settings.pvalues = true
    window.table.settings.zscores = window.settings.zscores = false
    window.table.update()
    return
  }
  if (event.key === 'k' && event.ctrlKey) {
    event.preventDefault()
    window.table.settings.pvalues = window.settings.pvalues = false
    window.table.settings.zscores = window.settings.zscores = true
    window.table.update()
    return
  }
  if (event.key === 'r' && event.ctrlKey) {
    event.preventDefault()
    window.table.settings.pvalues = window.settings.pvalues = false
    window.table.settings.zscores = window.settings.zscores = false
    window.table.update()
    return
  }
  if (event.key === 'o' && event.ctrlKey) {
    event.preventDefault()
    getFile().catch(errorHandler)
    return
  }
  if (event.key === 'd' && event.ctrlKey) {
    event.preventDefault()
    const result = await db.serialize()
    const b64 = base64Encode(new Uint8Array(result.db))
    const version = (await db.exec('pragma user_version')).rows[0].user_version
    localStorage.setItem('plstatzversion', version)
//    localStorage.setItem('plstatzdb', b64)
    const link = document.createElement('a')
    const blob = new Blob([result.db], { type: 'application.octet-stream' } )
    const objectURL = URL.createObjectURL(blob)
    link.href = objectURL
    link.href = URL.createObjectURL(blob)
    link.download = fileName(db.fileName)
    link.click()
    return
  }
}

function toggleQueryDisplay () {
  if (!window.editor) showEditor()
  if (sql.style.display === 'block') {
    sql.style.display = 'none'
    results.style.left = '0px'
  } else {
    sql.style.display = 'block'
    results.style.left = '600px'
    window.editor.focus()
  }
}

function saveQuery () {
  localStorage.setItem('query', editor.getValue())
}

function handleCommand (command) {
  const parts = command.split(' ')
  if (parts[0] === 'pvalues') {
    window.settings.pvalues = (parseInt(parts[1], 10) === 1)
    return
  }
  if (parts[0] === 'zscores') {
    window.settings.zscores = (parseInt(parts[1], 10) === 1)
    return
  }
  if (parts[0] === 'freeze') {
    window.settings.freeze = parseInt(parts[1], 10)
    return
  }
  if (parts[0] === 'display') {
    window.settings.display = parseInt(parts[1], 10)
    return
  }
}

async function executeSQLMulti (text) {
  if (!text) {
    text = window.editor.getSelectedText() || window.editor.getValue()
  }
  const { db } = window
  const queries = text.split(';').map(sql => sql.trim()).filter(v => v)
  let showResults = false
  for (const sql of queries) {
    const comments = sql.split('\n').filter(line => line.match(/--.+/))
    for (const comment of comments) {
      handleCommand(comment.replace('-- ', ''))
    }
    const { rows, time } = await db.exec(sql)
    if (!rows.length) continue
    showResults = true
    if (rows[0].constructor.name === 'String') {
      throw new Error(rows[0])
    }
    const keys = Object.keys(rows[0])
    window.table = showTable(keys, rows, results, window.settings)
    window.table.settings.zscores = window.settings.zscores || false
    window.table.settings.pvalues = window.settings.pvalues || false
    window.table.settings.exclude = window.settings.freeze || 1
    window.table.settings.display = window.settings.display || 10000

    window.table.show()
    window.table.update()
  }
  return showResults
}

async function executeSQL () {
  const { db, editor } = window
  const text = editor.getSelectedText() || editor.getValue()
  const lines = text.split('\n')
  const selection = editor.getSelectionRange()
  const firstLine = selection.start.row
  let first = firstLine
  let last = first
  while (first > 0) {
    if (lines[first - 1].match(/(.+)?;/)) break
    first--
  }
  while (last < lines.length) {
    if (lines[last].match(/(.+)?;/)) break
    last++
  }
  if (last - first === 0) last++
  const sql = lines.slice(first, last).join('\n')
  let showResults = false
  const comments = sql.split('\n').filter(line => line.match(/--.+/))
  for (const comment of comments) {
    handleCommand(comment.replace('-- ', ''))
  }
  const { rows, time } = await db.exec(sql)
  if (rows.length) {
    showResults = true
    if (rows[0].constructor.name === 'String') {
      throw new Error(rows[0])
    }
    const keys = Object.keys(rows[0])
    window.table = showTable(keys, rows, results, window.settings)
    window.table.settings.zscores = window.settings.zscores || false
    window.table.settings.pvalues = window.settings.pvalues || false
    window.table.settings.exclude = window.settings.freeze || 1
    window.table.settings.display = window.settings.display || 10000

    window.table.show()
    window.table.update()
  }
  return showResults
}

async function replayLogs () {
  if (!localStorage.getItem('counter')) return
  const current = parseInt(localStorage.getItem('counter') || '0', 10)
  const { checkpointSequence, logSize, framesCheckpointed, checkpoint } = await db.checkpoint()
  const { counter, mxFrame, delta } = checkpoint.wal
  if (current >= checkpointSequence) {
    for (let i = checkpointSequence; i <= current; i++) {
      const { delta } = await window.log_db.load(`wal.${i}`)
      const { checkpointSequence, logSize, framesCheckpointed, checkpoint } = await db.checkpoint('main', delta)
    }
  }
}

function showEditor () {
  const editor = ace.edit('sql')
  document.getElementById('sql').children[0].id = 'editor'
  editor.setTheme('ace/theme/monokai')
  editor.session.setMode('ace/mode/sql')
  editor.setValue(window.query)
  editor.setOptions({
    fontFamily: 'monospace',
    fontSize: '8pt',
    tabSize: 2,
    useSoftTabs: true
  })
  window.editor = editor
  delete editor.commands.commandKeyBinding['ctrl-e']
  delete editor.commands.commandKeyBinding['ctrl-q']
  delete editor.commands.commandKeyBinding['ctrl-s']
  delete editor.commands.commandKeyBinding['ctrl-k']
  delete editor.commands.commandKeyBinding['ctrl-p']
  delete editor.commands.commandKeyBinding['ctrl-o']
  delete editor.commands.commandKeyBinding['ctrl-r']
  delete editor.commands.commandKeyBinding['ctrl-g']
  delete editor.commands.commandKeyBinding['ctrl-d']
  delete editor.commands.commandKeyBinding['ctrl-l']
  delete editor.commands.commandKeyBinding['ctrl-f']
  editor.selection.clearSelection();
}

async function main () {
  const loadTime = Math.ceil(performance.now())
  window.settings = { zscores: false, pvalues: false, freeze: 1, titles: {} }
  const query = localStorage.getItem('query') || `-- freeze 8
-- pvalues 1

select * from summary where mins >= 1000
;
`
  window.query = query
  let dbName
  const log_db = new LogDatabase()
  window.log_db = log_db
  window.log_db_opened = log_db.open()
  const db = new Database()
  window.db = db
  db.onError = errorHandler
  const url = new URL(window.location.href)
  if (url.hash) {
    dbName = url.hash.slice(1)
    db.open(dbName, { wasm: 'sqlite.wasm', prefetch: true })
      .then(replayLogs)
      .then(() => {
        if (query) {
          executeSQLMulti(query)
            .catch(errorHandler)
        }
      })
  } else {
    db.open('summary.db', { wasm: 'sqlite.wasm', prefetch: true })
      .then(() => {
        const b64 = localStorage.getItem('plstatzdb')
        if (b64) {
          return db.deserialize(base64Decode(b64).buffer)
        }
      })
      .then(() => {
        if (query) {
          executeSQLMulti(query)
            .then(() => {
              statusTime.innerText = `${loadTime} / ${Math.ceil(performance.now())}`
            })
            .catch(errorHandler)
        }
      })
  }
  document.body.addEventListener('keydown', onKeyDown)
}

async function getFile() {
  [fileHandle] = await window.showOpenFilePicker()
  if (fileHandle.kind === 'file') {
    const file = await fileHandle.getFile()
    await db.deserialize(await file.arrayBuffer())
  }
}

function errorHandler (err) {
  console.log(err)
}

function calcCheck (u32, len = u32.length, off = 0, check = new Uint32Array(2)) {
  for (let i = 0; i < len; i += 2) {
    check[0] += u32[i + off] + check[1]
    check[1] += u32[i + off + 1] + check[0]
  }
  return check
}

class MemoryFile {
  constructor () {
    this.size = 0
    this.mode = 0
    this.fileName = ''
  }

  open (fileName, u8) {
    this.fileName = fileName
    this.size = u8.byteLength
    this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    this.u8 = u8
    return this
  }

  read (len = this.size, off = 0) {
    return this.u8.subarray(off, off + len)
  }

  write (u8, off = 0) {
    return this.u8.set(u8, off)
  }
}

class Frame {
  constructor (view, offset, pageSize) {
    this.view = view
    this.offset = offset
    this.pageSize = pageSize
    this.pageOffset = offset + walFrameHeaderSize
  }

  get page () {
    return this.view.getUint32(this.offset)
  }

  get totalPages () {
    return this.view.getUint32(this.offset + 4)
  }

  get salt () {
    const { view, offset } = this
    return [view.getUint32(offset + 8), view.getUint32(offset + 12)]
  }

  get checksum () {
    const { view, offset } = this
    return [view.getUint32(offset + 16), view.getUint32(offset + 20)]
  }

  get pageData () {
    return this.view.buffer.slice(this.pageOffset, this.pageOffset + this.pageSize)
  }
}

class Wal extends MemoryFile {
  constructor () {
    super()
    this.offset = 0
  }

  get magic () {
    return this.view.getUint32(0)
  }

  get formatVersion () {
    return this.view.getUint32(4)
  }

  get pageSize () {
    return this.view.getUint32(8)
  }

  get checkpointSequence () {
    return this.view.getUint32(12)
  }

  get salt () {
    const { view } = this
    return [view.getUint32(16), view.getUint32(20)]
  }

  get checksum () {
    const { view } = this
    return new Uint32Array([view.getUint32(24), view.getUint32(28)])
  }

  readFrames (end, start = 0) {
    const { view, pageSize } = this
    let offset = walHeaderSize
    const frames = []
    for (let i = start; i < end; i++) {
      const frame = new Frame(view, offset, pageSize)
      offset += (pageSize + walFrameHeaderSize)
      frames.push(frame)
    }
    return frames
  }

  readAllFrames () {
    const { view, pageSize } = this
    let offset = walHeaderSize
    const frames = []
    const end = Math.floor(this.u8.length / (pageSize + walFrameHeaderSize))
    for (let i = 0; i < end; i++) {
      const frame = new Frame(view, offset, pageSize)
      offset += (pageSize + walFrameHeaderSize)
      frames.push(frame)
    }
    return frames
  }

  static consolidate (frames) {
    const memo = new Map()
    const log = []
    for (const frame of frames) {
      const { page } = frame
      if (!memo.has(page)) memo.set(page, log.length)
      log[memo.get(page)] = frame
    }
    return log
  }

  serialize (frames) {
    const size = walHeaderSize + ((walFrameHeaderSize + this.pageSize) * frames.length)
    const buf = new ArrayBuffer(size)
    const u32 = new Uint32Array(buf)
    const view = new DataView(buf)
    const u8 = new Uint8Array(buf)
    u8.set(this.u8.slice(0, walHeaderSize), 0)
    let offset = walHeaderSize
    const { checksum } = this
    for (const frame of frames) {
      u8.set(this.u8.slice(frame.pageOffset - walFrameHeaderSize, frame.pageOffset + this.pageSize), offset)
      const intOffset = Math.floor(offset / 4)
      calcCheck(u32, 2, intOffset, checksum)
      calcCheck(u32, Math.floor(this.pageSize / 4), intOffset + Math.floor(walFrameHeaderSize / 4), checksum)
      view.setUint32(offset + 16, checksum[0])
      view.setUint32(offset + 20, checksum[1])
      offset += this.pageSize + walFrameHeaderSize
    }
    return buf
  }
}

async function consolidate_wals () {
  const num_logs = parseInt(localStorage.getItem('counter') || '0', 10) + 1
  const logs = (await Promise.all((new Array(num_logs)).fill(1).map((_, i) => log_db.load(`wal.${i}`))))
  const wals = []
  let first = true
  for (const log of logs) {
    const { delta } = log
    const u8 = new Uint8Array(delta)
    const wal = new Wal()
    wal.open('temp', u8)
    if (first) {
      header = wal.u8.slice(0, 32)
      first = false
    }
    wals.push(wal)
  }
  const all_frames = wals.map(wal => wal.readAllFrames())
  const consolidated = new Map()
  for (const frames of all_frames) {
    for (const frame of frames) {
      consolidated.set(frame.page, frame)
    }
  }
  const final = Wal.consolidate(consolidated.values())
  for (const f of final) {
  }
}

let fileHandle;
const walHeaderSize = 32
const walFrameHeaderSize = 24
window.base64Decode = base64Decode
window.base64Encode = base64Encode
window.consolidate_wals = consolidate_wals
window.showTable = showTable
window.onload = () => main().catch(errorHandler)

/*
we could cache the query by creating a new database and inserting the data into a table and caching it
*/