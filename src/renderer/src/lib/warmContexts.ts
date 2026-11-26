/** The contexts whose tab pages stay mounted, most recent first. Returns `warm` itself when `root` is already first. */
export function touchWarm({ warm, root, max }: { warm: string[]; root: string; max: number }): string[] {
  if (warm[0] === root) return warm
  return [root, ...warm.filter((r) => r !== root)].slice(0, max)
}
