/**
 * The `ctx` a unit test hands to an entry point whose signature declares the real
 * cordis `Context`. An entry reads two or three services off it; faking the
 * forty-odd members a live scope carries would be noise about the harness, so the
 * boundary is crossed once, here, with the reason written down.
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * @param services - what `ctx.get(name)` answers, per service name. A name that is
 *   absent, or whose value is `undefined`, reads as "this deployment does not
 *   mount it" — which is the state several entries are tested against.
 * @returns a context stand-in carrying exactly those services.
 */
export function fakeContext(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}
