/**
 * `koffi` stand-in so `dsh-subprocess-local` imports cleanly.
 *
 * The real package is a native FFI binding, and `dsh-subprocess-local` uses it
 * for one thing: walking the Win32 process tree to kill a subprocess and its
 * children. Every call sits behind a `process.platform === 'win32'` branch that
 * a page never takes — but two of them (`koffi.pointer`, and the lazy type
 * registration behind it) are evaluated while the module is being imported, so
 * a missing package is an import-time failure of the whole subprocess row, not
 * a call-time failure of a path nobody reaches.
 *
 * So this provides the shape rather than the capability: type constructors
 * return opaque descriptors, and anything that would actually cross into
 * native code throws. Nothing here is reachable on this platform; if it ever
 * is, the throw says why rather than returning a plausible wrong answer.
 */

/** An opaque stand-in for one of koffi's type descriptors. */
interface KoffiType {
  readonly name: string
  readonly size: number
  readonly alignment: number
}

/** Build a descriptor that carries a name and a size, and nothing else. */
function type(name: string, size = 0): KoffiType {
  return { name, size, alignment: size === 0 ? 1 : Math.min(size, 8) }
}

/** Refuse a call that would need the native binding. */
function unavailable(what: string): never {
  throw new Error(`koffi.${what}: no native FFI in a browser; this path is Windows-only and unreachable here`)
}

/** `koffi.pointer` — a pointer to some other type. */
export function pointer(target: string | KoffiType): KoffiType {
  return type(`${typeof target === 'string' ? target : target.name}*`, 8)
}

/** `koffi.array` — a fixed-length array type. */
export function array(target: string | KoffiType, length: number): KoffiType {
  const element = typeof target === 'string' ? target : target.name
  // Only the widths `dsh-subprocess-local` names; anything else is a guess.
  const widths: Record<string, number> = { char: 1, char16: 2, int: 4, uint32: 4, long: 8 }
  return type(`${element}[${String(length)}]`, (widths[element] ?? 1) * length)
}

/** `koffi.struct` — a named record type. */
export function struct(name: string, fields: Record<string, string | KoffiType>): KoffiType {
  let size = 0
  for (const field of Object.values(fields)) {
    size += typeof field === 'string' ? 8 : field.size
  }
  return type(name, size)
}

/** `koffi.load` — open a shared library. */
export function load(library: string): never {
  return unavailable(`load(${library})`)
}

/** `koffi.alloc` — allocate native memory. */
export function alloc(): never {
  return unavailable('alloc')
}

/** `koffi.decode` — read a value out of native memory. */
export function decode(): never {
  return unavailable('decode')
}

/** `koffi.encode` — write a value into native memory. */
export function encode(): never {
  return unavailable('encode')
}

export default { pointer, array, struct, load, alloc, decode, encode }
