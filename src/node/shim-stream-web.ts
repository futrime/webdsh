/** `node:stream/web` — the platform's own WHATWG streams. */
export const ReadableStream = globalThis.ReadableStream
export const WritableStream = globalThis.WritableStream
export const TransformStream = globalThis.TransformStream
export const ByteLengthQueuingStrategy = globalThis.ByteLengthQueuingStrategy
export const CountQueuingStrategy = globalThis.CountQueuingStrategy
export default { ReadableStream, WritableStream, TransformStream, ByteLengthQueuingStrategy, CountQueuingStrategy }
