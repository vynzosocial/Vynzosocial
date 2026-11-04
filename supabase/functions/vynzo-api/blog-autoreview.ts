import { extractImagePaths } from "./blog-sanitize.ts";
import { moderateContent, publicReasons } from "./blog-moderation.ts";

const MAX_WAIT_MS = 30000, TICK_MS = 15000, RECHECK_MS = 10 * 60 * 1000;
let running = false;
function check(r: any): any {
  if (r.error) throw r.error;
  return r.data;
}
async function record(admin: any, article: any, mode: "waiting" | "published") {
  const images = [
    ...new Set([
      ...(article.cover_url ? [article.cover_url] : []),
      ...extractImagePaths(article.content_html || ""),
    ]),
  ];
  const result = await moderateContent({
    title: article.title,
    text: article.content_text,
    images,
    hasEmbeds: article.has_embeds,
  });
  const flagged = result.categories.filter((x) => x.score >= 0.5).map((x) =>
    x.name
  );
  const violation = result.decision === "reject" || flagged.length > 0;
  if (violation) {
    const status = mode === "waiting" ? "rejected" : "removed";
    const reason =
      `Your article was removed automatically because it appears to violate the Vynzo content policy${
        flagged.length ? ` (${flagged.join(", ")})` : ""
      }. You can edit it or appeal this decision.`;
    check(
      await admin.from("blog_articles").update({
        status,
        rejection_reason: reason,
        updated_at: new Date().toISOString(),
      }).eq("id", article.id),
    );
    check(
      await admin.from("blog_moderation_logs").insert({
        article_id: article.id,
        subject_user_id: article.author_id,
        action: mode === "waiting"
          ? "auto_rejected_timed"
          : "auto_removed_recheck",
        reason: flagged.join(", ") || null,
      }),
    );
    const u = check(
      await admin.from("users").select("blog_strikes").eq(
        "id",
        article.author_id,
      ).maybeSingle(),
    );
    const strikes = (u?.blog_strikes || 0) + 1,
      days = strikes >= 8 ? 3650 : strikes >= 5 ? 30 : strikes >= 3 ? 7 : 0;
    check(
      await admin.from("users").update({
        blog_strikes: strikes,
        ...(days
          ? {
            blog_banned_until: new Date(Date.now() + days * 86400000)
              .toISOString(),
          }
          : {}),
      }).eq("id", article.author_id),
    );
    check(
      await admin.from("blog_moderation_logs").insert({
        article_id: article.id,
        subject_user_id: article.author_id,
        action: "strike",
        reason: mode === "waiting"
          ? "auto_rejected_timed"
          : "auto_removed_recheck",
        details: { strikes, ban_days: days },
      }),
    );
  } else if (mode === "waiting") {
    const moderation = publicReasons(result);
    check(
      await admin.from("blog_articles").update({
        status: "published",
        rejection_reason: null,
        published_at: article.published_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        moderation,
      }).eq("id", article.id),
    );
    check(
      await admin.from("blog_moderation_logs").insert({
        article_id: article.id,
        subject_user_id: article.author_id,
        action: "auto_approve_timed",
        details: moderation,
      }),
    );
  } else {check(
      await admin.from("blog_articles").update({
        moderation: publicReasons(result),
      }).eq("id", article.id),
    );}
}
async function tick(admin: any) {
  if (running) return;
  running = true;
  try {
    const cutoff = new Date(Date.now() - MAX_WAIT_MS).toISOString();
    const waiting = check(
      await admin.from("blog_articles").select(
        "id,author_id,title,content_text,content_html,cover_url,has_embeds,published_at",
      ).in("status", ["pending", "in_review"]).lt("updated_at", cutoff).order(
        "updated_at",
      ).limit(10),
    );
    const open = check(
      await admin.from("blog_reports").select("target_id").eq(
        "target_type",
        "article",
      ).eq("status", "open"),
    );
    const reported = new Set(open.map((r: any) => r.target_id));
    for (const a of waiting) {
      if (!reported.has(a.id)) {
        try {
          await record(admin, a, "waiting");
        } catch (error) {
          console.error("Blog autoreview failed", error);
        }
      }
    }
    const published = check(
      await admin.from("blog_articles").select(
        "id,author_id,title,content_text,content_html,cover_url,has_embeds,published_at,created_at,moderation",
      ).eq("status", "published").order("published_at").limit(50),
    );
    for (
      const a of published.filter((x: any) =>
        new Date(x.moderation?.checked_at || x.published_at || x.created_at)
          .getTime() < Date.now() - RECHECK_MS
      ).slice(0, 10)
    ) {
      try {
        await record(admin, a, "published");
      } catch (error) {
        console.error("Blog published recheck failed", error);
      }
    }
  } catch (error) {
    console.error("Blog autoreview tick failed", error);
  } finally {
    running = false;
  }
}
export function startBlogAutoReview(admin: any) {
  const run = () => void tick(admin);
  setInterval(run, TICK_MS);
  run();
}
