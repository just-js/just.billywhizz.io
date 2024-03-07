class Database {
  constructor () {
    this.worker = new Worker('sqlite.js', { type: 'module' })
    this.queue = []
    this.worker.onmessage = e => {
      if (e.data.errorMessage) {
        this.onError && this.onError(e.data.errorMessage)
        //console.error(e.data.errorMessage)
        return
      }
      this.queue.shift()(e.data)
    }
    this.worker.onerror = err => {
      console.error(err.stack)
    }
  }
  close () {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ close: this.fileName })
    return p
  }
  open (fileName, wasm = 'squeel.wasm') {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ open: fileName, wasm })
    this.fileName = fileName
    return p
  }
  exec (sql) {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ sql, db: this.fileName })
    return p
  }
  checkpoint (name = 'main', wal) {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ checkpoint: true, db: this.fileName, name, wal })
    return p
  }
  serialize (name = 'main') {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ name, serialize: true, db: this.fileName })
    return p
  }
  deserialize (buf, name = 'main') {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ name, buf, deserialize: true, db: this.fileName })
    return p
  }
  status () {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ status: true, db: this.fileName })
    return p
  }
  memory () {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ memory: true, db: this.fileName })
    return p
  }
  pages () {
    const p = new Promise(resolve => this.queue.push(resolve))
    this.worker.postMessage({ pages: true, db: this.fileName })
    return p
  }
}


class VTable {
  constructor (table, head, body, container, keys, rows) {
    this.table = table
    this.head = head
    this.body = body
    this.container = container
    this.keys = keys
    this.rows = rows
    this.direction = 'asc'
    this.settings = {
      pvalues: false,
      zscores: false,
      exclude: 1,
      titles: {},
      display: 1000
    }
  }

  show () {
    const { container } = this
    if (container.children.length) container.removeChild(container.children[0])
    container.appendChild(this.table)
    return this
  }

  hide () {
    return this
  }

  update () {
    if (this.settings.pvalues) {
      this.pvalues()
      return this
    }
    if (this.settings.zscores) {
      this.zscores()
      return this
    }
    const keyLen = this.keys.length
    const rowLen = Math.min(this.rows.length, this.settings.display)
    const rows = this.body.children
    for (let i = 0; i < rowLen; i++) {
      for (let j = 0; j < keyLen; j++) {
        rows[i].cells[j + 1].innerText = this.rows[i][this.keys[j]]
      }
    } 
    return this
  }

  highlight () {
    const rowLen = Math.min(this.rows.length, this.settings.display)
    for (let i = 0; i < rowLen; i++) {
      if (this.rows[i].highlighted) {
        rows[i].highlight()
      }
    }
  }

  pvalues (exclude = this.settings.exclude) {
    const tRows = this.body.children
    const { rows, keys } = this
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]
      if (j < exclude) continue
      if (isNumeric(rows[0][key])) {
        const zscores = stats.zScores(rows.map(row => row[key]))
        const rowLen = Math.min(rows.length, this.settings.display)
        for (let i = 0; i < rowLen; i++) {
          const zscore = zscores[i]
          const pv = Math.floor((stats.pValue(zscore) * 10000)) / 100
          tRows[i].cells[j + 1].innerHTML = gaugeHtml(pv)
          tRows[i].cells[j + 1].title = `${pv.toFixed(0)}th percentile\n${this.settings.titles[key]}`
        }
      }
    }
    return this
  }

  zscores (exclude = this.settings.exclude) {
    const tRows = this.body.children
    const { rows, keys } = this
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]
      if (j < exclude) continue
      if (isNumeric(rows[0][key])) {
        const zscores = stats.zScores(rows.map(row => row[key]))
        const rowLen = Math.min(rows.length, this.settings.display)
        for (let i = 0; i < rowLen; i++) {
          const zscore = zscores[i]
          const pvalue = Math.floor((stats.pValue(zscore) * 10000)) / 100
          let pv = 0
          if (pvalue > 50) {
            pv = (50 - (pvalue - 50)) * 2
          } else {
            pv = (pvalue * 2)
          }
          tRows[i].cells[j + 1].innerHTML = gaugeHtml(zscore, pv, 'rgba(255, 210, 142, 1)')
          tRows[i].cells[j + 1].title = `${zscore.toFixed(0)}th zscore\n${this.settings.titles[key]}`
        }
      }
    }
    return this
  }

  sort (key) {
    const keyLen = this.keys.length
    const rowLen = Math.min(this.rows.length, this.settings.display)
    const rows = this.body.children
    // todo - fix this - it's very inefficient
    for (let i = 0; i < rowLen; i++) {
      if (this.rows[i].highlighted) {
        rows[i].highlight()
        this.rows[i].highlighted = true
      }
    }
    if (this.direction === 'desc') {
      this.rows.sort((a, b) => {
        const [ av, bv ] = [a[key], b[key]]
        if (av > bv) return 1
        if (av < bv) return -1
        return 0
      })
      //this.rows.sort((a, b) => a[key] - b[key])
      this.direction = 'asc'
    } else {
      this.rows.sort((a, b) => {
        const [ av, bv ] = [a[key], b[key]]
        if (av > bv) return -1
        if (av < bv) return 1
        return 0
      })
      //this.rows.sort((a, b) => b[key] - a[key])
      this.direction = 'desc'
    }
    for (let i = 0; i < rowLen; i++) {
      for (let j = 0; j < keyLen; j++) {
        rows[i].cells[j + 1].innerText = this.rows[i][this.keys[j]]
      }
      if (this.rows[i].highlighted) {
        rows[i].highlight()
      }
    }
    return this
  }

  onRowClick (tRow, row) {
    tRow.highlight()
  }

  onHeaderClick (key) {
    this.sort(key)
    this.update()
  }
}

function gaugeHtml (value, percent = value, color = 'rgba(169, 245, 154, 1)') {
  return `<div style="min-width: 40px; color: black;">
  <div style="background-color: ${color}; text-align: left; width: ${Math.ceil(percent)}%">
  ${value.toFixed(2)}
  </div>
  </div>`
}

function showTable (keys, rows, container, settings = {}) {
  // change this so keys is optional and defaulted
  const table = document.createElement('table')
  const head = table.createTHead()
  const body = table.createTBody()
  const newRow = head.insertRow(-1)
  newRow.classList.add('header')
  const newCell = document.createElement('th')
  newCell.innerText = 'rank'
  newRow.appendChild(newCell)
  const vtable = new VTable(table, head, body, container, keys, rows)
  Object.assign(vtable.settings, settings)
  let j = 0
  for (const key of keys) {
    const newCell = document.createElement('th')
    newCell.style.cursor = 'pointer'
    newCell.innerText = key
    newRow.appendChild(newCell)
    newCell.title = settings.titles[key] || ''
    newCell.onclick = () => vtable.onHeaderClick.call(vtable, key)
  }
  let rank = 1
  let i = 0
  for (const row of rows) {
    if (i === vtable.settings.display) break
    const newRow = body.insertRow(-1)
    newRow.style.cursor = 'pointer'
    newRow.onclick = () => vtable.onRowClick.call(vtable, newRow, rows[newRow.index])
    newRow.index = i++
    row.tRow = newRow
    newRow.highlight = (color = '#f7f0f0') => {
      const row = rows[newRow.index]
      if (newRow.style.backgroundColor === 'white' || newRow.style.backgroundColor === '') {
        row.tRow = newRow
        newRow.style.backgroundColor = color
        newRow.style.opacity = 0.7
        row.highlighted = true
      } else {
        newRow.style.backgroundColor = 'white'
        newRow.style.opacity = 1
        row.highlighted = false
      }
    }
    const newCell = newRow.insertCell(-1)
    const newText = document.createTextNode(rank++)
    newCell.appendChild(newText)
    for (const key of keys) {
      const newCell = newRow.insertCell(-1)
      const newText = document.createTextNode(row[key])
      newCell.appendChild(newText)
    }
  }
  return vtable
}

function isNumeric (n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
}

function setupStats () {
  const arr = {
    max: function (array) {
      return Math.max.apply(null, array)
    },
    min: function (array) {
      return Math.min.apply(null, array)
    },
    range: function (array) {
      return arr.max(array) - arr.min(array)
    },
    midrange: function (array) {
      return arr.range(array) / 2
    },
    sum: function (array) {
      let num = 0
      for (let i = 0, l = array.length; i < l; i++) num += array[i]
      return num
    },
    mean: function (array) {
      return arr.sum(array) / array.length
    },
    median: function (array) {
      array.sort(function (a, b) {
        return a - b
      })
      const mid = array.length / 2
      return mid % 1 ? array[mid - 0.5] : (array[mid - 1] + array[mid]) / 2
    },
    modes: function (array) {
      if (!array.length) return []
      const modeMap = {}
      let maxCount = 0
      let modes = []
      array.forEach(function (val) {
        if (!modeMap[val]) {
          modeMap[val] = 1
        } else {
          modeMap[val]++
        }
        if (modeMap[val] > maxCount) {
          modes = [val]
          maxCount = modeMap[val]
        } else if (modeMap[val] === maxCount) {
          modes.push(val)
          maxCount = modeMap[val]
        }
      })
      return modes
    },
    variance: function (array) {
      const mean = arr.mean(array)
      return arr.mean(array.map(function (num) {
        return Math.pow(num - mean, 2)
      }))
    },
    standardDeviation: function (array) {
      return Math.sqrt(arr.variance(array))
    },
    meanAbsoluteDeviation: function (array) {
      const mean = arr.mean(array)
      return arr.mean(array.map(function (num) {
        return Math.abs(num - mean)
      }))
    },
    zScores: function (array) {
      const mean = arr.mean(array)
      const standardDeviation = arr.standardDeviation(array)
      return array.map(function (num) {
        return (num - mean) / standardDeviation
      })
    }
  }

  function swap (data, i, j) {
    if (i === j) {
      return
    }
    const tmp = data[j]
    data[j] = data[i]
    data[i] = tmp
  }

  function partition (data, start, end) {
    let i
    let j
    for (i = start + 1, j = start; i < end; i++) {
      if (data[i] < data[start]) {
        swap(data, i, ++j)
      }
    }
    swap(data, start, j)
    return j
  }

  function findK (data, s, e, k) {
    let start = s
    let end = e
    while (start < end) {
      const pos = partition(data, start, end)
      if (pos === k) {
        return data[k]
      }
      if (pos > k) {
        end = pos
      } else {
        start = pos + 1
      }
    }
    return null
  }

  const percentile = (data, n) => {
    return findK(data.concat(), 0, data.length, Math.ceil((data.length * n) / 100) - 1)
  }


  function pValue (zscore) {
    if ( zscore < -6.5) return 0.0
    if( zscore > 6.5) return 1.0
    var factK = 1
    var sum = 0
    var term = 1
    var k = 0
    var loopStop = Math.exp(-23)
    while(Math.abs(term) > loopStop)  {
      term = .3989422804 * Math.pow(-1,k) * Math.pow(zscore,k) / (2 * k + 1) / Math.pow(2, k) * Math.pow(zscore, k+1) / factK
      sum += term
      k++
      factK *= k
    }
    sum += 0.5
    return sum
  }  

  arr.average = arr.mean
  arr.percentile = percentile
  arr.pValue = pValue
  return arr
}

const stats = setupStats()

export { Database, showTable, stats }
