const origin = "https://qyfphwrmwvnwsklfsbbo.supabase.co";
const author = "b4e777de-3d68-4f4e-9e7a-843f3229dabc";
const id = "a4e777de-3d68-4f4e-9e7a-843f3229dabc";
const path = `blogs/${author}/clip.mp4`;
const assetUrl = `${origin}/storage/v1/object/public/uploads/${path}`;

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}

Deno.test("blog preview assets reauthorize references and stream private video ranges", async () => {
  const serve = Object.getOwnPropertyDescriptor(Deno, "serve")!;
  const originalFetch = globalThis.fetch;
  const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ACCOUNT_LIFECYCLE_ENABLED"];
  const previous = names.map(name => Deno.env.get(name));
  let handler!: (request: Request) => Promise<Response>;
  let state: string | null = null;
  let status = "published";
  let isPrivate = false;
  let referenced = true;
  let mediaStatus = 206;
  let type = "video/mp4";
  let storageReads = 0;
  try {
    Deno.env.set(names[0], origin);
    Deno.env.set(names[1], "test-key");
    Deno.env.set(names[2], "true");
    Object.defineProperty(Deno, "serve", { configurable: true, value: (value: typeof handler) => { handler = value; } });
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/rest/v1/blog_articles") {
        return Response.json({
          id, author_id: author, title: "Video", status, cover_url: null, language: "en",
          content_html: referenced ? `<video src="${assetUrl}"></video>` : "<p>Removed</p>"
        });
      }
      if (url.pathname === "/rest/v1/account_lifecycle") return Response.json(state ? { state } : null);
      if (url.pathname === "/rest/v1/users") return Response.json({ is_private: isPrivate });
      if (url.pathname === `/storage/v1/object/sign/uploads/${path}` && init?.method === "POST") {
        return Response.json({ signedURL: `/object/sign/uploads/${path}?token=test` });
      }
      if (url.pathname === `/storage/v1/object/sign/uploads/${path}`) {
        storageReads++;
        equal(new Headers(init?.headers).get("Range"), "bytes=0-4");
        return new Response(mediaStatus === 416 ? null : "video", {
          status: mediaStatus,
          headers: { "Content-Type": type, "Content-Range": mediaStatus === 416 ? "bytes */5" : "bytes 0-4/10", "Content-Length": "5" }
        });
      }
      throw new Error(`Unexpected preview request: ${url.pathname}`);
    };
    await import("../supabase/functions/blog-preview/index.ts");
    const request = () => handler(new Request(`${origin}/functions/v1/blog-preview?id=${id}&image=1&asset=${encodeURIComponent(path)}`, {
      headers: { Range: "bytes=0-4" }
    }));
    const metadata = await (await handler(new Request(`${origin}/functions/v1/blog-preview?id=${id}&full=1`))).json();
    equal(metadata.content.includes("https://www.vynzosocial.com/share-blog-media?"), true);
    equal(metadata.content.includes("/storage/v1/object/public/"), false);
    const media = await request();
    equal(media.status, 206);
    equal(media.headers.get("Content-Range"), "bytes 0-4/10");
    equal(media.headers.get("Cache-Control"), "no-store");
    equal(await media.text(), "video");
    mediaStatus = 416;
    equal((await request()).headers.get("Content-Range"), "bytes */5");
    mediaStatus = 200;
    type = "text/html";
    equal((await request()).status, 502);
    const reads = storageReads;
    for (const inactive of ["deactivating", "deactivated", "deleting"]) {
      state = inactive;
      equal((await request()).status, 404);
    }
    state = null;
    status = "draft";
    equal((await request()).status, 404);
    status = "published";
    isPrivate = true;
    equal((await request()).status, 404);
    isPrivate = false;
    referenced = false;
    equal((await request()).status, 404);
    equal(storageReads, reads);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(Deno, "serve", serve);
    names.forEach((name, index) => {
      if (previous[index] === undefined) Deno.env.delete(name);
      else Deno.env.set(name, previous[index]!);
    });
  }
});
