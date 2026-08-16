/** `node:v8` — structured clone stands in for the serializer pair. */
export const serialize = <T>(value: T): T => structuredClone(value)
export const deserialize = <T>(value: T): T => structuredClone(value)
export const getHeapStatistics = (): Record<string, number> => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0 })
export const setFlagsFromString = (): void => {}
export default { serialize, deserialize, getHeapStatistics, setFlagsFromString }
