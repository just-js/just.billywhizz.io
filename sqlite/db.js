import init, { compressGzip, decompressGzip } from "./wasm_gzip.js"

class Database {
  #name = ''
  #username = ''
  #id = ''
  #url = ''
  #checkpointSequence = 0

  constructor (name = '', username = '', id = '') {
    this.#name = name
    this.#username = username
    this.#id = id
    this.#url = `https://gist.githubusercontent.com/${username}/${id}/raw/${name}.db`
    this.worker = new Worker('worker.js')
    this.queue = []
    this.gist = new GistClient(name, username, '', id)
    this.worker.onmessage = e => {
      if (e.data.errorMessage) {
        console.log(e.data.errorMessage)
        return
      }
      this.queue.shift()(e.data)
    }
    this.worker.onerror = err => {
      console.error(err.stack)
    }
  }

  get checkpointSequence () {
    return this.#checkpointSequence
  }

  get url () {
    return this.#url
  }

  get username () {
    return this.#username
  }

  get name () {
    return this.#name
  }

  open () {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ open: this.#url })
    return p
  }

  exec (sql) {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ sql, db: this.#url })
    return p
  }

  checkpoint (wal) {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ checkpoint: true, db: this.#url, name: this.#name, wal })
    return p
  }

  serialize () {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ name: this.#name, serialize: true, db: this.#url })
    return p
  }

  status () {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ status: true, db: this.#url })
    return p
  }

  async pull () {
    const { rows } = await this.exec('pragma user_version')
    const { user_version } = rows[0]
    const patch = await this.gist.pull(user_version + 1)
    if (patch) {
      const buf = decompressGzip(patch).buffer
      const result = await this.checkpoint('main', buf)
      const { rc, logSize, framesCheckpointed } = result
      await this.exec(`pragma user_version = ${user_version + 1}`)
      const status = await this.status()
      return status
    }
  }

  async push () {
    if (!(this.gist.token)) {
      //document.getElementById('favDialog').showModal()
      //const username = document.getElementById('txtUserName').value
      //const token = document.getElementById('txtAPIToken').value
      //if (!username || !token) return showError('Not a gist database')
      //db.gist.username = username
      //db.gist.token = token
      throw new Error('no gist token')
    }
    // can we grab the wal before checkpointing to ensure we can store it first? i think so...
    const { logSize, framesCheckpointed, checkpoint, checkpointSequence } = await this.checkpoint()
    const compressed = compressGzip(new Uint8Array(checkpoint.wal.delta))
    const { rows } = await this.exec('pragma user_version')
    const { user_version } = rows[0]
    await this.gist.push(user_version + 1, compressed)
    await this.exec(`pragma user_version = ${user_version + 1}`)
    this.#checkpointSequence = checkpointSequence
  }


}

class GistClient {
  constructor (name = '', username = '', token = '', id = '', description = '') {
    this.name = name
    this.username = username
    this.id = id
    this.token = token
    this.description = description
  }

  pull (version) {
    const fileName = `${this.name}-wal.${version}.gz.b64`
    const { username } = this
    return fetch(`https://gist.githubusercontent.com/${username}/${this.id}/raw/${fileName}`, { method: 'HEAD' })
      .then(res => {
        if (!res.ok) return
        return fetch(`https://gist.githubusercontent.com/${username}/${this.id}/raw/${fileName}`)
          .then(res => {
            if (!res.ok) throw new Error('Bad Status')
            return res.text()
          })
          .then(text => base64Decode(text))
      })
      .catch(err => {
        console.error(err.message)
      })
  }

  create (db) {
    return fetch(`https://api.github.com/gists`, {
        method: 'POST',
        body: JSON.stringify({
          description: `${this.name}: ${this.description}`, 
          files: {
            [`${this.name}`]: {
              content: base64Encode(db)
            }
          }
        }),
        headers: {
          'Authorization': `token ${token}`
        }
      })
      .then(res => {
        if (!res.ok) throw new Error('Bad Status')
        return res.json()
      })
  }

  push (version, patch) {
    const fileName = `${this.name}-wal.${version}.gz.b64`
    const { username, token } = this
    return fetch(`https://gist.githubusercontent.com/${username}/${this.id}/raw/${fileName}`, { method: 'HEAD' })
      .then(res => {
        if (res.ok) {
          throw new Error('Revision Already Exists')
          // this revision already exists - oh no!!!
          return
        }
        return fetch(`https://api.github.com/gists/${this.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              description: `pushing wal version ${version} to database ${this.name} for ${username}`, 
              files: {
                [fileName]: {
                  content: base64Encode(patch)
                }
              }
            }),
            headers: {
              'Authorization': `token ${token}`
            }
          })
          .then(res => {
            if (!res.ok) throw new Error('Bad Status')
            return res.json()
          })
      })
      .catch(err => {
        console.error(err.message)
      })
  }
}

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

export { Database, init }
