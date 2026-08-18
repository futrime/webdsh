/**
 * The machine's filesystem, as an API rather than as a shell command.
 *
 * dsh's Read, Write, and Edit tools go through `node:fs/promises`, and the
 * files they name live in the container. Each call could be a command — `cat`,
 * `mkdir -p`, a redirect — but a command on an emulated CPU costs a fork, an
 * exec, and a dynamic link before it does any work, and the tools make a lot of
 * calls.
 *
 * So `container/dsh-fsd` runs once, on a channel of its own, and answers
 * requests on a pipe. This is the page's half: seven operations, one at a time,
 * with file contents travelling as bytes rather than as base64.
 *
 * Requests are serialised because the service answers in order and the channel
 * is a stream — two in flight would interleave their payloads.
 */

import type { Channel, Mux } from './mux.ts'

/** Where the service lives inside the machine. */
const SERVICE = '/usr/local/libexec/dsh-fsd'

/** What a stat reports, in the shape the fs shim builds its `Stats` from. */
export interface FileStat {
  kind: 'file' | 'dir' | 'link'
  size: number
  mode: number
  mtimeMs: number
  birthtimeMs: number
}

/** One reply: its header, and the bytes that followed it. */
interface Reply {
  header: Record<string, unknown>
  payload: Uint8Array
}

/** Give an error the shape Node's fs errors have, so callers can branch on `code`. */
function fsError(code: string, syscall: string, path: string): Error {
  const message = code === 'ENOENT'
    ? `ENOENT: no such file or directory, ${syscall} '${path}'`
    : `${code}: ${syscall} '${path}'`
  return Object.assign(new Error(message), { code, syscall, path })
}

/** Concatenate two byte runs. */
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength)
  merged.set(left, 0)
  merged.set(right, left.byteLength)
  return merged
}

/** The page's client for the machine's file service. */
export class FileService {
  private buffer: Uint8Array = new Uint8Array(0)
  private waiting: ((reply: Reply) => void)[] = []
  private pendingHeader: Record<string, unknown> | undefined
  /** The tail of the queue, so requests go out one at a time and in order. */
  private turn: Promise<unknown> = Promise.resolve()
  private failure: Error | undefined

  private constructor(private readonly channel: Channel) {}

  /**
   * Start the service and wait for it to announce itself.
   * @param mux - the machine's channels.
   * @returns the client.
   */
  static async open(mux: Mux): Promise<FileService> {
    let service: FileService | undefined
    const channel = mux.open({
      kind: 'exec',
      // `exec` so the service replaces bash rather than being its child: one
      // fewer process, and a channel whose exit means the service is gone.
      script: `exec python3 ${SERVICE}`,
    }, {
      onData: (bytes) => { service?.receive(bytes) },
      onExit: () => { service?.abandon(new Error('the machine\'s file service exited')) },
    })
    service = new FileService(channel)
    const hello = await service.next()
    if (hello.header.ready !== true) throw new Error('the machine\'s file service did not start')
    return service
  }

  /** Take bytes off the channel and turn complete replies into answers. */
  private receive(bytes: Uint8Array): void {
    this.buffer = concat(this.buffer, bytes)
    for (;;) {
      if (this.pendingHeader === undefined) {
        const end = this.buffer.indexOf(0x0a)
        if (end < 0) return
        const line = new TextDecoder().decode(this.buffer.subarray(0, end))
        this.buffer = this.buffer.subarray(end + 1)
        try {
          this.pendingHeader = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
      }
      const size = typeof this.pendingHeader.bytes === 'number' ? this.pendingHeader.bytes : 0
      if (this.buffer.byteLength < size) return
      const payload = this.buffer.slice(0, size)
      this.buffer = this.buffer.subarray(size)
      const header = this.pendingHeader
      this.pendingHeader = undefined
      this.waiting.shift()?.({ header, payload })
    }
  }

  /** Fail every request still waiting; the service is not coming back. */
  private abandon(error: Error): void {
    this.failure = error
    const waiting = this.waiting
    this.waiting = []
    for (const resolve of waiting) resolve({ header: { error: error.message, code: 'EIO' }, payload: new Uint8Array(0) })
  }

  /** The next reply the service sends. */
  private async next(): Promise<Reply> {
    return new Promise<Reply>((resolve) => { this.waiting.push(resolve) })
  }

  /**
   * Send one request and wait for its reply.
   * @param request - the operation and its arguments.
   * @param payload - bytes the operation carries.
   * @returns the reply.
   */
  private async call(request: Record<string, unknown>, payload: Uint8Array = new Uint8Array(0)): Promise<Reply> {
    const send = async (): Promise<Reply> => {
      if (this.failure !== undefined) throw this.failure
      const header = { ...request, ...(payload.byteLength > 0 ? { bytes: payload.byteLength } : {}) }
      const answer = this.next()
      this.channel.write(`${JSON.stringify(header)}\n`)
      if (payload.byteLength > 0) this.channel.write(payload)
      return answer
    }
    // Chained rather than concurrent: the service answers in order, so a second
    // request in flight would be answered against the first one's reader.
    const queued = this.turn.then(send, send)
    this.turn = queued.catch(() => undefined)
    return queued
  }

  /** Throw the reply's error, in the shape a caller expects. */
  private static check(reply: Reply, syscall: string, path: string): Reply {
    if (typeof reply.header.error !== 'string') return reply
    throw fsError(typeof reply.header.code === 'string' ? reply.header.code : 'EIO', syscall, path)
  }

  /**
   * Stat a path.
   * @param path - absolute path.
   * @param follow - whether to resolve a symbolic link.
   * @returns the stat, or undefined when nothing is there.
   */
  async stat(path: string, follow = true): Promise<FileStat | undefined> {
    const reply = await this.call({ op: 'stat', path, follow })
    if (typeof reply.header.error === 'string') return undefined
    return {
      kind: reply.header.kind as FileStat['kind'],
      size: reply.header.size as number,
      mode: reply.header.mode as number,
      mtimeMs: reply.header.mtimeMs as number,
      birthtimeMs: reply.header.birthtimeMs as number,
    }
  }

  /**
   * Read a file.
   * @param path - absolute path.
   * @returns its bytes.
   */
  async readFile(path: string): Promise<Uint8Array> {
    return FileService.check(await this.call({ op: 'read', path }), 'open', path).payload
  }

  /**
   * Write a file, creating its parent directories.
   * @param path - absolute path.
   * @param contents - what to write.
   */
  async writeFile(path: string, contents: Uint8Array): Promise<void> {
    FileService.check(await this.call({ op: 'write', path }, contents), 'open', path)
  }

  /**
   * List a directory, with each entry's kind.
   * @param path - absolute path.
   * @returns the entries.
   */
  async readdir(path: string): Promise<{ name: string, kind: FileStat['kind'] }[]> {
    const reply = FileService.check(await this.call({ op: 'readdir', path }), 'scandir', path)
    return reply.header.entries as { name: string, kind: FileStat['kind'] }[]
  }

  /**
   * Create a directory.
   * @param path - absolute path.
   * @param recursive - whether to create parents.
   */
  async mkdir(path: string, recursive: boolean): Promise<void> {
    FileService.check(await this.call({ op: 'mkdir', path, recursive }), 'mkdir', path)
  }

  /**
   * Remove a path.
   * @param path - absolute path.
   * @param options - recursive and force, as `fs.rm` takes them.
   */
  async rm(path: string, options: { recursive?: boolean, force?: boolean }): Promise<void> {
    FileService.check(
      await this.call({ op: 'rm', path, recursive: options.recursive === true, force: options.force === true }),
      'unlink',
      path,
    )
  }

  /**
   * Rename a path.
   * @param from - source.
   * @param to - destination.
   */
  async rename(from: string, to: string): Promise<void> {
    FileService.check(await this.call({ op: 'rename', from, to }), 'rename', from)
  }
}
