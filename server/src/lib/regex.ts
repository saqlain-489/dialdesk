// User text goes into $regex; unescaped, "A+B Auto" throws instead of matching nothing.
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
