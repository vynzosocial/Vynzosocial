import { ruleScan } from "./blog-moderation.ts";

export const GUIDELINES_MESSAGE =
  "This content breaks the Vynzo Community Guidelines, so it can't be posted. Please edit it and try again.";

// Account suspension applies to every write action; the only exceptions are
// reporting content and appealing a blog decision.
export async function suspensionMessage(
  admin: any,
  userId: string,
): Promise<string | null> {
  const { data, error } = await admin.from("users")
    .select("suspended_until,suspension_reason")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.suspended_until) return null;
  const until = new Date(data.suspended_until);
  if (until <= new Date()) return null;
  const reason = data.suspension_reason ? ` Reason: ${data.suspension_reason}.` : "";
  return `Your account is suspended until ${until.toISOString().slice(0, 10)} for breaking the Vynzo rules.${reason}`;
}

// Rule-based screen for public text (captions, comments, live titles, bios).
// Only clear violations are rejected; borderline text is allowed through.
export function violatesGuidelines(...texts: Array<string | null | undefined>): boolean {
  const joined = texts.filter(Boolean).join("\n");
  if (!joined.trim()) return false;
  const { scores } = ruleScan(joined);
  return Object.values(scores).some((score) => score >= 1);
}
