const encoder = new TextEncoder()
const decoder = new TextDecoder('utf8')

const walHeaderSize = 32
const walFrameHeaderSize = 24

const walFlags = {
  SQLITE_SHM_UNLOCK: 1,
  SQLITE_SHM_LOCK: 2,
  SQLITE_SHM_SHARED: 4,
  SQLITE_SHM_EXCLUSIVE: 8,
  F_UNLCK: 2,
  F_RDLCK: 0,
  F_WRLCK: 1
}

const checkpoint = {
  SQLITE_CHECKPOINT_PASSIVE:  0,
  SQLITE_CHECKPOINT_FULL:     1,
  SQLITE_CHECKPOINT_RESTART:  2,
  SQLITE_CHECKPOINT_TRUNCATE: 3
}

const vfsFlags = {
  HTTP_FILE_NO_ACCESS:  0,
  HTTP_FILE_READONLY:   1,
  HTTP_FILE_READWRITE:  2,
  HTTP_NO_RANGE_REQUEST: 16
}

const fileFlags = {
  SQLITE_OPEN_READONLY: 0x01,
  SQLITE_OPEN_READWRITE: 0x02,
  SQLITE_OPEN_CREATE: 0x04,
  SQLITE_OPEN_MAIN_DB: 0x100,
  SQLITE_OPEN_WAL: 0x80000,
  SQLITE_OPEN_MAIN_JOURNAL: 0x800
}

const fieldTypes = {
  SQLITE_INTEGER    : 1,
  SQLITE_FLOAT      : 2,
  SQLITE_TEXT       : 3,
  SQLITE_BLOB       : 4,
  SQLITE_NULL       : 5,
  SQLITE_INT64      : 6
}

const constants = {
  SQLITE_OK          : 0, // Successful result
  SQLITE_ERROR       : 1, // Generic error
  SQLITE_INTERNAL    : 2, // Internal logic error in SQLite
  SQLITE_PERM        : 3, // Access permission denied
  SQLITE_ABORT       : 4, // Callback routine requested an abort
  SQLITE_BUSY        : 5, // The database file is locked
  SQLITE_LOCKED      : 6, // A table in the database is locked
  SQLITE_NOMEM       : 7, // A malloc() failed
  SQLITE_READONLY    : 8, // Attempt to write a readonly database
  SQLITE_INTERRUPT   : 9, // Operation terminated by sqlite3_interrupt()
  SQLITE_IOERR      : 10, // Some kind of disk I/O error occurred
  SQLITE_CORRUPT    : 11, // The database disk image is malformed
  SQLITE_NOTFOUND   : 12, // Unknown opcode in sqlite3_file_control()
  SQLITE_FULL       : 13, // Insertion failed because database is full
  SQLITE_CANTOPEN   : 14, // Unable to open the database file
  SQLITE_PROTOCOL   : 15, // Database lock protocol error
  SQLITE_EMPTY      : 16, // Internal use only
  SQLITE_SCHEMA     : 17, // The database schema changed
  SQLITE_TOOBIG     : 18, // String or BLOB exceeds size limit
  SQLITE_CONSTRAINT : 19, // Abort due to constraint violation
  SQLITE_MISMATCH   : 20, // Data type mismatch
  SQLITE_MISUSE     : 21, // Library used incorrectly
  SQLITE_NOLFS      : 22, // Uses OS features not supported on host
  SQLITE_AUTH       : 23, // Authorization denied
  SQLITE_FORMAT     : 24, // Not used
  SQLITE_RANGE      : 25, // 2nd parameter to sqlite3_bind out of range
  SQLITE_NOTADB     : 26, // File opened that is not a database file
  SQLITE_NOTICE     : 27, // Notifications from sqlite3_log()
  SQLITE_WARNING    : 28, // Warnings from sqlite3_log()
  SQLITE_ROW        : 100, // sqlite3_step() has another row ready
  SQLITE_DONE       : 101 // sqlite3_step() has finished executing
}

function calcCheck (u32, len = u32.length, off = 0, check = new Uint32Array(2)) {
  for (let i = 0; i < len; i += 2) {
    check[0] += u32[i + off] + check[1]
    check[1] += u32[i + off + 1] + check[0]
  }
  return check
}

class Bitmap {
  #cols = 8
  #shift = 3
  #rows = 0
  #buf
  #bin

  constructor (size = 512) {
    this.capacity = size
    this.#rows = (size >> this.#shift) + 1
    this.#buf = new ArrayBuffer(this.#rows)
    this.#bin = new Uint8Array(this.#buf)
  }

  test (off) {
    return (this.#bin[off >> this.#shift] & (1 << (off % this.#cols))) > 0
  }

  set (off) {
    this.#bin[off >> this.#shift] |= (1 << (off % this.#cols))
  }

  reset (off) {
    this.#bin[off >> this.#shift] &= (255 ^ (1 << (off % this.#cols)))
  }

  fill (v = 0) {
    this.#bin.fill(v)
  }

  seek (from, pages = 8) {
    for (let i = 0; i < pages; i++) {
      if (this.test(from + i)) return i
    }
    return pages
  }
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

  consolidate (frames) {
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

class WalIndex extends MemoryFile {
  constructor () {
    super()
    this.LE = true
  }

  get version () {
    return this.view.getUint32(0, this.LE)
  }

  get padding () {
    return this.view.getUint32(4, this.LE)
  }

  get counter () {
    return this.view.getUint32(8, this.LE)
  }

  get initialized () {
    return this.view.getUint8(12)
  }

  get bigEndianChecksum () {
    return this.view.getUint8(13)
  }

  get pageSize () {
    return this.view.getUint16(14, this.LE)
  }

  get mxFrame () {
    return this.view.getUint32(16, this.LE)
  }

  get nPage () {
    return this.view.getUint32(20, this.LE)
  }

  get frameCheck () {
    const { view, LE } = this
    return [view.getUint32(24, LE), view.getUint32(28, LE)]
  }

  get salt () {
    const { view, LE } = this
    return [view.getUint32(32, LE), view.getUint32(36, LE)]
  }

  get checksum () {
    const { view, LE } = this
    return [view.getUint32(40, LE), view.getUint32(44, LE)]
  }

  get backfill () {
    return this.view.getUint32(96, this.LE)
  }

  get backfillAttempt () {
    return this.view.getUint32(128, this.LE)
  }

  get locks () {
    return this.u8.subarray(120, 128)
  }

  dirty () {
    this.view.setUint32(16, 1, this.LE)
    this.view.setUint32(64, 0, this.LE)
  }
}

class Buffer {
  static writeString (ab, str, offset) {
    const len = str.length
    const u8 = new Uint8Array(ab, offset, len)
    for (let i = 0; i < len; i++) u8[i] = str.charCodeAt(i)
  }

  static byteLength (str) {
    return (new TextEncoder().encode(str)).length    
  }
}

class Pointer {
  constructor (memory, handle) {
    this.view = new Int32Array(memory.buffer)
    this.p = handle
  }

  get () {
    return this.view[this.p >> 2]
  }

  set (addr) {
    this.view[this.p >> 2] = addr
  }
}

class WASI {
  constructor(memory, env) {
    const wasi = this
    this.memory = memory
    this.view = new DataView(this.memory.buffer)
    this.WASI_ERRNO_SUCCESS = 0
    this.WASI_ERRNO_BADF = 8
    this.WASI_ERRNO_NOSYS = 52
    this.WASI_ERRNO_INVAL = 28
    this.WASI_FILETYPE_CHARACTER_DEVICE = 2
    this.WASI_RIGHTS_FD_SYNC = 1 << 4
    this.WASI_RIGHTS_FD_WRITE = 1 << 6
    this.WASI_RIGHTS_FD_FILESTAT_GET = 1 << 21
    this.WASI_FDFLAGS_APPEND = 1 << 0
    this.nameSpaces = {
      wasi_snapshot_preview1: {
        environ_get: (...args) => wasi.environ_get(env, ...args),
        environ_sizes_get: (...args) => wasi.environ_sizes_get(env, ...args),
        fd_fdstat_get: undefined,
        fd_write: this.fd_write,
        fd_close: undefined,
        proc_exit: undefined,
        fd_seek: undefined
      },
    }
    for (const ns of Object.keys(this.nameSpaces)) {
      const nameSpace = this.nameSpaces[ns]
      for (const fn of Object.keys(nameSpace)) {
        const func = nameSpace[fn] || this.nosys(fn)
        nameSpace[fn] = func.bind(this)
      }
    }
  }

  initialize(instance) {
    instance.exports._initialize()
  }

  get imports() {
    return this.nameSpaces
  }

  nosys(name) {
    return (...args) => {
      console.error(`Unimplemented call to ${name}(${args.toString()})`)
      return this.WASI_ERRNO_NOSYS
    }
  }

  environ_get(env, environ, environBuf) {
    let coffset = environ
    let offset = environBuf
    Object.entries(env).forEach(
      ([key, value]) => {
        this.view.setUint32(coffset, offset, true)
        coffset += 4
        offset += Buffer.writeString(this.memory.buffer, `${key}=${value}\0`, offset)
      }
    )
  }

  environ_sizes_get(env, environCount, environBufSize) {
    const processed = Object.entries(env).map(
      ([key, value]) => `${key}=${value}\0`
    )
    const size = processed.reduce((acc, e) => acc + Buffer.byteLength(e), 0)
    this.view.setUint32(environCount, processed.length, true)
    this.view.setUint32(environBufSize, size, true)
    return this.WASI_ERRNO_SUCCESS
  }

  fd_write(fd, iovs, iovsLen, nwritten) {
    if (fd > 2) return this.WASI_ERRNO_BADF
    const view = new DataView(this.memory.buffer)
    const memory = this.memory
    const buffers = []
    for (let i = 0; i < iovsLen; i++) {
      const iov = iovs + i * 8
      const offset = view.getUint32(iov, true)
      const len = view.getUint32(iov + 4, true)
      buffers.push(new Uint8Array(memory.buffer, offset, len))
    }
    const length = buffers.reduce((s, b) => s + b.length, 0)
    const buffer = new Uint8Array(length)
    let offset = 0
    buffers.forEach((b) => {
      buffer.set(b, offset)
      offset += b.length
    })
    const string = new TextDecoder("utf-8").decode(buffer).replace(/\n$/, "")
    if (fd === 1) console.log(string)
    else console.error(string)
    view.setUint32(nwritten, buffer.length, true)
    return this.WASI_ERRNO_SUCCESS
  }
}

function ReadCString (heap, idx) {
  let endPtr = idx
  while (heap[endPtr]) ++endPtr
  return decoder.decode(heap.subarray(idx, endPtr))    
}

class PersistentMap {
  #map

  constructor () {
    this.#map = new Map()
  }

  get (key) {
    return this.#map.get(key)
  }

  keys () {
    return Array.from(this.#map.keys())
  }

  set (key, val) {
    return this.#map.set(key, val)
  }

  has (key) {
    return this.#map.has(key)
  }
}

function createEnvironment (dbName, memory, heap, malloc, options = {}) {
  const xhr = new XMLHttpRequest()
  const maxPages = 10000
  const { cache, dbSize, pageSize, totalPages } = options

  function getName (path) {
    const name = path.slice(0, path.indexOf('.db') + 3)
    if (name === dbName) return 'main'
    return name.slice(0, -3)
  }

  function destroyDatabase (name, path) {
    const db = databases[name]
    if (db && db.closing) {
      delete db.openFiles[path]
      delete databases[name]
      return
    }
    db.closing = true
  }

  function createDatabase (name) {
    if (databases[name]) return databases[name]
    const bytes = new Uint8Array(walHeaderSize + ((walFrameHeaderSize + 4096) * maxPages))
    databases[name] = {
      regions: [],
      wal: {
        bytes,
        file: (new Wal()).open(`${name}-wal`, bytes),
        opened: false
      },
      inMemory: false,
      openFiles: {},
      stats: { recv: 0 },
      cache: new PersistentMap(),
      factor: 1n
    }
    return databases[name]
  }

  const databases = {}
  const environment = {
    wasm_http_shm_map: (i0, region, size, extend, o0) => {
      const path = ReadCString(heap, i0)
      const name = getName(path)
      if (extend === 0) {
        heap[o0] = 0
        //console.log('wasm_http_shm_map.1')
        return constants.SQLITE_OK
      }
      const env = createDatabase(name)
      if (env.regions[region]) {
        const p = new Pointer(memory, o0)
        p.set(env.regions[region].ptr)
        //console.log('wasm_http_shm_map.2')
      } else {
        const ptr = malloc(size)
        env.regions[region] = { ptr, bytes: heap.subarray(ptr, ptr + size) }
        const p = new Pointer(memory, o0)
        env.wal.index = (new WalIndex()).open(`${name}-shm`, env.regions[region].bytes)
        p.set(ptr)
        //console.log('wasm_http_shm_map.3')
      }
      return constants.SQLITE_OK
    },
    wasm_http_shm_lock: (i0, offset, n, flags) => {
      const path = ReadCString(heap, i0)
      const name = getName(path)
      const env = createDatabase(name)
      if (env.regions[0]) {
        const { bytes } = env.regions[0]
        if (flags & walFlags.SQLITE_SHM_UNLOCK) {
          bytes[120 + offset] = walFlags.F_UNLCK
        } else if (flags & walFlags.SQLITE_SHM_SHARED) {
          bytes[120 + offset] = walFlags.F_RDLCK
        } else {
          bytes[120 + offset] = walFlags.F_WRLCK
        }
      }
      //console.log('wasm_http_shm_lock.1')
      return constants.SQLITE_OK
    },
    wasm_http_shm_unmap: (i0, deleteFlag) => {
      const path = ReadCString(heap, i0)
      const name = getName(path)
      //console.log('wasm_http_shm_unmap.1')
      return constants.SQLITE_OK
    },
    wasm_crypto_get_random: (ptr, n) => {
      let view = new Int8Array(memory.buffer, ptr, n)
      crypto.getRandomValues(view)
      //console.log('wasm_crypto_get_random.1')
      return view.byteLength
    },
    wasm_get_unix_epoch: () => BigInt(Math.round(Date.now() / 1000)),
    wasm_wal_handler: (i0, i1, i2, pages) => {
      const name = ReadCString(heap, i2)
      //console.log('wasm_wal_handler.1')
      return constants.SQLITE_OK
    },
    wasm_http_close: (i0, flags) => {
      const path = ReadCString(heap, i0)
      const name = getName(path)
      destroyDatabase(name, path)
      //console.log('wasm_http_close.1')
      return constants.SQLITE_OK
    },
    wasm_http_open: (i0, flags) => {
      const path = ReadCString(heap, i0)
      const name = getName(path)
      const env = createDatabase(name)
      env.closing = false
      if ((flags & fileFlags.SQLITE_OPEN_WAL) === fileFlags.SQLITE_OPEN_WAL) {
        env.openFiles[path] = { wal: true }
        //console.log('wasm_http_open.1')
      } else if ((flags & fileFlags.SQLITE_OPEN_MAIN_DB) === fileFlags.SQLITE_OPEN_MAIN_DB) {
        env.openFiles[path] = { db: true }
        //console.log('wasm_http_open.2')
      } else if (flags & fileFlags.SQLITE_OPEN_MAIN_JOURNAL === fileFlags.SQLITE_OPEN_MAIN_JOURNAL) {
        env.openFiles[path] = { journal: true }
        //console.log('wasm_http_open.3')
      }
      return flags
    },
    wasm_http_file_stat: (i0, o0, o1) => {
      const path = ReadCString(heap, i0)
      const name = getName(path)
      const access = new Pointer(memory, o0)
      const size = new Pointer(memory, o1)
      if (path.indexOf('-journal') > -1) {
        access.set(vfsFlags.HTTP_FILE_READWRITE)
        size.set(0)
        //console.log('wasm_http_file_stat.1')
        return constants.SQLITE_OK
      }
      const env = createDatabase(name)
      if (path.indexOf('-wal') > -1 && (env.wal.opened || env.inMemory)) {
        access.set(vfsFlags.HTTP_FILE_READWRITE)
        size.set(env.wal.file.offset)
        //console.log('wasm_http_file_stat.2')
        return
      }
      if (path.indexOf('-wal') > -1) {
        env.wal.opened = true
        access.set(vfsFlags.HTTP_FILE_READWRITE)
        if (env.wal.index && env.wal.index.pageSize) {
          size.set(walHeaderSize + ((walFrameHeaderSize + env.walIndex.pageSize) * env.walIndex.mxFrame))
        } else {
          size.set(env.wal.file.offset)
        }
        //console.log('wasm_http_file_stat.3')
        return constants.SQLITE_OK
      }
// we don't have CORS header on gist.github.com to allow access to content-range header. if this is possible, then we can just read the first page of the db in full here without a separate HEAD request to get the db size
/*
      const range = `bytes=0-4095`
      xhr.open('GET', path, false)
      xhr.responseType = 'arraybuffer'
      xhr.setRequestHeader('Range', range)
      xhr.send()
      if(xhr.status !== 206) {
        env.inMemory = true
        access.set(vfsFlags.HTTP_FILE_READWRITE)
        size.set(0)
        return constants.SQLITE_OK
      }
      const u8 = new Uint8Array(xhr.response)
      const contentRange = xhr.getResponseHeader('content-range')
      const parts = contentRange.match(/\d+-\d+\/(\d+)/)
      if (parts && parts.length > 1) {
        const dbSize = parseInt(parts[1], 10)
        const pages = dbSize / 4096
        env.bitmap = new Bitmap(pages)
        env.bitmap.set(0)
        size.set(dbSize)
      }
      env.cache.set(`${name}.${range}`, u8)
      access.set(vfsFlags.HTTP_FILE_READWRITE)
      return constants.SQLITE_OK

*/
// we should not need this if we got the CORS header to allow access to content-range header
      if (dbSize) {
        //console.log(dbSize)
        size.set(dbSize)
        access.set(vfsFlags.HTTP_FILE_READWRITE)
        env.bitmap = new Bitmap(totalPages)
        if (cache && cache.byteLength) {
          const u8 = new Uint8Array(cache.slice(0, 4096))
          //env.cache.set(`${name}.bytes=0-4095`, u8)
          //env.bitmap.set(0)
        }
        return constants.SQLITE_OK
      }
      xhr.open('HEAD', path, false)
      xhr.send()
      if (xhr.status !== 200) {
        env.inMemory = true
        access.set(vfsFlags.HTTP_FILE_READWRITE)
        size.set(0)
        //console.log('wasm_http_file_stat.4')
        return constants.SQLITE_OK
      }
      const sz = parseInt(xhr.getResponseHeader('Content-Length'), 10)
      const pages = sz / 4096
      env.bitmap = new Bitmap(pages)
      size.set(sz)
      access.set(vfsFlags.HTTP_FILE_READWRITE)
      //console.log('wasm_http_file_stat.5')
      return constants.SQLITE_OK

    },
    wasm_http_get_bytes: (i0, i1, start, end) => {
      const path = ReadCString(heap, i0)
      const name = getName(path)
      let page = start / 4096n
      const env = createDatabase(name)
      if (env.openFiles[path].wal) {
        //console.log('wasm_http_get_bytes.1')
        heap.set(env.wal.bytes.subarray(Number(start), Number(end)), i1)
        return constants.SQLITE_OK
      }
      if (env.openFiles[path].journal) {
        //console.log('wasm_http_get_bytes.2')
        return constants.SQLITE_OK
      }
      const { bitmap } = env
      let origEnd = end
      if (end === 100n) end = 4096n
      const range = `bytes=${start}-${end - 1n}`
      if (env.cache.has(`${name}.${range}`)) {
        //console.log('wasm_http_get_bytes.3')
        heap.set(env.cache.get(`${name}.${range}`), i1)
        return constants.SQLITE_OK
      }
      if (env.inMemory) {
        if (start === 0n && !env.cache.has(`${name}.${range}`)) {
          //console.log('wasm_http_get_bytes.4')
        // this only happens when we start with a new blank in memory db
        // we need to create a valid first page for the db - need to understand why??
          // https://sqlite.org/fileformat2.html
          // SQLite 3 Header - 0-16 bytes
          heap.set([
            0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 
            0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00
          ], i1)
          heap[i1 + 16] = 16
          heap[i1 + 17] = 0  // pageSize 16-17 (4096)
          heap[i1 + 18] = 2  // file format write version, 2 = WAL
          heap[i1 + 19] = 2  // file format read version, 2 = WAL
          heap[i1 + 20] = 0  // reserved space
          heap[i1 + 21] = 64 // always 64
          heap[i1 + 22] = 32 // always 32
          heap[i1 + 23] = 32 // always 32
          heap[i1 + 56] = 0
          heap[i1 + 57] = 0
          heap[i1 + 58] = 0
          heap[i1 + 59] = 1  // encoding 56-58 (1 = utf-8)
          heap[i1 + 100] = 0xd // indicates page is a leaf table b-tree page
          heap[i1 + 101] = 0xf
          heap[i1 + 102] = 0x94
          heap[i1 + 105] = 0
          heap[i1 + 106] = 0x6c // start of cell content area = 108
          env.cache.set(`${name}.bytes=${start}-${4095}`, heap.slice(i1, i1 + 4095))
        } else {
          //console.log('wasm_http_get_bytes.5')
        }
        return constants.SQLITE_OK
      }
      const size = parseInt(end - start, 10)
      if (end === 4096n && cache) {
        const u8 = new Uint8Array(cache.slice(0, 4096))
        env.cache.set(`${name}.bytes=0-4095`, u8)
        if (origEnd === 100n) {
          heap.set(env.cache.get(`${name}.bytes=0-4095`).slice(0, 100), i1)
        } else {
          env.bitmap.set(0)
          heap.set(env.cache.get(`${name}.bytes=0-4095`), i1)
        }
        return constants.SQLITE_OK
      }
      if (size === 4096) {
        const pages2 = bitmap.seek(Number(page), Number(env.factor))
        let bsize = 4096n * BigInt(pages2)
        const dbSize = bitmap.capacity * 4096
        if (start + bsize > BigInt(dbSize)) bsize = BigInt(dbSize) - start
        const bend = start + bsize
        const range = `bytes=${start}-${bend - 1n}`
        xhr.open('GET', path, false)
        xhr.responseType = 'arraybuffer'
        xhr.setRequestHeader('Range', range)
        xhr.send()
        if(xhr.status !== 206) {
          if (start === 0n && !env.cache.has(`${name}.${range}`)) {
            env.cache.set(`${name}.bytes=${start}-${4095}`, heap.slice(i1, i1 + 4095))
          }
          //console.log('wasm_http_get_bytes.6')
          // todo: this is wrong
          return constants.SQLITE_OK
        }
        let cstart = parseInt(start, 10)
        let cend = parseInt(start, 10) + parseInt(xhr.getResponseHeader('content-length'), 10)
        const csize = (cend) - cstart
        const pages = csize / 4096
        const u8 = new Uint8Array(xhr.response)
        let off = 0
        for (let i = 0; i < pages; i++) {
          const p = u8.subarray(off, off + 4096)
          env.stats.recv += p.length
          const range = `bytes=${cstart + off}-${(cstart + off + 4096) - 1}`
          if (!env.cache.has(`${name}.${range}`)) {
            env.cache.set(`${name}.${range}`, p)
            bitmap.set(Number(page++))
          }
          off += 4096
          if (i === 0) {
            if (origEnd === 100n) {
              heap.set(p.slice(0, 100), i1)
            } else {
              heap.set(p, i1)
            }
          }
        }
        if (env.factor < 256n) env.factor = env.factor * 2n
        //console.log('wasm_http_get_bytes.7')
        return constants.SQLITE_OK
      }
      xhr.open('GET', path, false)
      xhr.responseType = 'arraybuffer'
      xhr.setRequestHeader('Range', range)
      xhr.send()
      if(xhr.status !== 206) {
        if (start === 0n && !env.cache.has(`${name}.${range}`)) {
          env.cache.set(`${name}.bytes=${start}-${4095}`, heap.slice(i1, i1 + 4095))
        }
        //console.log('wasm_http_get_bytes.8')
        return constants.SQLITE_OK
      }
      const u8 = new Uint8Array(xhr.response)
      env.stats.recv += u8.length
      env.cache.set(`${name}.${range}`, u8)
      heap.set(u8, i1)
      //console.log('wasm_http_get_bytes.9')
      return constants.SQLITE_OK
    },
    wasm_http_set_bytes: (i0, i1, amount, offset) => {
      const path = ReadCString(heap, i0)
      const name = getName(path)
      const env = createDatabase(name)
      if (env.openFiles[path].wal) {
        const bytes = heap.slice(i1, i1 + amount)
        env.wal.bytes.set(bytes, Number(offset))
        env.wal.file.offset = Number(offset) + bytes.length
        //console.log('wasm_http_set_bytes.1')
      } else {
        const bytes = heap.slice(i1, i1 + amount)
        const range = `bytes=${Number(offset)}-${Number(offset) + amount - 1}`
        env.cache.set(`${name}.${range}`, bytes)
        //console.log('wasm_http_set_bytes.2')
      }
      return constants.SQLITE_OK
    },
    wasm_console_log: (i0, i1) => postMessage({ errorMessage: `code=${i0} msg=${ReadCString(heap, i1)}` }),
    emscripten_notify_memory_growth: (...args) => {
      //console.log(`memory ${JSON.stringify(args)}`)
    }
  }
  return { environment, databases }
}

async function open (dbName, wasmPath = 'sqlite.wasm', options = {}) {
  class Query {
    constructor (sql, handle) {
      this.params = []
      this.types = []
      this.names = []
      this.sql = sql
      this.handle = handle
      this.stmt = null
    }

    prepare (fields = [], params = []) {
      const { sql, handle } = this
      if (fields.length) {
        this.types.length = 0
        this.names.length = 0
      }
      for (const field of fields) {
        const { name, type } = field
        this.types.push(type)
        this.names.push(name)
      }
      this.params = params
      const esp = stack.save()
      const ptr = new Pointer(memory, ex.malloc(4))
      const rc = ex.sqlite3_prepare_v2(handle, CString(sql), -1, ptr.p, 0)
      if (rc !== constants.SQLITE_OK) {
        stack.restore(esp)
        return [ReadCString(heap, ex.sqlite3_errmsg(handle))]
      }
      this.stmt = ptr.get()
      stack.restore(esp)
      return this
    }

    exec (...values) {
      const esp = stack.save()
      const { params, fields, stmt, handle } = this
      let i = 0
      for (const param of params) {
        const p = param.type ? param.type : param
        if (p === fieldTypes.SQLITE_TEXT) {
          if (ex.sqlite3_bind_text(stmt, i + 1, CString(values[i]), values[i].length) !== constants.SQLITE_OK) throw new Error(ex.sqlite3_errmsg(handle))
        } else if (p === fieldTypes.SQLITE_INTEGER) {
          if (ex.sqlite3_bind_int(stmt, i + 1, Number(values[i])) !== constants.SQLITE_OK) throw new Error(ex.sqlite3_errmsg(handle))
        } else if (p === fieldTypes.SQLITE_FLOAT) {
          if (ex.sqlite3_bind_double(stmt, i + 1, Number(values[i])) !== constants.SQLITE_OK) throw new Error(ex.sqlite3_errmsg(handle))
        } else if (p === fieldTypes.SQLITE_INT64) {
          if (ex.sqlite3_bind_int(stmt, i + 1, BigInt(values[i])) !== constants.SQLITE_OK) throw new Error(ex.sqlite3_errmsg(handle))
        } else if (p === fieldTypes.SQLITE_BLOB) {
          const addr = ex.malloc(values[i].byteLength)
          heap.set(new Uint8Array(values[i]), addr)
          if (ex.sqlite3_bind_blob(stmt, i + 1, addr, values[i].byteLength) !== constants.SQLITE_OK) throw new Error(ex.sqlite3_errmsg(handle))
        }
        i++
      }
      let ok = ex.sqlite3_step(stmt)
      const cols = ex.sqlite3_column_count(stmt)
      const rows = []
      while (ok === constants.SQLITE_ROW) {
        const row = {}
        for (let col = 0; col < cols; col++) {
          switch (ex.sqlite3_column_type(stmt, col)) {
            case fieldTypes.SQLITE_INT64:
              row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = ex.sqlite3_column_int64(stmt, col)
              break;
            case fieldTypes.SQLITE_INTEGER:
              row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = ex.sqlite3_column_int(stmt, col)
              break;
            case fieldTypes.SQLITE_FLOAT:
              row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = ex.sqlite3_column_double(stmt, col)
              break;
            case fieldTypes.SQLITE_TEXT:
              // TODO: this is wrong. we can get length of text using sqlite3_column_bytes
              row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = ReadCString(heap, ex.sqlite3_column_text(stmt, col))
              break;
            case fieldTypes.SQLITE_BLOB:
              const bytes = ex.sqlite3_column_bytes(stmt, col)
              if (bytes > 0) {
                const address = ex.sqlite3_column_blob(stmt, col)
                row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = heap.slice(address, address + bytes)
              } else {
                row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = null
              }
              break;
          }
        }
        rows.push(row)
        ok = ex.sqlite3_step(stmt)
      }
      ex.sqlite3_reset(stmt)
      stack.restore(esp)
      return rows
    }

    close () {
      const { stmt } = this
      if (!stmt) return
      ex.sqlite3_finalize(stmt)
      this.stmt = null
    }
  }

  function CString (str) {
    const len = (str.length << 2) + 1
    const ret = stack.alloc(len)
    const target = new Uint8Array(memory.buffer, ret)
    const { written } = encoder.encodeInto(str, target)
    target[written] = 0
    return ret
  }

  function openDatabase (path) {
    const esp = stack.save()
    const ptr = new Pointer(memory, stack.alloc(4))
    ex.sqlite3_open_v2(CString(path), ptr.p, fileFlags.SQLITE_OPEN_READWRITE | fileFlags.SQLITE_OPEN_CREATE, CString('http'))
    const handle = ptr.get()
    stack.restore(esp)
    return handle
  }

  function createQuery (handle, sql) {
    const query = new Query(sql, handle)
    return query
  }

  function executeSQL (handle, sql) {
    const esp = stack.save()
    const ptr = new Pointer(memory, stack.alloc(4))
    const rc = ex.sqlite3_prepare_v2(handle, CString(sql), -1, ptr.p, 0)
    if (rc !== constants.SQLITE_OK) {
      stack.restore(esp)
      return [ReadCString(heap, ex.sqlite3_errmsg(handle))]
    }
    const stmt = ptr.get()
    let ok = ex.sqlite3_step(stmt)
    const cols = ex.sqlite3_column_count(stmt)
    const rows = []
    while (ok === constants.SQLITE_ROW) {
      const row = {}
      for (let col = 0; col < cols; col++) {
        switch (ex.sqlite3_column_type(stmt, col)) {
          case fieldTypes.SQLITE_INT64:
            row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = ex.sqlite3_column_int64(stmt, col)
            break;
          case fieldTypes.SQLITE_INTEGER:
            row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = ex.sqlite3_column_int(stmt, col)
            break;
          case fieldTypes.SQLITE_FLOAT:
            row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = ex.sqlite3_column_double(stmt, col)
            break;
          case fieldTypes.SQLITE_TEXT:
            // TODO: this is wrong. we can get length of text using sqlite3_column_bytes
            row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = ReadCString(heap, ex.sqlite3_column_text(stmt, col))
            break;
          case fieldTypes.SQLITE_BLOB:
            const bytes = ex.sqlite3_column_bytes(stmt, col)
            if (bytes > 0) {
              const address = ex.sqlite3_column_blob(stmt, col)
              row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = heap.slice(address, address + bytes)
            } else {
              row[ReadCString(heap, ex.sqlite3_column_name(stmt, col))] = null
            }
            break;
        }
      }
      rows.push(row)
      ok = ex.sqlite3_step(stmt)
    }
    ex.sqlite3_finalize(stmt)
    stack.restore(esp)
    return rows
  }

  function serialize (name = 'main') {
    let esp = stack.save()
    const size = new Pointer(memory, stack.alloc(8))
    const ptr = ex.sqlite3_serialize(handle, CString(name), size.p, 0)
    if(ptr === 0) {
      const message = ReadCString(heap, ex.sqlite3_errmsg(handle))
      console.error(message)
      stack.restore(esp)
      return
    }
    const out = new ArrayBuffer(size.get())
    const buf = new Uint8Array(out)
    buf.set(new Uint8Array(memory.buffer, ptr, size.get()))
    stack.restore(esp)
    return out
  }

  function deserialize (buf, name = 'main') {
    const len = buf.byteLength
    const addr = ex.malloc(len)
    heap.set(new Uint8Array(buf), addr)
    return ex.sqlite3_deserialize(handle, CString(name), addr, BigInt(len), BigInt(len), 0)
  }

  const db = {
    exec: sql => executeSQL(handle, sql),
    query: sql => createQuery(handle, sql),
    memoryUsed: () => ex.sqlite3_memory_used(),
    info: (name = 'main') => {
      return db.exec(`
select 
  page_count as pages,
  page_size as psize,
  max_page_count as pmax,
  page_count * page_size as size,
  cache_size as cache,
  freelist_count as freelist,
  journal_size_limit as jlimit,
  journal_mode as jmode,
  locking_mode as lmode,
  data_version as dversion,
  schema_version as sversion,
  user_version as uversion,
  encoding,
  synchronous,
  threads
from 
  ${name}.pragma_page_count()
  join ${name}.pragma_page_size()
  join ${name}.pragma_cache_size()
  join ${name}.pragma_data_version()
  join ${name}.pragma_freelist_count()
  join ${name}.pragma_encoding()
  join ${name}.pragma_journal_mode()
  join ${name}.pragma_journal_size_limit()
  join ${name}.pragma_locking_mode()
  join ${name}.pragma_max_page_count()
  join ${name}.pragma_schema_version()
  join ${name}.pragma_user_version()
  join ${name}.pragma_synchronous()
  join ${name}.pragma_threads()
      `)[0]
    },
    serialize,
    deserialize,
    close: () => {
      return ex.sqlite3_close_v2(handle)
    },
    walInfo: (name = 'main') => {
      const database = db.databases[name]
      const { pageSize, checkpointSequence } = database.wal.file
      const { stats } = database
      const { counter, mxFrame, nPage, backfill, backfillAttempt } = database.wal.index
      const delta = database.wal.file.serialize(database.wal.file.consolidate(database.wal.file.readFrames(mxFrame)))
      return {
        pageSize, checkpointSequence,
        counter, mxFrame, nPage, backfill, backfillAttempt,
        stats, delta
      }
    },
    checkpoint: (name = 'main') => {
      const logSize = new Pointer(memory, stack.alloc(4))
      const framesCheckpointed = new Pointer(memory, stack.alloc(4))
      const rc = ex.sqlite3_wal_checkpoint_v2(handle, CString(name), checkpoint.SQLITE_CHECKPOINT_FULL, logSize.p, framesCheckpointed.p)
      const database = db.databases[name]
      const { checkpointSequence } = database.wal.file
      return { rc, logSize: logSize.get(), framesCheckpointed: framesCheckpointed.get(), checkpointSequence }
    },
    status: () => {
      const results = []
      for (const name of Object.keys(db.databases)) {
        const database = db.databases[name]
        const { pageSize, checkpointSequence } = database.wal.file
        const { stats } = database
        if (database.wal.index) {
          const { counter, mxFrame, nPage, backfill, backfillAttempt } = database.wal.index
          const delta = database.wal.file.serialize(database.wal.file.consolidate(database.wal.file.readFrames(mxFrame)))
          results.push({
            pageSize, checkpointSequence,
            counter, mxFrame, nPage, backfill, backfillAttempt,
            stats, delta, name
          })
        } else {
          results.push({ pageSize, checkpointSequence, stats, name })
        }
      }
      return results
    },
    pages: () => {
      const results = []
      for (const name of Object.keys(db.databases)) {
        const database = db.databases[name]
        const pages = []
        const keys = database.cache.keys()
        for (const key of keys) {
          const parts = key.match(/.+\.bytes=(\d+)-(\d+)/)
          if (parts && parts.length > 2) {
            const [ start, end ] = parts.slice(1).map(v => parseInt(v, 10))
            if (end - start + 1 === 4096) {
              pages.push(start / 4096)
            } 
          }
        }
        pages.sort((a, b) => a - b)
        results.push({ name, pages })
      }
      return results
    }
  }

function base64Encode(byteArray) {
  let binaryString = ''
  for (let i = 0; i < byteArray.byteLength; i++) {
    binaryString += String.fromCharCode(byteArray[i])
  }
  return btoa(binaryString)
}

  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 4096, shared: false })  
  const heap = new Uint8Array(memory.buffer)
  const wasi = new WASI(memory, {})
  const { environment, databases } = createEnvironment(dbName, memory, heap, (...args) => ex.malloc(...args), options)
  const imports = { env: { ...environment, memory }, ...wasi.imports}
  let instance
  if (wasmPath.constructor.name === 'String') {
    instance = (await WebAssembly.instantiateStreaming(fetch(wasmPath), imports)).instance
/*
    fetch(wasmPath).then(async res => {
      const buf = await res.arrayBuffer()
      const b64 = base64Encode(new Uint8Array(buf))
//      localStorage.setItem('wasm_b64', b64)
    })
*/
  } else {
    instance = new WebAssembly.Module(wasmPath)
  }
  wasi.initialize(instance)
  const ex = instance.exports
  const stack = {
    alloc: ex.stackAlloc,
    save: ex.stackSave,
    restore: ex.stackRestore
  }
  ex.sqlite3_initialize()
  const handle = openDatabase(dbName)
  // these should be configurable options
  // we don't need the WAL if we aren't making changes
  db.exec('PRAGMA auto_vacuum = none')
  db.exec('PRAGMA temp_store = memory')
  db.exec('PRAGMA locking_mode = normal')
  db.exec('PRAGMA journal_mode=wal')
  db.exec('PRAGMA wal_autocheckpoint=0')
  db.exec('select count(1) from sqlite_schema')
  db.exec('PRAGMA locking_mode = exclusive')
  db.databases = databases
  ex.wasm_wal_hook(handle)
  return db
}

const databases = {}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {

onmessage = async e => {
  if (e.data.sql) {
    const start = Date.now()
    const db = databases[e.data.db]
    const rows = db.exec(e.data.sql)
    postMessage({ ok: true, rows, time: Date.now() - start })
    return
  }
  if (e.data.open) {
    //console.log(e.data)
    const { cache, dbSize, pageSize, totalPages } = e.data
    const db = await open(e.data.open, e.data.wasm || 'squeel.wasm', {
      cache, dbSize, pageSize, totalPages
    })
    databases[e.data.open] = db
    postMessage({ ok: true })
    return
  }
  if (e.data.close) {
    databases[e.data.close].close(e.data.close)
    postMessage({ ok: true })
    return
  }
  if (e.data.checkpoint) {
    const db = databases[e.data.db]
    const name = e.data.name || 'main'
    if (e.data.wal) {
      const buf = e.data.wal
      const u8 = new Uint8Array(buf)
      const { wal } = db.databases[name]
      wal.file.write(u8, 0)
      wal.index.dirty()
      wal.file.offset = u8.length
    }
    const { rc, logSize, framesCheckpointed, checkpointSequence } = db.checkpoint(name)
    postMessage({ rc, logSize, framesCheckpointed, checkpointSequence, checkpoint: { wal: db.walInfo(name) } })
    return
  }
  if (e.data.serialize) {
    const db = databases[e.data.db]
    postMessage({ db: db.serialize(e.data.name) })
    return
  }
  if (e.data.deserialize) {
    const db = databases[e.data.db]
    postMessage({ db: db.deserialize(e.data.buf, e.data.name) })
    return
  }
  if (e.data.status) {
    const db = databases[e.data.db]
    postMessage(db.status())
    return
  }
  if (e.data.pages) {
    const db = databases[e.data.db]
    const pages = db.pages()
    postMessage(pages)
    return
  }
  if (e.data.memory) {
    const db = databases[e.data.db]
    postMessage(db.memoryUsed())
    return
  }
  if (e.data.close) {
    const db = databases[e.data.db]
    postMessage(db.close())
    return
  }
}


}

class RingBuffer {
  constructor () {
    this.rb = new Array(65536)
    this.head = new Uint16Array(1)
    this.tail = new Uint16Array(1)
    this.length = 0
  }

  at (index) {
    return this.rb[this.head[0] + index]
  }

  push (fn) {
    if (this.length === 65536) this.shift()
    this.rb[this.tail[0]++] = fn
    this.length++
  }

  shift () {
    this.length--
    return this.rb[this.head[0]++]
  }
}

class Database {
  workerPath = ''
  wasmPath = ''
  worker = null
  queue = new RingBuffer()
  pageCache = null

  constructor (workerPath = 'sqlite.js') {
    this.workerPath = workerPath
    this.worker = new Worker(workerPath, { type: 'module' })
    this.worker.onmessage = e => {
      if (e.data.errorMessage) {
        this.onError && this.onError(e.data.errorMessage)
        return
      }
      this.queue.shift()(e.data)
    }
    this.worker.onerror = err => {
      console.error(err.stack)
    }
    this.worker.postMessage({})
  }

  close () {
    this.worker.postMessage({ close: this.fileName })
    return new Promise(resolve => this.queue.push(resolve))
  }

  async open (fileName, prefetch = false) {
    if (prefetch) {
      const req = await fetch(fileName, { headers: new Headers([['Range', 'bytes=0-4095']]), cors: true })
      const buf = await req.arrayBuffer()
      const view = new DataView(buf)
      const u8 = new Uint8Array(buf)
      const pageSize = view.getUint16(16)
      const totalPages = view.getUint32(28)
      const dbSize = pageSize * totalPages
      const sb = new SharedArrayBuffer(dbSize)
      const sbytes = new Uint8Array(sb)
      sbytes.set(u8, 0)
      this.pageCache = sb
      this.worker.postMessage({ open: fileName, wasm: this.wasmPath, cache: this.pageCache, dbSize, pageSize, totalPages })
    } else {
      this.worker.postMessage({ open: fileName, wasm: this.wasmPath })
    }
    this.fileName = fileName
    return new Promise(resolve => this.queue.push(resolve))
  }

  exec (sql) {
    this.worker.postMessage({ sql, db: this.fileName })
    return new Promise(resolve => this.queue.push(resolve))
  }

  checkpoint (name = 'main', wal) {
    this.worker.postMessage({ checkpoint: true, db: this.fileName, name, wal })
    return new Promise(resolve => this.queue.push(resolve))
  }

  serialize (name = 'main') {
    this.worker.postMessage({ name, serialize: true, db: this.fileName })
    return new Promise(resolve => this.queue.push(resolve))
  }

  deserialize (buf, name = 'main') {
    this.worker.postMessage({ name, buf, deserialize: true, db: this.fileName })
    return new Promise(resolve => this.queue.push(resolve))
  }

  status () {
    this.worker.postMessage({ status: true, db: this.fileName })
    return new Promise(resolve => this.queue.push(resolve))
  }

  memory () {
    this.worker.postMessage({ memory: true, db: this.fileName })
    return new Promise(resolve => this.queue.push(resolve))
  }

  pages () {
    this.worker.postMessage({ pages: true, db: this.fileName })
    return new Promise(resolve => this.queue.push(resolve))
  }
}

export { Database, open, fieldTypes, constants }
