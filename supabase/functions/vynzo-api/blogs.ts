import {
  cleanHtml,
  extractHashtags,
  extractImagePaths,
  htmlToText,
  toEmbedUrl,
} from "./blog-sanitize.ts";
import {
  aiEnabled,
  moderateComment,
  moderateContent,
  moderationMode,
  publicReasons,
} from "./blog-moderation.ts";

const CATEGORIES = [
  "general",
  "technology",
  "lifestyle",
  "travel",
  "food",
  "health",
  "education",
  "business",
  "entertainment",
  "sports",
  "art",
  "opinion",
  "news",
  "family",
];
const REPORT_REASONS = [
  "sexual",
  "child_safety",
  "religious_hate",
  "self_harm",
  "hate_harassment",
  "extremism",
  "illegal",
  "violence",
  "misinformation",
  "copyright",
  "spam_scam",
  "other",
];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HTML = 200000,
  MAX_SUBMISSIONS = 10,
  MAX_VIDEO = 50 * 1024 * 1024,
  MAX_IMAGE = 15 * 1024 * 1024;
const lastUploads = new Map<
  string,
  { url: string; type: string; at: number }
>();
const rateLimits = new Map<string, { count: number; resetAt: number }>();
function allowRate(userId: string, key: string, max: number, windowMs: number) {
  const now = Date.now(), id = `${userId}:${key}`, current = rateLimits.get(id);
  if (!current || current.resetAt <= now) {
    rateLimits.set(id, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= max) return false;
  current.count++;
  return true;
}
const result = (
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string>,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
const uuid = (s: string) => UUID.test(s);
const clamp = (
  v: string | null,
  min: number,
  max: number,
  fallback: number,
) => {
  const n = Number.parseInt(v || "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const fail = (msg: string, status = 400) => ({ status, body: { error: msg } });
function check(r: any): any {
  if (r.error) throw r.error;
  return r.data;
}
async function parseBody(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
function setParams(input: any) {
  const title = String(input.title || "").replace(/\s+/g, " ").trim().slice(
    0,
    200,
  );
  const content_html = cleanHtml(
    String(input.content_html || "").slice(0, MAX_HTML * 2),
  );
  const content_text = htmlToText(content_html);
  const raw = Array.isArray(input.tags)
    ? input.tags
    : String(input.tags || "").split(/[\s,]+/);
  const tags = new Set<string>(
    raw.map((t: any) =>
      String(t).replace(/^#/, "").toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "")
        .slice(0, 30)
    ).filter((t: string) => t.length >= 2),
  );
  extractHashtags(content_text).forEach((t) => tags.add(t));
  const cover = String(input.cover_url || "");
  const cover_url =
    /^(?:\/uploads\/[A-Za-z0-9._-]+|https:\/\/qyfphwrmwvnwsklfsbbo\.supabase\.co\/storage\/v1\/object\/public\/uploads\/blogs\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+)$/i
        .test(cover)
      ? cover
      : null;
  const letters = content_text.match(/\p{L}/gu) || [],
    arabic = (content_text.match(/[\u0600-\u06FF]/g) || []).length;
  return {
    title,
    content_html,
    content_text,
    excerpt: content_text.slice(0, 220),
    category: CATEGORIES.includes(input.category) ? input.category : "general",
    tags: [...tags].slice(0, 10),
    cover_url,
    language: arabic / (letters.length || 1) > .3 ? "ar" : "en",
    has_embeds: /<(iframe|video)\b/i.test(content_html),
  };
}
async function contentHash(s: string) {
  const bytes = new TextEncoder().encode(
    s.toLowerCase().replace(/\s+/g, " ").trim(),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
async function log(admin: any, fields: any) {
  check(
    await admin.from("blog_moderation_logs").insert({
      article_id: fields.articleId || null,
      comment_id: fields.commentId || null,
      subject_user_id: fields.subjectUserId || null,
      actor_id: fields.actorId || null,
      action: fields.action,
      reason: fields.reason || null,
      details: fields.details || {},
    }),
  );
}
async function userState(admin: any, id: string) {
  return check(
    await admin.from("users").select(
      "id,is_admin,suspended_until,suspension_reason,blog_strikes,blog_banned_until",
    ).eq("id", id).maybeSingle(),
  );
}
async function writerCheck(admin: any, id: string) {
  const u = await userState(admin, id);
  if (!u) return fail("Account not found", 404);
  if (u.suspended_until && new Date(u.suspended_until) > new Date()) {
    return fail("Your account is suspended.", 403);
  }
  if (u.blog_banned_until && new Date(u.blog_banned_until) > new Date()) {
    return fail(
      "Your blog publishing privileges are temporarily suspended.",
      403,
    );
  }
  return null;
}
async function adminCheck(admin: any, id: string) {
  const u = await userState(admin, id);
  return Boolean(u?.is_admin);
}
async function strike(
  admin: any,
  userId: string,
  articleId: string | null,
  reason: string,
) {
  const u = await userState(admin, userId);
  const strikes = (u?.blog_strikes || 0) + 1;
  let days = strikes >= 8 ? 3650 : strikes >= 5 ? 30 : strikes >= 3 ? 7 : 0;
  check(
    await admin.from("users").update({
      blog_strikes: strikes,
      ...(days
        ? {
          blog_banned_until: new Date(Date.now() + days * 86400000)
            .toISOString(),
        }
        : {}),
    }).eq("id", userId),
  );
  await log(admin, {
    articleId,
    subjectUserId: userId,
    action: "strike",
    reason,
    details: { strikes, ban_days: days },
  });
}
function toArticle(row: any, viewerId: string) {
  const author = row.author || {};
  const {
    author: _,
    content_text: __,
    content_html: ___,
    content_hash: ____,
    moderation: _____,
    rejection_reason: ______,
    has_embeds: _______,
    ...a
  } = row;
  return {
    ...a,
    author_id: row.author_id,
    author_username: author.username || "",
    author_display_name: author.display_name || "",
    author_avatar_url: author.avatar_url || null,
    read_minutes: Math.max(
      1,
      Math.ceil((row.content_text || "").length / 1200),
    ),
    is_liked: false,
    is_bookmarked: false,
  };
}
async function withEngagement(admin: any, rows: any[], viewerId: string) {
  if (!rows.length) return rows;
  const ids = rows.map((x) => x.id);
  const [likes, bookmarks] = await Promise.all([
    admin.from("blog_likes").select("article_id").eq("user_id", viewerId).in(
      "article_id",
      ids,
    ),
    admin.from("blog_bookmarks").select("article_id").eq("user_id", viewerId)
      .in("article_id", ids),
  ]);
  check(likes);
  check(bookmarks);
  const ls = new Set((likes.data || []).map((x: any) => x.article_id)),
    bs = new Set((bookmarks.data || []).map((x: any) => x.article_id));
  return rows.map((r) => ({
    ...toArticle(r, viewerId),
    is_liked: ls.has(r.id),
    is_bookmarked: bs.has(r.id),
  }));
}
async function loadArticle(
  admin: any,
  id: string,
  viewerId: string,
  full = false,
) {
  const fields =
    "*, author:users!blog_articles_author_id_fkey(id,username,display_name,avatar_url)";
  const row = check(
    await admin.from("blog_articles").select(fields).eq("id", id).maybeSingle(),
  );
  if (!row) return null;
  const isOwner = row.author_id === viewerId,
    isAdmin = await adminCheck(admin, viewerId);
  if (row.status !== "published" && !isOwner && !isAdmin) return null;
  if (row.status === "published" && !isOwner) {
    const blocked = await admin.from("blocks").select("blocker_id").or(
      `and(blocker_id.eq.${viewerId},blocked_id.eq.${row.author_id}),and(blocker_id.eq.${row.author_id},blocked_id.eq.${viewerId})`,
    ).limit(1);
    if (!blocked.error && blocked.data?.length) return null;
    check(
      await admin.from("blog_articles").update({
        views_count: (row.views_count || 0) + 1,
      }).eq("id", id),
    );
    row.views_count = (row.views_count || 0) + 1;
  }
  const shaped = toArticle(row, viewerId);
  if (full) shaped.content_html = row.content_html;
  if (isOwner || isAdmin) {
    shaped.rejection_reason = row.rejection_reason;
    shaped.moderation = row.moderation;
  }
  shaped.is_owner = isOwner;
  return shaped;
}
async function moderationResult(admin: any, article: any, actorId: string) {
  const images = [
    ...(article.cover_url ? [article.cover_url] : []),
    ...extractImagePaths(article.content_html),
  ];
  const mod = await moderateContent({
    title: article.title,
    text: article.content_text,
    images,
    hasEmbeds: article.has_embeds,
  });
  const publicMod = publicReasons(mod);
  let status = mod.decision === "approve" && moderationMode() === "auto"
    ? "published"
    : mod.decision === "reject"
    ? "rejected"
    : "in_review";
  const rejection = status === "rejected"
    ? "The article appears to violate the Vynzo content policy."
    : null;
  check(
    await admin.from("blog_articles").update({
      status,
      moderation: publicMod,
      rejection_reason: rejection,
      published_at: status === "published"
        ? new Date().toISOString()
        : article.published_at,
      updated_at: new Date().toISOString(),
    }).eq("id", article.id),
  );
  await log(admin, {
    articleId: article.id,
    subjectUserId: article.author_id,
    actorId,
    action: `auto_${mod.decision}`,
    reason: publicMod.categories.join(", ") || publicMod.reasons.join(", ") ||
      null,
    details: publicMod,
  });
  if (status === "rejected") {
    await strike(admin, article.author_id, article.id, "auto_rejected");
  }
  return {
    status,
    result: status === "published"
      ? "published"
      : status === "rejected"
      ? "rejected"
      : "in_review",
    moderation: {
      categories: publicMod.categories,
      reasons: publicMod.reasons,
    },
  };
}
function magic(bytes: Uint8Array, ext: string) {
  const ascii = (a: number, b: number) =>
    String.fromCharCode(...bytes.slice(a, b));
  if (
    [".jpg", ".jpeg"].includes(ext) && bytes[0] === 255 && bytes[1] === 216 &&
    bytes[2] === 255
  ) return "image";
  if (ext === ".png" && bytes[0] === 137 && ascii(1, 4) === "PNG") {
    return "image";
  }
  if (ext === ".gif" && ascii(0, 4) === "GIF8") return "image";
  if (ext === ".webp" && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "image";
  }
  if ([".mp4", ".mov", ".m4v"].includes(ext) && ascii(4, 8) === "ftyp") {
    return "video";
  }
  if (
    ext === ".webm" && bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 &&
    bytes[3] === 163
  ) return "video";
  return null;
}

export async function handleBlogs(
  req: Request,
  viewerId: string,
  headers: Record<string, string>,
  admin: any,
) {
  const url = new URL(req.url),
    parts = url.pathname.split("/").filter(Boolean),
    bi = parts.indexOf("blogs"),
    p = parts.slice(bi + 1),
    method = req.method.toUpperCase();
  const done = (status: number, body: Record<string, unknown>) =>
      result(status, body, headers),
    body = method === "GET" || p.join("/") === "media"
      ? {}
      : await parseBody(req);
  try {
    if (method === "GET" && p.join("/") === "meta") {
      return done(200, {
        categories: CATEGORIES,
        report_reasons: REPORT_REASONS,
        moderation: { mode: moderationMode(), ai: aiEnabled() },
      });
    }
    if (p[0] === "admin") {
      if (!await adminCheck(admin, viewerId)) {
        return done(403, { error: "Admin access required." });
      }
      if (method === "GET" && p[1] === "stats") {
        const [review, pub, reports, appeals, held] = await Promise.all([
          admin.from("blog_articles").select("id", {
            count: "exact",
            head: true,
          }).eq("status", "in_review"),
          admin.from("blog_articles").select("id", {
            count: "exact",
            head: true,
          }).eq("status", "published"),
          admin.from("blog_reports").select("id", {
            count: "exact",
            head: true,
          }).eq("status", "open"),
          admin.from("blog_appeals").select("id", {
            count: "exact",
            head: true,
          }).eq("status", "open"),
          admin.from("blog_comments").select("id", {
            count: "exact",
            head: true,
          }).eq("status", "held"),
        ]);
        [review, pub, reports, appeals, held].forEach(check);
        return done(200, {
          stats: {
            in_review: review.count || 0,
            published: pub.count || 0,
            open_reports: reports.count || 0,
            open_appeals: appeals.count || 0,
            held_comments: held.count || 0,
          },
          moderation: { mode: moderationMode(), ai: aiEnabled() },
        });
      }
      if (method === "GET" && p[1] === "queue") {
        const articles = check(
          await admin.from("blog_articles").select(
            "*, author:users!blog_articles_author_id_fkey(id,username,display_name,avatar_url,blog_strikes)",
          ).in("status", ["pending", "in_review"]).order("updated_at", {
            ascending: true,
          }).limit(100),
        );
        const comments = check(
          await admin.from("blog_comments").select(
            "*, user:users!blog_comments_user_id_fkey(username,display_name,avatar_url)",
          ).eq("status", "held").order("created_at").limit(100),
        );
        const reports = check(
          await admin.from("blog_reports").select("target_id").eq(
            "target_type",
            "article",
          ).eq("status", "open"),
        );
        const counts = new Map<string, number>();
        for (const x of reports) {
          counts.set(x.target_id, (counts.get(x.target_id) || 0) + 1);
        }
        return done(200, {
          articles: articles.map((r: any) => ({
            ...toArticle(r, viewerId),
            content_html: r.content_html,
            moderation: r.moderation,
            author_strikes: r.author?.blog_strikes || 0,
            open_reports: counts.get(r.id) || 0,
          })),
          comments: comments.map((c: any) => ({
            ...c,
            username: c.user?.username,
          })),
        });
      }
      if (method === "GET" && p[1] === "reports") {
        const rows = check(
          await admin.from("blog_reports").select("*").eq("status", "open")
            .order("created_at", { ascending: false }).limit(500),
        );
        const groups = new Map<string, any>();
        for (const r of rows) {
          const k = r.target_type + ":" + r.target_id;
          const g = groups.get(k) ||
            {
              target_type: r.target_type,
              target_id: r.target_id,
              reports: 0,
              reasons: new Set<string>(),
              last_report: r.created_at,
            };
          g.reports++;
          g.reasons.add(r.reason);
          if (r.created_at > g.last_report) g.last_report = r.created_at;
          groups.set(k, g);
        }
        const reports = [...groups.values()];
        for (const g of reports) {
          if (g.target_type === "article") {
            const x = check(
              await admin.from("blog_articles").select("title,status").eq(
                "id",
                g.target_id,
              ).maybeSingle(),
            );
            g.article_title = x?.title || "[Deleted article]";
            g.article_status = x?.status || "deleted";
          } else {
            const x = check(
              await admin.from("blog_comments").select("body,status").eq(
                "id",
                g.target_id,
              ).maybeSingle(),
            );
            g.comment_body = x?.body || "[Deleted comment]";
            g.comment_status = x?.status || "deleted";
          }
          g.reasons = [...g.reasons];
        }
        return done(200, { reports });
      }
      if (method === "GET" && p[1] === "appeals") {
        const rows = check(
          await admin.from("blog_appeals").select(
            "*, article:blog_articles(id,title,content_html,status,author_id,rejection_reason), author:users!blog_appeals_author_id_fkey(username,display_name,blog_strikes)",
          ).eq("status", "open").order("created_at").limit(100),
        );
        return done(200, {
          appeals: rows.map((a: any) => ({
            ...a,
            title: a.article?.title,
            username: a.author?.username,
            blog_strikes: a.author?.blog_strikes || 0,
            article_status: a.article?.status,
            content_html: a.article?.content_html,
            rejection_reason: a.article?.rejection_reason,
          })),
        });
      }
      if (method === "GET" && p[1] === "logs") {
        const rows = check(
          await admin.from("blog_moderation_logs").select(
            "*, actor:users!blog_moderation_logs_actor_id_fkey(username), subject:users!blog_moderation_logs_subject_user_id_fkey(username)",
          ).order("created_at", { ascending: false }).limit(200),
        );
        const logs = rows.map((l: any) => ({
          ...l,
          actor_username: l.actor?.username,
          subject_username: l.subject?.username,
        }));
        return done(200, { logs });
      }
      if (method === "GET" && p[1] === "users") {
        let q = admin.from("users").select(
          "id,username,display_name,is_admin,blog_strikes,blog_banned_until,suspended_until,suspension_reason",
        ).order("blog_strikes", { ascending: false }).limit(100);
        if (url.searchParams.get("q")) {
          q = q.ilike(
            "username",
            `%${url.searchParams.get("q")!.slice(0, 50)}%`,
          );
        }
        const users = check(await q);
        return done(200, { users });
      }
      if (method === "POST" && p[1] === "articles" && p.length === 4) {
        const [id, action] = p.slice(2);
        if (
          !uuid(id) ||
          !["approve", "reject", "remove", "restore"].includes(action)
        ) return done(400, { error: "Invalid moderation action." });
        const article = check(
          await admin.from("blog_articles").select("*").eq("id", id)
            .maybeSingle(),
        );
        if (!article) return done(404, { error: "Article not found" });
        const reason = String(body.reason || "").slice(0, 500);
        let patch: any = { updated_at: new Date().toISOString() };
        if (action === "approve") {
          patch.status = "published";
          patch.published_at = new Date().toISOString();
          patch.rejection_reason = null;
        }
        if (action === "reject") {
          patch.status = "rejected";
          patch.rejection_reason = reason ||
            "The article did not meet the Vynzo content policy.";
        }
        if (action === "remove") patch.status = "removed";
        if (action === "restore") patch.status = "in_review";
        check(await admin.from("blog_articles").update(patch).eq("id", id));
        await log(admin, {
          articleId: id,
          subjectUserId: article.author_id,
          actorId: viewerId,
          action: `admin_${action}`,
          reason,
        });
        if (action === "reject" || action === "remove") {
          await strike(admin, article.author_id, id, `admin_${action}`);
        }
        return done(200, { ok: true });
      }
      if (method === "POST" && p[1] === "comments" && p.length === 4) {
        const [id, action] = p.slice(2);
        if (!uuid(id) || !["approve", "remove", "restore"].includes(action)) {
          return done(400, { error: "Invalid moderation action." });
        }
        const c = check(
          await admin.from("blog_comments").select("*").eq("id", id)
            .maybeSingle(),
        );
        if (!c) return done(404, { error: "Comment not found" });
        const status = action === "approve" || action === "restore"
          ? "visible"
          : "removed";
        check(
          await admin.from("blog_comments").update({ status }).eq("id", id),
        );
        await log(admin, {
          commentId: id,
          subjectUserId: c.user_id,
          actorId: viewerId,
          action: `admin_comment_${action}`,
        });
        return done(200, { ok: true });
      }
      if (
        method === "POST" && p[1] === "reports" && p.length === 5 &&
        p[4] === "dismiss"
      ) {
        const [type, target] = p.slice(2, 4);
        if (!["article", "comment"].includes(type) || !uuid(target)) {
          return done(400, { error: "Invalid report target." });
        }
        check(
          await admin.from("blog_reports").update({ status: "dismissed" }).eq(
            "target_type",
            type,
          ).eq("target_id", target).eq("status", "open"),
        );
        return done(200, { ok: true });
      }
      if (
        method === "POST" && p[1] === "appeals" && p.length === 4 &&
        p[3] === "resolve"
      ) {
        const id = p[2];
        if (!uuid(id)) return done(400, { error: "Invalid appeal." });
        const appeal = check(
          await admin.from("blog_appeals").select("*").eq("id", id).eq(
            "status",
            "open",
          ).maybeSingle(),
        );
        if (!appeal) return done(404, { error: "Appeal not found" });
        const accept = Boolean(body.accept),
          note = String(body.note || "").slice(0, 1000);
        check(
          await admin.from("blog_appeals").update({
            status: accept ? "accepted" : "denied",
            admin_note: note,
            resolved_by: viewerId,
            resolved_at: new Date().toISOString(),
          }).eq("id", id),
        );
        if (accept) {
          check(
            await admin.from("blog_articles").update({
              status: "in_review",
              rejection_reason: null,
            }).eq("id", appeal.article_id),
          );
        }
        await log(admin, {
          articleId: appeal.article_id,
          subjectUserId: appeal.author_id,
          actorId: viewerId,
          action: accept ? "appeal_accepted" : "appeal_denied",
          reason: note,
        });
        return done(200, { ok: true });
      }
      if (
        method === "POST" && p[1] === "users" && p.length === 4 &&
        p[3] === "suspend"
      ) {
        const id = p[2];
        if (!uuid(id) || id === viewerId) {
          return done(400, { error: "Invalid user." });
        }
        const target = check(
          await admin.from("users").select("is_admin").eq("id", id)
            .maybeSingle(),
        );
        if (!target) return done(404, { error: "User not found" });
        if (target.is_admin) {
          return done(403, {
            error: "Administrators cannot be suspended here.",
          });
        }
        const lift = Boolean(body.lift),
          days = clamp(String(body.days ?? 7), 0, 3650, 7),
          until = days === 0
            ? new Date("2099-12-31T23:59:59Z")
            : new Date(Date.now() + days * 86400000);
        const reason = String(body.reason || "").slice(0, 500);
        check(
          await admin.from("users").update(
            lift
              ? {
                suspended_until: null,
                suspension_reason: null,
                blog_banned_until: null,
              }
              : {
                suspended_until: until.toISOString(),
                suspension_reason: reason,
              },
          ).eq("id", id),
        );
        await log(admin, {
          subjectUserId: id,
          actorId: viewerId,
          action: lift ? "user_unsuspended" : "user_suspended",
          reason,
        });
        return done(200, { ok: true });
      }
      return done(404, { error: "Admin endpoint not found" });
    }
    if (method === "GET" && p.join("/") === "tags/trending") {
      const rows = check(
        await admin.from("blog_articles").select("tags").eq(
          "status",
          "published",
        ).gt("published_at", new Date(Date.now() - 30 * 86400000).toISOString())
          .limit(500),
      );
      const counts = new Map<string, number>();
      for (const a of rows) {
        for (const tag of a.tags || []) {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }
      return done(200, {
        tags: [...counts].sort((a, b) =>
          b[1] - a[1] || a[0].localeCompare(b[0])
        ).slice(0, 12).map(([tag, uses]) => ({ tag, uses })),
      });
    }
    if (method === "GET" && p.join("/") === "mine") {
      const rows = check(
        await admin.from("blog_articles").select(
          "*, author:users!blog_articles_author_id_fkey(id,username,display_name,avatar_url)",
        ).eq("author_id", viewerId).order("updated_at", { ascending: false })
          .limit(100),
      );
      const user = await userState(admin, viewerId);
      const aps = check(
        await admin.from("blog_appeals").select("article_id,status").eq(
          "author_id",
          viewerId,
        ).order("created_at", { ascending: false }),
      );
      const apMap = new Map<string, string>();
      for (const a of aps) {
        if (!apMap.has(a.article_id)) apMap.set(a.article_id, a.status);
      }
      return done(200, {
        articles: rows.map((r: any) => ({
          ...toArticle(r, viewerId),
          content_html: r.content_html,
          rejection_reason: r.rejection_reason,
          moderation: r.moderation,
          appeal_status: apMap.get(r.id) || null,
        })),
        strikes: user?.blog_strikes || 0,
        banned_until: user?.blog_banned_until || null,
      });
    }
    if (method === "GET" && p.join("/") === "bookmarks") {
      const b = check(
        await admin.from("blog_bookmarks").select("article_id,created_at").eq(
          "user_id",
          viewerId,
        ).order("created_at", { ascending: false }).limit(100),
      );
      const ids = b.map((x: any) => x.article_id);
      const rows = ids.length
        ? check(
          await admin.from("blog_articles").select(
            "*, author:users!blog_articles_author_id_fkey(id,username,display_name,avatar_url)",
          ).in("id", ids).eq("status", "published"),
        )
        : [];
      const map = new Map(rows.map((r: any) => [r.id, r]));
      const bookmarkBlocks = await admin.from("blocks").select(
        "blocker_id,blocked_id",
      ).or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`);
      check(bookmarkBlocks);
      const hiddenAuthors = new Set(
        (bookmarkBlocks.data || []).map((x: any) =>
          x.blocker_id === viewerId ? x.blocked_id : x.blocker_id
        ),
      );
      return done(200, {
        articles: await withEngagement(
          admin,
          ids.map((id: string) => map.get(id)).filter((r: any) =>
            r && !hiddenAuthors.has(r.author_id)
          ),
          viewerId,
        ),
      });
    }
    if (method === "GET" && p.join("/") === "media/last") {
      const x = lastUploads.get(viewerId);
      return done(200, {
        upload: x && Date.now() - x.at < 300000
          ? { url: x.url, type: x.type }
          : null,
      });
    }
    if (method === "POST" && p.join("/") === "media") {
      if (!allowRate(viewerId, "media", 30, 60 * 60 * 1000)) {
        return done(429, {
          error: "Too many uploads. Please try again later.",
        });
      }
      const w = await writerCheck(admin, viewerId);
      if (w) return done(w.status, w.body);
      const form = await req.formData(), file = form.get("image");
      if (!(file instanceof File)) {
        return done(400, { error: "Image or video file is required" });
      }
      const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = magic(bytes.slice(0, 12), ext);
      if (!kind) {
        return done(400, {
          error:
            "The file is not a valid JPEG, PNG, GIF or WEBP image, or MP4, WEBM or MOV video.",
        });
      }
      if (kind === "image" && file.size > MAX_IMAGE) {
        return done(400, { error: "Images can be up to 15 MB." });
      }
      if (kind === "video" && file.size > MAX_VIDEO) {
        return done(400, { error: "Videos can be up to 50 MB." });
      }
      const mime = kind === "video"
        ? (ext === ".webm"
          ? "video/webm"
          : ext === ".mov"
          ? "video/quicktime"
          : "video/mp4")
        : (ext === ".png"
          ? "image/png"
          : ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
          ? "image/webp"
          : "image/jpeg");
      const path = `blogs/${viewerId}/${crypto.randomUUID()}${ext}`;
      const upload = await admin.storage.from("uploads").upload(path, bytes, {
        contentType: mime,
        upsert: false,
      });
      check(upload);
      const url =
        admin.storage.from("uploads").getPublicUrl(path).data.publicUrl;
      lastUploads.set(viewerId, { url, type: kind, at: Date.now() });
      return done(201, { url, type: kind });
    }
    if (method === "POST" && p.join("/") === "embed") {
      const embedded = toEmbedUrl(body.url);
      return embedded ? done(200, { url: embedded }) : done(400, {
        error: "Only https YouTube and Vimeo links can be embedded.",
      });
    }
    if (method === "GET" && p.length === 0) {
      const limit = clamp(url.searchParams.get("limit"), 1, 30, 12),
        offset = clamp(url.searchParams.get("offset"), 0, 100000, 0);
      let q = admin.from("blog_articles").select(
        "*, author:users!blog_articles_author_id_fkey(id,username,display_name,avatar_url)",
      ).eq("status", "published").order("published_at", { ascending: false })
        .range(offset, offset + limit - 1);
      const cat = url.searchParams.get("category");
      if (cat && CATEGORIES.includes(cat)) q = q.eq("category", cat);
      const author = url.searchParams.get("author");
      if (author && uuid(author)) q = q.eq("author_id", author);
      const tag = (url.searchParams.get("tag") || "").replace(/^#/, "")
        .toLowerCase().slice(0, 30);
      if (tag) q = q.contains("tags", [tag]);
      const search = (url.searchParams.get("q") || "").trim().slice(0, 80);
      if (search.startsWith("#") && search.length > 2) {
        q = q.contains("tags", [search.slice(1).toLowerCase()]);
      } else if (search) {
        q = q.or(
          `title.ilike.%${search.replace(/[,%()]/g, " ")}%,excerpt.ilike.%${
            search.replace(/[,%()]/g, " ")
          }%,content_text.ilike.%${search.replace(/[,%()]/g, " ")}%`,
        );
      }
      let rows = check(await q);
      const blocks = await admin.from("blocks").select("blocker_id,blocked_id")
        .or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`);
      check(blocks);
      const hidden = new Set(
        (blocks.data || []).map((b: any) =>
          b.blocker_id === viewerId ? b.blocked_id : b.blocker_id
        ),
      );
      rows = rows.filter((a: any) => !hidden.has(a.author_id));
      if (url.searchParams.get("sort") === "trending") {
        rows = rows.sort((a: any, b: any) => {
          const score = (x: any) =>
            (x.likes_count * 3 + x.comments_count * 4 + x.shares_count * 3 +
              x.bookmarks_count * 2 + x.views_count * .2) /
            Math.pow(
              (Date.now() - new Date(x.published_at || Date.now()).getTime()) /
                  3600000 + 2,
              1.3,
            );
          return score(b) - score(a);
        });
      }
      return done(200, {
        articles: await withEngagement(admin, rows, viewerId),
        limit,
        offset,
      });
    }
    if (method === "POST" && p.length === 0) {
      const w = await writerCheck(admin, viewerId);
      if (w) return done(w.status, w.body);
      const input = setParams(body);
      if (input.title.length < 3) {
        return done(400, { error: "Add a title (at least 3 characters)." });
      }
      if (input.content_html.length > MAX_HTML) {
        return done(400, { error: "The article is too long." });
      }
      const hash = await contentHash(`${input.title} ${input.content_text}`);
      const row = check(
        await admin.from("blog_articles").insert({
          author_id: viewerId,
          ...input,
          content_hash: hash,
        }).select("id,status").single(),
      );
      return done(201, { article: row });
    }
    if (p[0] === "authors" && p[1]) {
      const authorId = p[1];
      if (!uuid(authorId)) return done(404, { error: "Author not found" });
      if (method === "GET" && p.length === 2) {
        const u = check(
          await admin.from("users").select(
            "id,username,display_name,avatar_url,bio,created_at",
          ).eq("id", authorId).maybeSingle(),
        );
        if (!u) return done(404, { error: "Author not found" });
        const rows = check(
          await admin.from("blog_articles").select("id", { count: "exact" }).eq(
            "author_id",
            authorId,
          ).eq("status", "published"),
        );
        const [followers, following] = await Promise.all([
          admin.from("follows").select("follower_id", {
            count: "exact",
            head: true,
          }).eq(
            "following_id",
            authorId,
          ).eq("status", "accepted"),
          admin.from("follows").select("follower_id", {
            count: "exact",
            head: true,
          }).eq(
            "follower_id",
            authorId,
          ).eq("status", "accepted"),
        ]);
        check(followers);
        check(following);
        const follow = check(
          await admin.from("follows").select("status").eq(
            "follower_id",
            viewerId,
          ).eq("following_id", authorId).maybeSingle(),
        );
        return done(200, {
          author: {
            ...u,
            articles_count: rows.length,
            followers_count: followers.count || 0,
            following_count: following.count || 0,
            is_following: follow?.status === "accepted",
          },
        });
      }
      if (method === "POST" && p[2] === "follow") {
        if (authorId === viewerId) {
          return done(400, { error: "You cannot follow yourself." });
        }
        const existing = check(
          await admin.from("follows").select("status").eq(
            "follower_id",
            viewerId,
          ).eq("following_id", authorId).maybeSingle(),
        );
        if (existing) {
          check(
            await admin.from("follows").delete().eq("follower_id", viewerId).eq(
              "following_id",
              authorId,
            ),
          );
          return done(200, { following: false });
        }
        const target = check(
          await admin.from("users").select("is_private").eq("id", authorId)
            .maybeSingle(),
        );
        if (!target) return done(404, { error: "Author not found" });
        const status = target.is_private ? "pending" : "accepted";
        check(
          await admin.from("follows").insert({
            follower_id: viewerId,
            following_id: authorId,
            status,
          }),
        );
        return done(200, { following: status === "accepted", status });
      }
    }
    if (p[0] === "comments" && method === "DELETE" && p[1]) {
      const id = p[1];
      if (!uuid(id)) return done(404, { error: "Comment not found" });
      const c = check(
        await admin.from("blog_comments").select("id,user_id,article_id").eq(
          "id",
          id,
        ).maybeSingle(),
      );
      if (!c) return done(404, { error: "Comment not found" });
      const article = check(
        await admin.from("blog_articles").select("author_id").eq(
          "id",
          c.article_id,
        ).maybeSingle(),
      );
      if (
        c.user_id !== viewerId && article?.author_id !== viewerId &&
        !await adminCheck(admin, viewerId)
      ) {
        return done(403, { error: "Not allowed" });
      }
      check(
        await admin.from("blog_comments").update({ status: "removed" }).eq(
          "id",
          id,
        ),
      );
      const remaining = await admin.from("blog_comments").select("id", {
        count: "exact",
        head: true,
      }).eq("article_id", c.article_id).eq("status", "visible");
      check(remaining);
      check(
        await admin.from("blog_articles").update({
          comments_count: remaining.count || 0,
        }).eq("id", c.article_id),
      );
      return done(200, { ok: true });
    }
    if (p[0] === "report" && method === "POST") {
      if (!allowRate(viewerId, "reports", 10, 60 * 60 * 1000)) {
        return done(429, {
          error: "Too many reports. Please try again later.",
        });
      }
      const type = body.target_type || body.type,
        target = String(body.target_id || "");
      if (
        !["article", "comment"].includes(type) || !uuid(target) ||
        !REPORT_REASONS.includes(body.reason)
      ) return done(400, { error: "Choose a valid report reason." });
      const ins = await admin.from("blog_reports").insert({
        reporter_id: viewerId,
        target_type: type,
        target_id: target,
        reason: body.reason,
        details: String(body.details || "").slice(0, 2000),
      });
      if (ins.error && ins.error.code === "23505") {
        return done(409, { error: "You already reported this item." });
      }
      check(ins);
      const count = await admin.from("blog_reports").select("id", {
        count: "exact",
        head: true,
      }).eq("target_type", type).eq("target_id", target).eq("status", "open");
      check(count);
      if ((count.count || 0) >= 3 && type === "article") {
        check(
          await admin.from("blog_articles").update({ status: "in_review" }).eq(
            "id",
            target,
          ).eq("status", "published"),
        );
      }
      return done(201, { ok: true });
    }
    if (p[0] === "admin") {
      return done(404, { error: "Admin endpoint not found" });
    }
    if (p.length === 1 && uuid(p[0])) {
      const id = p[0];
      if (method === "GET") {
        const article = await loadArticle(admin, id, viewerId, true);
        if (!article) return done(404, { error: "Article not found" });
        const [liked, bookmarked] = await Promise.all([
          admin.from("blog_likes").select("article_id").eq("article_id", id).eq(
            "user_id",
            viewerId,
          ).maybeSingle(),
          admin.from("blog_bookmarks").select("article_id").eq("article_id", id)
            .eq("user_id", viewerId).maybeSingle(),
        ]);
        check(liked);
        check(bookmarked);
        article.is_liked = Boolean(liked.data);
        article.is_bookmarked = Boolean(bookmarked.data);
        return done(200, { article });
      }
      if (method === "PUT") {
        const w = await writerCheck(admin, viewerId);
        if (w) return done(w.status, w.body);
        const existing = check(
          await admin.from("blog_articles").select("id,status,author_id").eq(
            "id",
            id,
          ).maybeSingle(),
        );
        if (!existing || existing.author_id !== viewerId) {
          return done(404, { error: "Article not found" });
        }
        if (existing.status === "removed") {
          return done(403, {
            error: "This article was removed. You can appeal the decision.",
          });
        }
        const input = setParams(body);
        if (input.title.length < 3) {
          return done(400, { error: "Add a title (at least 3 characters)." });
        }
        if (input.content_html.length > MAX_HTML) {
          return done(400, { error: "The article is too long." });
        }
        const hash = await contentHash(`${input.title} ${input.content_text}`);
        const row = check(
          await admin.from("blog_articles").update({
            ...input,
            content_hash: hash,
            status: "draft",
            rejection_reason: null,
            updated_at: new Date().toISOString(),
          }).eq("id", id).select("id,status").single(),
        );
        return done(200, {
          article: row,
          note: existing.status === "published" ? "unpublished_for_edit" : null,
        });
      }
      if (method === "DELETE") {
        const w = await writerCheck(admin, viewerId);
        if (w) return done(w.status, w.body);
        const d = await admin.from("blog_articles").delete().eq("id", id).eq(
          "author_id",
          viewerId,
        );
        check(d);
        return done(200, { ok: true });
      }
    }
    if (p.length === 2 && uuid(p[0])) {
      const [id, action] = p;
      if (action === "publish" && method === "POST") {
        const w = await writerCheck(admin, viewerId);
        if (w) return done(w.status, w.body);
        const found = check(
          await admin.from("blog_articles").select("*").eq("id", id).eq(
            "author_id",
            viewerId,
          ).maybeSingle(),
        );
        if (!found) return done(404, { error: "Article not found" });
        if (!["draft", "rejected"].includes(found.status)) {
          return done(409, { error: "This article is already submitted." });
        }
        if (found.title.length < 3 || found.content_text.length < 100) {
          return done(400, {
            error:
              "Write a title and at least 100 characters before publishing.",
          });
        }
        const daily = await admin.from("blog_moderation_logs").select("id", {
          count: "exact",
          head: true,
        }).eq("subject_user_id", viewerId).eq("action", "submitted").gt(
          "created_at",
          new Date(Date.now() - 86400000).toISOString(),
        );
        check(daily);
        if ((daily.count || 0) >= MAX_SUBMISSIONS) {
          return done(429, {
            error:
              "You have reached the daily publishing limit. Try again tomorrow.",
          });
        }
        const dup = check(
          await admin.from("blog_articles").select("id").eq(
            "content_hash",
            found.content_hash,
          ).neq("id", id).in("status", ["published", "pending", "in_review"])
            .limit(1),
        );
        if (dup.length) {
          return done(409, {
            error: "This content duplicates an existing article.",
          });
        }
        await log(admin, {
          articleId: id,
          subjectUserId: viewerId,
          actorId: viewerId,
          action: "submitted",
        });
        check(
          await admin.from("blog_articles").update({
            status: "pending",
            updated_at: new Date().toISOString(),
          }).eq("id", id),
        );
        return done(200, await moderationResult(admin, found, viewerId));
      }
      if (action === "unpublish" && method === "POST") {
        const row = check(
          await admin.from("blog_articles").update({
            status: "draft",
            updated_at: new Date().toISOString(),
          }).eq("id", id).eq("author_id", viewerId).in("status", [
            "published",
            "pending",
            "in_review",
          ]).select("id,status").maybeSingle(),
        );
        return row
          ? done(200, { article: row })
          : done(404, { error: "Article not found" });
      }
      if (["like", "bookmark"].includes(action) && method === "POST") {
        const article = check(
          await admin.from("blog_articles").select("id").eq("id", id).eq(
            "status",
            "published",
          ).maybeSingle(),
        );
        if (!article) return done(404, { error: "Article not found" });
        const table = action === "like" ? "blog_likes" : "blog_bookmarks",
          counter = action === "like" ? "likes_count" : "bookmarks_count";
        const existing = check(
          await admin.from(table).select("article_id").eq("article_id", id).eq(
            "user_id",
            viewerId,
          ).maybeSingle(),
        );
        if (existing) {
          check(
            await admin.from(table).delete().eq("article_id", id).eq(
              "user_id",
              viewerId,
            ),
          );
        } else {check(
            await admin.from(table).insert({
              article_id: id,
              user_id: viewerId,
            }),
          );}
        const count = await admin.from(table).select("article_id", {
          count: "exact",
          head: true,
        }).eq("article_id", id);
        check(count);
        check(
          await admin.from("blog_articles").update({
            [counter]: count.count || 0,
          }).eq("id", id),
        );
        return done(200, {
          active: !existing,
          liked: action === "like" ? !existing : undefined,
          bookmarked: action === "bookmark" ? !existing : undefined,
        });
      }
      if (action === "share" && method === "POST") {
        const a = check(
          await admin.from("blog_articles").select("id,shares_count").eq(
            "id",
            id,
          ).eq("status", "published").maybeSingle(),
        );
        if (!a) return done(404, { error: "Article not found" });
        check(
          await admin.from("blog_articles").update({
            shares_count: (a.shares_count || 0) + 1,
          }).eq("id", id),
        );
        return done(200, { shares_count: (a.shares_count || 0) + 1 });
      }
      if (action === "comments" && method === "GET") {
        const comments = check(
          await admin.from("blog_comments").select(
            "*, user:users!blog_comments_user_id_fkey(id,username,display_name,avatar_url)",
          ).eq("article_id", id).eq("status", "visible").order("created_at")
            .limit(200),
        );
        const blockedCommenters = await admin.from("blocks").select(
          "blocker_id,blocked_id",
        ).or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`);
        check(blockedCommenters);
        const hiddenCommenters = new Set(
          (blockedCommenters.data || []).map((b: any) =>
            b.blocker_id === viewerId ? b.blocked_id : b.blocker_id
          ),
        );
        return done(200, {
          comments: comments.filter((c: any) =>
            !hiddenCommenters.has(c.user_id)
          ).map((c: any) => ({
            ...c,
            username: c.user?.username,
            display_name: c.user?.display_name,
            avatar_url: c.user?.avatar_url,
          })),
        });
      }
      if (action === "comments" && method === "POST") {
        const article = check(
          await admin.from("blog_articles").select("id").eq("id", id).eq(
            "status",
            "published",
          ).maybeSingle(),
        );
        if (!article) return done(404, { error: "Article not found" });
        const text = htmlToText(String(body.body || "")).slice(0, 2000);
        if (text.length < 1) return done(400, { error: "Write a comment." });
        const mod = await moderateComment(text),
          status = mod.decision === "reject"
            ? "removed"
            : mod.decision === "review"
            ? "held"
            : "visible";
        const c = check(
          await admin.from("blog_comments").insert({
            article_id: id,
            user_id: viewerId,
            body: text,
            status,
            moderation: publicReasons(mod),
          }).select("id,status,body,created_at").single(),
        );
        if (status === "visible") {
          const count = await admin.from("blog_comments").select("id", {
            count: "exact",
            head: true,
          }).eq("article_id", id).eq("status", "visible");
          check(count);
          check(
            await admin.from("blog_articles").update({
              comments_count: count.count || 0,
            }).eq("id", id),
          );
        }
        return done(201, { comment: c, status });
      }
      if (action === "appeal" && method === "POST") {
        const a = check(
          await admin.from("blog_articles").select("id,author_id,status").eq(
            "id",
            id,
          ).eq("author_id", viewerId).maybeSingle(),
        );
        if (!a) return done(404, { error: "Article not found" });
        if (!["rejected", "removed"].includes(a.status)) {
          return done(409, { error: "This article cannot be appealed." });
        }
        const message = String(body.message || "").trim().slice(0, 2000);
        if (!message) {
          return done(400, { error: "Add a message for the review team." });
        }
        const appeal = check(
          await admin.from("blog_appeals").insert({
            article_id: id,
            author_id: viewerId,
            message,
          }).select("*").single(),
        );
        await log(admin, {
          articleId: id,
          subjectUserId: viewerId,
          actorId: viewerId,
          action: "appeal_submitted",
        });
        return done(201, { appeal });
      }
    }
    return done(404, { error: "Blog endpoint not found" });
  } catch (error) {
    console.error("Blog API error", error);
    return done(500, {
      error: "The blog service could not complete the request.",
    });
  }
}
