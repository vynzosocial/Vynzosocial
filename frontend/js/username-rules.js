// Usernames: 2–30 characters (emoji count as one), made of letters, numbers, emoji and . _ -
const ALLOWED = /^[\p{L}\p{N}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f._-]+$/u;
const HAS_CONTENT = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

export const USERNAME_MESSAGE = 'Username must be 2–30 characters and use only letters, numbers, emoji, periods, underscores, and hyphens.';

export function isValidUsername(value) {
  const name = String(value || '').normalize('NFC');
  const length = [...name].length;
  return length >= 2 && length <= 30 && ALLOWED.test(name) && HAS_CONTENT.test(name);
}
