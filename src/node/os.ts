/**
 * `node:os` — the browser host presents itself as a single-user Linux box, so
 * dsh's home-paths, tmpdir, and platform branches all take their POSIX arm.
 */

import { env } from './process.ts'

export const EOL = '\n'

/** The synthetic home directory the VFS seeds. */
export const homedir = (): string => env.HOME ?? '/home'
export const tmpdir = (): string => env.TMPDIR ?? '/tmp'
export const platform = (): NodeJS.Platform => 'linux'
export const type = (): string => 'Linux'
export const arch = (): string => 'wasm32'
export const release = (): string => '6.0.0-dsh-web'
export const version = (): string => '#1 SMP DeepSeek Harness (browser)'
export const hostname = (): string => (typeof location === 'undefined' ? 'localhost' : location.hostname || 'localhost')
export const userInfo = (): { username: string, uid: number, gid: number, shell: string, homedir: string } => ({
  username: env.USER ?? 'dsh',
  uid: 1000,
  gid: 1000,
  shell: env.SHELL ?? '/bin/sh',
  homedir: homedir(),
})

/** Report the browser's logical core count so worker pools size sensibly. */
export const cpus = (): { model: string, speed: number, times: Record<string, number> }[] => {
  const count = availableParallelism()
  return Array.from({ length: count }, () => ({
    model: 'DeepSeek Harness Web CPU',
    speed: 2400,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }))
}

export const availableParallelism = (): number => {
  const reported = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency
  return typeof reported === 'number' && reported > 0 ? reported : 4
}

/** `deviceMemory` is a coarse hint in GiB; fall back to 4 GiB when absent. */
export const totalmem = (): number => {
  const gigabytes = (navigator as { deviceMemory?: number } | undefined)?.deviceMemory ?? 4
  return gigabytes * 1024 * 1024 * 1024
}
export const freemem = (): number => totalmem() / 2
export const uptime = (): number => performance.now() / 1000
export const loadavg = (): number[] => [0, 0, 0]
export const endianness = (): 'LE' | 'BE' => 'LE'
export const machine = (): string => 'wasm32'
export const devNull = '/dev/null'

/**
 * A single loopback interface. dsh's web bundle samples this to derive LAN
 * authorities for its trust fence; reporting only loopback keeps that list empty.
 */
export const networkInterfaces = (): Record<string, { address: string, netmask: string, family: string, mac: string, internal: boolean, cidr: string }[]> => ({
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
})

export const constants = {
  signals: { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1, SIGUSR1: 10, SIGUSR2: 12 },
  errno: {},
  priority: { PRIORITY_NORMAL: 0 },
}

export const setPriority = (): void => {}
export const getPriority = (): number => 0

export default {
  EOL, homedir, tmpdir, platform, type, arch, release, version, hostname, userInfo,
  cpus, availableParallelism, totalmem, freemem, uptime, loadavg, endianness, machine,
  devNull, networkInterfaces, constants, setPriority, getPriority,
}
