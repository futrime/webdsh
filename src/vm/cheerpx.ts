/**
 * The Linux virtual machine the terminal and the agent both run in.
 *
 * Everything before this was an emulation of a POSIX system written in
 * TypeScript. This is not: CheerpX is an x86 virtualization engine compiled to
 * WebAssembly, and what runs inside it is a real Debian root filesystem
 * executing real binaries. `bash` is bash, `node` is node, `gcc` compiles.
 *
 * Three consequences shape the code below:
 *
 * - CheerpX needs `SharedArrayBuffer`, so the page must be cross-origin
 *   isolated. A static host cannot send those headers, so `public/sw.js` adds
 *   them and the first load reloads once through the worker.
 * - The engine is 32-bit x86 only, so the image is i386. This is also why the
 *   image cannot be `devcontainers/universal`, which is amd64 and far past the
 *   2 GB ext2 ceiling.
 * - The disk is read lazily over HTTP range requests, so booting does not wait
 *   for a 2 GB download; only the blocks actually read are fetched.
 */

/** The CheerpX build this app is written against. */
const CHEERPX_VERSION = '1.2.8'

/** Where the engine is served from. */
const CHEERPX_URL = `https://cxrtnc.leaningtech.com/${CHEERPX_VERSION}/cx.esm.js`

/** The shape of the CheerpX module, as much of it as this host uses. */
interface CheerpXModule {
  Linux: {
    create(options: { mounts: { type: string, path: string, dev?: unknown }[] }): Promise<CheerpXLinux>
  }
  CloudDevice: { create(url: string): Promise<unknown> }
  HttpBytesDevice: { create(url: string): Promise<unknown> }
  IDBDevice: { create(name: string): Promise<unknown> }
  OverlayDevice: { create(base: unknown, overlay: unknown): Promise<unknown> }
  WebDevice: { create(path: string): Promise<unknown> }
  DataDevice: { create(): Promise<unknown> }
}

/** A running Linux instance. */
export interface CheerpXLinux {
  run(
    executable: string,
    args: string[],
    options: { env?: string[], cwd?: string, uid?: number, gid?: number },
  ): Promise<{ status: number }>
  setCustomConsole(
    write: (buffer: Uint8Array, vt: number) => void,
    columns: number,
    rows: number,
  ): (keyCode: number) => void
  setConsole(element: HTMLElement): void
}

/** How the VM's disk is sourced. */
export interface VmDisk {
  /** `http` streams an ext2 file by range request; `cloud` uses a CheerpX disk server. */
  kind: 'http' | 'cloud'
  url: string
}

/** What a booted VM exposes. */
export interface Vm {
  linux: CheerpXLinux
  /** How the disk was obtained, for diagnostics. */
  disk: VmDisk
}

/** Whether this page can host the VM at all. */
export function vmSupported(): { ok: boolean, reason?: string } {
  if (typeof SharedArrayBuffer === 'undefined') {
    return { ok: false, reason: 'SharedArrayBuffer is unavailable — the page is not cross-origin isolated' }
  }
  if (!globalThis.crossOriginIsolated) {
    return { ok: false, reason: 'the page is not cross-origin isolated' }
  }
  if (typeof WebAssembly === 'undefined') return { ok: false, reason: 'WebAssembly is unavailable' }
  return { ok: true }
}

let engine: Promise<CheerpXModule> | undefined

/** Load the CheerpX engine, once. */
async function loadEngine(): Promise<CheerpXModule> {
  engine ??= import(/* @vite-ignore */ CHEERPX_URL) as Promise<CheerpXModule>
  return engine
}

let booting: Promise<Vm> | undefined

/**
 * Boot the VM.
 *
 * The root filesystem is mounted through an overlay: the image itself is
 * read-only and streamed, and every write lands in IndexedDB. That is what
 * makes the machine durable across reloads without needing to store 2 GB.
 * @param disk - where the root image lives.
 * @param onProgress - called with human-readable boot steps.
 * @returns the running VM.
 */
export async function bootVm(disk: VmDisk, onProgress?: (step: string) => void): Promise<Vm> {
  booting ??= (async (): Promise<Vm> => {
    const support = vmSupported()
    if (!support.ok) throw new Error(`the VM cannot start: ${support.reason ?? 'unsupported'}`)

    onProgress?.('Loading the virtualization engine')
    const CheerpX = await loadEngine()

    onProgress?.('Attaching the disk')
    const base = disk.kind === 'cloud'
      ? await CheerpX.CloudDevice.create(disk.url)
      : await CheerpX.HttpBytesDevice.create(disk.url)
    const writes = await CheerpX.IDBDevice.create('dsh-vm-overlay')
    const root = await CheerpX.OverlayDevice.create(base, writes)

    onProgress?.('Starting Linux')
    const linux = await CheerpX.Linux.create({
      mounts: [
        { type: 'ext2', path: '/', dev: root },
        { type: 'devs', path: '/dev' },
        { type: 'proc', path: '/proc' },
      ],
    })
    return { linux, disk }
  })()
  return booting
}

/** Whether a VM has already been booted in this page. */
export function vmStarted(): boolean {
  return booting !== undefined
}

/** The environment every process in the VM starts with. */
export const VM_ENV = [
  'HOME=/home/dsh',
  'USER=dsh',
  'LOGNAME=dsh',
  'SHELL=/bin/bash',
  'TERM=xterm-256color',
  'LANG=C.UTF-8',
  'PAGER=cat',
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/busybox-links',
]

/** Where a session starts inside the VM. */
export const VM_WORKSPACE = '/home/dsh/workspace'
