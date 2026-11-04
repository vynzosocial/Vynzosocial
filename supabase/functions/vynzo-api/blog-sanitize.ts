const STORAGE_PREFIX =
  "https://qyfphwrmwvnwsklfsbbo.supabase.co/storage/v1/object/public/uploads/";
const relativeMedia =
  /^\/uploads\/[A-Za-z0-9._-]+(?:\.(?:mp4|webm|mov|m4v))?$/i;
const storageMedia =
  /^https:\/\/qyfphwrmwvnwsklfsbbo\.supabase\.co\/storage\/v1\/object\/public\/uploads\/blogs\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+$/i;
const videoExt = /\.(?:mp4|webm|mov|m4v)$/i;
const allowedTags = new Set([
  "h2",
  "h3",
  "h4",
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
  "img",
  "hr",
  "code",
  "pre",
  "iframe",
  "video",
]);
const decodeEntities = (s: string) =>
  s.replace(
    /&(?:amp|lt|gt|quot|#39|nbsp);/g,
    (x) =>
      ({
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#39;": "'",
        "&nbsp;": " ",
      })[x] || x,
  );
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function toEmbedUrl(raw: unknown): string | null {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^m\./, "www.");
  let m: RegExpMatchArray | null;
  if (host === "youtu.be" && (m = u.pathname.match(/^\/([\w-]{11})$/))) {
    return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  }
  if (host === "www.youtube.com" || host === "www.youtube-nocookie.com") {
    if (
      u.pathname === "/watch" &&
      /^[\w-]{11}$/.test(u.searchParams.get("v") || "")
    ) {
      return `https://www.youtube-nocookie.com/embed/${
        u.searchParams.get("v")
      }`;
    }
    if ((m = u.pathname.match(/^\/embed\/([\w-]{11})$/))) {
      return `https://www.youtube-nocookie.com/embed/${m[1]}`;
    }
  }
  if (
    (host === "vimeo.com" || host === "player.vimeo.com") &&
    (m = u.pathname.match(/^\/(?:video\/)?(\d{5,12})$/))
  ) return `https://player.vimeo.com/video/${m[1]}`;
  return null;
}

function mediaSrc(value: string, video: boolean): string | null {
  if (relativeMedia.test(value) && (!video || videoExt.test(value))) {
    return value;
  }
  if (storageMedia.test(value) && (!video || videoExt.test(value))) {
    return value;
  }
  return null;
}

export function cleanHtml(input: unknown): string {
  let html = String(input ?? "").slice(0, 120000).replace(
    /<!--[\s\S]*?-->/g,
    "",
  );
  html = html.replace(
    /<(script|style|object|svg|math|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  return html.replace(
    /<\/?([a-z0-9-]+)\b([^>]*)>/gi,
    (whole, tagRaw: string, attrsRaw: string) => {
      const tag = tagRaw.toLowerCase();
      if (!allowedTags.has(tag)) return "";
      const closing = /^<\//.test(whole);
      if (closing) return ["br", "hr", "img"].includes(tag) ? "" : `</${tag}>`;
      const attrs: Record<string, string> = {};
      for (
        const match of attrsRaw.matchAll(
          /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
        )
      ) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
      if (tag === "a") {
        let href = attrs.href || "";
        try {
          const u = new URL(href);
          if (!["http:", "https:", "mailto:"].includes(u.protocol)) href = "";
        } catch {
          href = "";
        }
        return href
          ? `<a href="${
            escAttr(href)
          }" rel="noopener noreferrer nofollow ugc" target="_blank">`
          : "<a>";
      }
      const layout = (
        /^(25|33|50|75|100)$/.test(attrs["data-w"] || "")
          ? ` data-w="${attrs["data-w"]}"`
          : ""
      ) + (
        /^(left|right|center)$/.test(attrs["data-align"] || "")
          ? ` data-align="${attrs["data-align"]}"`
          : ""
      );
      if (tag === "img" || tag === "video") {
        const src = mediaSrc(attrs.src || "", tag === "video");
        if (!src) return "";
        return tag === "img"
          ? `<img src="${escAttr(src)}" alt="${
            escAttr(String(attrs.alt || "").slice(0, 200))
          }"${layout}>`
          : '<video src="' + escAttr(src) +
            `" controls="controls" preload="metadata" playsinline="playsinline"${layout}>`;
      }
      if (tag === "iframe") {
        const src = toEmbedUrl(attrs.src);
        return src
          ? `<iframe src="${src}" sandbox="allow-scripts allow-same-origin allow-presentation" allowfullscreen="true" loading="lazy" title="Embedded video"${layout}>`
          : "";
      }
      return `<${tag}>`;
    },
  ).trim();
}

export function htmlToText(html: unknown): string {
  return decodeEntities(
    String(html ?? "").replace(/<[^>]*>/g, " ").replace(
      /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi,
      (x) => x.toLowerCase() === "&nbsp;" ? " " : x,
    ),
  ).replace(/\s+/g, " ").trim();
}
export function extractImagePaths(html: string): string[] {
  return [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
}
export function extractHashtags(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_]{2,30})/gu)].map((m) =>
        m[1].toLowerCase()
      ),
    ),
  ];
}
export { STORAGE_PREFIX };
