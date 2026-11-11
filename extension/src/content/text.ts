const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** Whether index `at` falls between the two halves of one surrogate pair. */
const insidePair = (value: string, at: number) => at > 0 && at < value.length && high(value.charCodeAt(at - 1)) && low(value.charCodeAt(at));

/** The one place output is cut to a length. A range that never leaves half a surrogate pair: a
 * start inside a pair moves back to include it, an end inside a pair moves back to exclude it.
 * A non-empty range always yields at least one whole character, so paging advances. */
export function safeRange(value: string, start: number, end: number): { start: number; end: number } {
  let from = Math.max(0, Math.min(Math.floor(start), value.length)), to = Math.max(from, Math.min(Math.floor(end), value.length));
  if (insidePair(value, from)) from--;
  if (insidePair(value, to)) to--;
  if (to <= from && end > start && from < value.length) to = from + (insidePair(value, from + 1) ? 2 : 1);
  return { start: from, end: to };
}
export function safeSlice(value: string, start: number, end: number = value.length): string {
  const range = safeRange(value, start, end);
  return value.slice(range.start, range.end);
}
/** The first `max` UTF-16 units of a value, shortened by one when that would split a character. */
export const clipText = (value: string, max: number): string => value.length <= max ? value : safeSlice(value, 0, max);
