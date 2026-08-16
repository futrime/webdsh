/**
 * The page-level control surface `src/api.ts` publishes, as the test scripts
 * consume it. Declaring it once keeps every `page.evaluate` body free of
 * hand-written casts.
 */
declare global {
  // eslint-disable-next-line vars-on-top, no-var
  var dsh: {
    shell(script: string, options?: { cwd?: string }): Promise<{ status: number, stdout: string, stderr: string }>
    flush(): Promise<void>
    readFile(path: string): string
    writeFile(path: string, contents: string): void
    reset(): Promise<void>
    promptOnce(apiKey: string, text: string): Promise<string>
    plugins: {
      install(spec: string): Promise<{ name: string, version: string, hasClient: boolean, patch?: string }>
      list(): { name: string, version: string, enabled: boolean, hasClient: boolean }[]
    }
    ctx: { loader?: { entries(): Iterable<Record<string, unknown>> } }
  }
}

export {}
