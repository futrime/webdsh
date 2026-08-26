/**
 * The emulated machine's HTTP bridge, tested without an emulator.
 *
 * `src/net/machine-network.ts` puts a small HTTP server in front of the guest's
 * TCP: it reassembles a request out of ethernet-sized pieces, decides what may
 * be fetched, and writes the answer back. Almost none of that is reachable from
 * a browser test. The guests this build ships drive it through `wget`, which
 * only ever sends well-formed requests — so the paths that matter most here are
 * the ones no guest program will produce on purpose: a request with no `Host`
 * header, a head with stray bytes after it, a `Content-Length` nobody should
 * honour, a TLS handshake arriving on a port that is not 443. Buildroot's
 * `telnet` cannot even be scripted to send them, measured: it will not relay a
 * piped request without a terminal.
 *
 * So the connection is faked instead of the network. `attachMachineNetwork`
 * takes an emulator-shaped object and registers a `tcp-connection` listener on
 * it; this file hands that listener an object with the four methods v86's
 * `TCPConnection` exposes, feeds it bytes, and reads back what the guest would
 * have seen. Everything under test is the shipped code, reached through its own
 * public surface.
 *
 * Usage: `npx tsx scripts/machine-network-test.ts`
 */

import { attachMachineNetwork, setMachineNetworkConfig, type NetworkedEmulator } from '../src/net/machine-network.ts'

/** Fail with a focused assertion message. */
function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** One TCP connection, as v86 hands it over and as this test drives it. */
interface FakeConnection {
  sport: number
  dport: number
  accept(): void
  on(event: 'data', handler: (data: Uint8Array | ArrayBuffer) => void): void
  write(data: Uint8Array): void
  close(): void
  /** Everything written back, decoded. */
  said(): string
  /** Whether the bridge took the connection at all. */
  accepted: boolean
  /** Whether it has been closed. */
  closed: boolean
  /** Push bytes at the bridge, as the guest would. */
  send(text: string | Uint8Array): void
}

/** The listener the module registered, captured once. */
let listener: ((conn: FakeConnection) => void) | undefined

/**
 * Build a connection aimed at one port.
 * @param sport - the port the guest connected to.
 * @returns the connection, already offered to the bridge.
 */
function connect(sport: number): FakeConnection {
  const written: Uint8Array[] = []
  let handler: ((data: Uint8Array | ArrayBuffer) => void) | undefined
  const conn: FakeConnection = {
    sport,
    dport: 40_000 + sport,
    accepted: false,
    closed: false,
    accept() { this.accepted = true },
    on(_event, next) { handler = next },
    write(data) {
      // The real one throws nothing on a closed connection, but writing to one
      // is the bug this catches, so it is recorded rather than ignored.
      if (this.closed) throw new Error('the bridge wrote to a closed connection')
      written.push(new Uint8Array(data))
    },
    close() { this.closed = true },
    said() {
      const total = written.reduce((sum, part) => sum + part.length, 0)
      const joined = new Uint8Array(total)
      let at = 0
      for (const part of written) {
        joined.set(part, at)
        at += part.length
      }
      return new TextDecoder().decode(joined)
    },
    send(text) {
      expect(handler !== undefined, 'the bridge never asked for data')
      handler(typeof text === 'string' ? new TextEncoder().encode(text) : text)
    },
  }
  expect(listener !== undefined, 'no tcp-connection listener was registered')
  listener(conn)
  return conn
}

/** Let queued microtasks and the fetch that follows them settle. */
async function settle(milliseconds = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function main(): Promise<void> {
  // The emulator this module expects, reduced to the two members it touches.
  // `network_adapter` is left absent: the polling that would wrap its `fetch`
  // gives up on its own, and the port-80 path it belongs to is v86's, not this
  // file's.
  // The in-page bridge, explicitly. A relay is the shipped default and it takes
  // this code out of the picture entirely — the guest's TCP goes to a WebSocket
  // instead — so a test of the bridge has to say which of the two it means.
  setMachineNetworkConfig({ enabled: true, relay: '' })

  const emulator: NetworkedEmulator = {
    add_listener(event, fn) {
      if (event === 'tcp-connection') listener = fn as unknown as (conn: FakeConnection) => void
    },
  }
  attachMachineNetwork(emulator)
  expect(listener !== undefined, 'attachMachineNetwork registered no listener')

  console.log('▶ a TLS handshake on a stray port is refused, not swallowed')
  {
    const conn = connect(8443)
    // The first bytes of a ClientHello: a record header, not a request line.
    conn.send(new Uint8Array([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc, 0x03, 0x03, 0x00, 0x11, 0x22, 0x33, 0x44]))
    expect(conn.closed, 'a TLS client was left waiting for a reply that cannot come')
    expect(conn.said() === '', 'the bridge answered a TLS handshake with HTTP')
  }

  console.log('▶ a request with no Host header is refused rather than invented')
  {
    const conn = connect(8080)
    conn.send('GET /index.html HTTP/1.0\r\n\r\n')
    await settle()
    const said = conn.said()
    // The bug this guards: `http://` + '' + '/index.html' parses as the host
    // `index.html`, so the request would have been sent to a hostname made out
    // of its own path.
    expect(said.startsWith('HTTP/1.1 400 '), `a Host-less request was answered ${JSON.stringify(said.slice(0, 40))}`)
    expect(said.includes('Host header'), 'the 400 does not say what was missing')
    expect(conn.closed, 'the connection was left open after a 400')
  }

  console.log('▶ an absolute-URI request keeps its own authority')
  {
    const conn = connect(3128)
    conn.send('GET http://example.invalid/thing HTTP/1.1\r\nHost: proxy.invalid\r\n\r\n')
    await settle(120)
    // It fails — nothing resolves `example.invalid` — but what matters is that
    // it was attempted rather than refused, and that the answer is readable.
    const said = conn.said()
    expect(said.startsWith('HTTP/1.1 502 '), `an absolute-URI request was answered ${JSON.stringify(said.slice(0, 40))}`)
  }

  console.log('▶ the page hosting the machine is refused with a reason')
  {
    // There is no `location` in Node, and the rule is about the page's own
    // origin, so the page is stated rather than imagined.
    // Shaped like a local run — `http://127.0.0.1:4173` — because that is the
    // case the bridge actually sees: on a deployed HTTPS page the guest's
    // port-80 request goes through v86's own handler instead, and reaches the
    // same check from there.
    ;(globalThis as { location?: unknown }).location = { origin: 'http://127.0.0.1:4173', host: '127.0.0.1:4173' }
    // The scheme is deliberately not part of the rule: this request goes out as
    // `http://`, and the retry ladder would otherwise reach the same server as
    // `https://` on the next rung.
    const conn = connect(4173)
    conn.send('GET /api/ HTTP/1.1\r\nHost: 127.0.0.1:4173\r\n\r\n')
    await settle(120)
    const said = conn.said()
    expect(said.startsWith('HTTP/1.1 502 '), `the page's own origin was answered ${JSON.stringify(said.slice(0, 40))}`)
    expect(said.includes('is the page hosting this machine'),
      `the refusal does not explain itself: ${JSON.stringify(said.slice(-200))}`)
  }

  console.log('▶ the computer\'s own network is left reachable')
  {
    // The opposite rule, and the reason it is worth a test: an earlier version
    // of this refused loopback and the LAN too, which took away the
    // `<port>.external` mapping v86 documents. Port 1 answers nothing, so what
    // is being checked is that the attempt was *made* — a policy refusal names
    // itself, a connection failure does not.
    const conn = connect(8080)
    conn.send('GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n')
    await settle(200)
    const said = conn.said()
    expect(said.startsWith('HTTP/1.1 502 '), `loopback was answered ${JSON.stringify(said.slice(0, 40))}`)
    expect(!said.includes('is the page hosting this machine') && !said.includes('not on the internet'),
      `loopback was refused by policy rather than attempted: ${JSON.stringify(said.slice(-200))}`)
  }

  console.log('▶ a body larger than the bridge will hold is refused before it arrives')
  {
    const conn = connect(8080)
    conn.send(`POST /upload HTTP/1.1\r\nHost: example.invalid\r\nContent-Length: ${String(64 * 1024 * 1024)}\r\n\r\n`)
    await settle()
    const said = conn.said()
    expect(said.startsWith('HTTP/1.1 413 '), `an oversized upload was answered ${JSON.stringify(said.slice(0, 40))}`)
  }

  console.log('▶ a head larger than the cap is refused')
  {
    const conn = connect(8080)
    conn.send(`GET / HTTP/1.1\r\nHost: example.invalid\r\nX-Pad: ${'a'.repeat(70 * 1024)}`)
    await settle()
    expect(conn.said().startsWith('HTTP/1.1 431 '), 'an oversized head was not refused')
  }

  console.log('▶ a request split across segments is reassembled')
  {
    const conn = connect(8080)
    conn.send('GET /split HTTP/1.1\r\nHo')
    expect(conn.said() === '', 'the bridge answered half a request')
    conn.send('st: example.invalid\r\n\r\n')
    await settle(120)
    expect(conn.said().startsWith('HTTP/1.1 502 '), 'a request split mid-header was not reassembled')
  }

  console.log('▶ stray bytes after a GET do not become a body')
  {
    const conn = connect(8080)
    // A GET with a trailing CRLF. Handing those two bytes to `fetch` as a body
    // makes it throw, which turned a request that would have worked into a 502
    // about the wrong thing.
    conn.send('GET / HTTP/1.1\r\nHost: example.invalid\r\n\r\n\r\n')
    await settle(120)
    const said = conn.said()
    expect(said.startsWith('HTTP/1.1 502 '), `the request was answered ${JSON.stringify(said.slice(0, 40))}`)
    expect(!said.includes('Request with GET/HEAD method cannot have body'),
      `the trailing CRLF was sent as a body: ${JSON.stringify(said.slice(-160))}`)
  }

  console.log('\n✓ the machine\'s HTTP bridge parses, refuses and answers as documented')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
