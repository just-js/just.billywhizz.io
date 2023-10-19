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
    console.log(username)
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

export { GistClient }
