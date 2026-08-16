/** `node:events` — the EventEmitter face. */
import { eventsModule } from './events-impl.ts'

export const EventEmitter = eventsModule.EventEmitter
export const once = eventsModule.once
export const setMaxListeners = eventsModule.setMaxListeners
export default eventsModule
