/** A sanity check against pasting the wrong thing. Presage keys are much longer than this. */
const MIN_KEY_LENGTH = 20;

export function apiKeyProblem(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return 'The key is empty.';
  if (/\s/.test(trimmed)) return 'That does not look like a Presage API key: it contains spaces.';
  if (trimmed.length < MIN_KEY_LENGTH) return 'That does not look like a Presage API key: it is too short.';
  return null;
}
