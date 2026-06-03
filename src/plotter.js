/*
 * SPDX-FileCopyrightText: 2024 Volodymyr Shymanskyy
 * SPDX-License-Identifier: MIT
 *
 * The software is provided "as is", without any warranties or guarantees (explicit or implied).
 * This includes no assurances about being fit for any specific purpose.
 */

/*
 * Live data plotter, inspired by Thonny's plotter.
 *
 * It listens to the same text stream that is printed to the Terminal,
 * extracts numeric values from each complete line and draws them as
 * real-time scrolling line charts. A line is treated as plottable data
 * only if every whitespace/comma/semicolon-separated token is either a
 * bare number or a "label=value" / "label:value" pair. This keeps prompts,
 * tracebacks and regular text out of the plot.
 */

// Strip ANSI/VT100 escape sequences (colors, cursor moves, etc.)
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

// One data field: a number, optionally preceded by a "label=" / "label:" prefix.
// Sticky-matched left-to-right so that "x: 1.5  y: -2.5" works just as well as
// "temp=23.5 hum=40" or a plain "1.0 2.0 3.0". Fields are separated by
// whitespace, commas or semicolons; anything that isn't a clean field rejects
// the whole line (keeps prompts, tracebacks and prose out of the plot).
const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?'
const LABEL = '[A-Za-z_][\\w ]*?'
const FIELD_REGEX = new RegExp(`(?:(${LABEL})\\s*[:=]\\s*)?(${NUMBER})`, 'y')
const SEP_REGEX = /[\s,;]+/y

const PALETTE = [
    '#5DA5D5', // blue
    '#5BCC5B', // green
    '#CCCC5B', // yellow
    '#E572FF', // magenta
    '#FF7272', // red
    '#72F0FF', // cyan
    '#FFA94D', // orange
    '#B0B0B0', // gray
]

export class Plotter {
    constructor(canvas) {
        this.canvas = canvas
        this.ctx = canvas.getContext('2d')
        this.maxPoints = 1000          // sliding window length
        this.series = []               // [{ label, color, data: [numbers] }]
        this.paused = false
        this.lineBuffer = ''
        this.dirty = false
        this.dpr = window.devicePixelRatio || 1

        this._resize()
        this._frame = this._frame.bind(this)
        requestAnimationFrame(this._frame)
    }

    /* Feed raw text from the device stream. */
    feed(text) {
        if (typeof text !== 'string') {
            try { text = new TextDecoder().decode(text) } catch { return }
        }
        this.lineBuffer += text.replace(ANSI_REGEX, '')

        // Split on CR and/or LF, keep the trailing partial line in the buffer
        const parts = this.lineBuffer.split(/\r\n|\r|\n/)
        this.lineBuffer = parts.pop()
        for (const line of parts) {
            this._processLine(line)
        }
    }

    _processLine(line) {
        line = line.trim()
        if (!line) return

        const values = []
        const labels = []
        let pos = 0
        // Skip any leading separators
        SEP_REGEX.lastIndex = pos
        if (SEP_REGEX.test(line)) { pos = SEP_REGEX.lastIndex }

        while (pos < line.length) {
            FIELD_REGEX.lastIndex = pos
            const m = FIELD_REGEX.exec(line)
            if (!m || m.index !== pos) return    // junk -> not a data line, ignore it
            labels.push(m[1] ? m[1].trim() : null)
            values.push(parseFloat(m[2]))
            pos = FIELD_REGEX.lastIndex

            SEP_REGEX.lastIndex = pos
            if (SEP_REGEX.test(line) && SEP_REGEX.lastIndex > pos) {
                pos = SEP_REGEX.lastIndex
            } else if (pos < line.length) {
                return                           // unexpected junk between fields
            }
        }
        if (!values.length) return
        if (this.paused) return

        for (let i = 0; i < values.length; i++) {
            let s = this.series[i]
            if (!s) {
                s = this.series[i] = {
                    label: labels[i] || `ch${i}`,
                    color: PALETTE[i % PALETTE.length],
                    data: [],
                }
            } else if (labels[i] && s.label !== labels[i]) {
                s.label = labels[i]
            }
            s.data.push(values[i])
            if (s.data.length > this.maxPoints) {
                s.data.splice(0, s.data.length - this.maxPoints)
            }
        }
        this.dirty = true
    }

    clear() {
        this.series = []
        this.lineBuffer = ''
        this.dirty = true
    }

    setPaused(paused) {
        this.paused = paused
    }

    _resize() {
        const rect = this.canvas.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        this.dpr = window.devicePixelRatio || 1
        const w = Math.round(rect.width * this.dpr)
        const h = Math.round(rect.height * this.dpr)
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w
            this.canvas.height = h
            this.dirty = true
        }
    }

    _frame() {
        this._resize()
        if (this.dirty) {
            this.dirty = false
            this._draw()
        }
        requestAnimationFrame(this._frame)
    }

    _draw() {
        const ctx = this.ctx
        const W = this.canvas.width
        const H = this.canvas.height
        const dpr = this.dpr

        const css = getComputedStyle(document.documentElement)
        const bg = css.getPropertyValue('--bg-color-edit').trim() || '#1e1e1e'

        ctx.fillStyle = bg
        ctx.fillRect(0, 0, W, H)

        const padL = 48 * dpr, padR = 8 * dpr, padT = 8 * dpr, padB = 18 * dpr
        const plotW = W - padL - padR
        const plotH = H - padT - padB
        if (plotW <= 0 || plotH <= 0) return

        // Determine Y range over visible data
        let min = Infinity, max = -Infinity, maxLen = 0
        for (const s of this.series) {
            if (s.data.length > maxLen) maxLen = s.data.length
            for (const v of s.data) {
                if (v < min) min = v
                if (v > max) max = v
            }
        }
        if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1 }
        if (min === max) { min -= 1; max += 1 }
        const pad = (max - min) * 0.1
        min -= pad; max += pad
        const range = max - min

        const xPoints = Math.max(maxLen, 2)
        const xOf = (i) => padL + (xPoints === 1 ? 0 : (i / (xPoints - 1)) * plotW)
        const yOf = (v) => padT + plotH - ((v - min) / range) * plotH

        // Grid + Y axis labels
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.lineWidth = 1 * dpr
        ctx.font = `${11 * dpr}px monospace`
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'right'
        const gridLines = 5
        for (let g = 0; g <= gridLines; g++) {
            const v = min + (range * g) / gridLines
            const y = yOf(v)
            ctx.beginPath()
            ctx.moveTo(padL, y)
            ctx.lineTo(W - padR, y)
            ctx.stroke()
            ctx.fillText(formatNum(v), padL - 4 * dpr, y)
        }

        // Series lines
        ctx.lineWidth = 1.5 * dpr
        for (const s of this.series) {
            if (s.data.length < 2) continue
            const offset = maxLen - s.data.length   // right-align shorter series
            ctx.strokeStyle = s.color
            ctx.beginPath()
            for (let i = 0; i < s.data.length; i++) {
                const x = xOf(offset + i)
                const y = yOf(s.data[i])
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
            }
            ctx.stroke()
        }

        // Legend
        ctx.textBaseline = 'top'
        ctx.textAlign = 'left'
        let lx = padL + 6 * dpr
        const ly = padT + 4 * dpr
        for (const s of this.series) {
            const text = s.data.length
                ? `${s.label}: ${formatNum(s.data[s.data.length - 1])}`
                : s.label
            ctx.fillStyle = s.color
            const tw = ctx.measureText(text).width
            ctx.fillRect(lx, ly + 2 * dpr, 8 * dpr, 8 * dpr)
            ctx.fillText(text, lx + 12 * dpr, ly)
            lx += 12 * dpr + tw + 16 * dpr
        }
    }
}

function formatNum(v) {
    if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)) {
        return v.toExponential(1)
    }
    return (Math.round(v * 100) / 100).toString()
}
