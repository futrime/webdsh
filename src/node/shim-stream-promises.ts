/** `node:stream/promises`. */
import { streamModule } from './streams.ts'

export const pipeline = streamModule.promises.pipeline
export const finished = streamModule.promises.finished
export default streamModule.promises
