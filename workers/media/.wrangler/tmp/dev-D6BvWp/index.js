var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.mjs
var MAX_BYTES = 50 * 1024 * 1024;
var MAX_PERMIT_SECONDS = 15 * 60;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var TYPES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"]);
var ORIGINS = /* @__PURE__ */ new Set(["https://www.vynzosocial.com", "https://vynzosocial.com", "https://localhost", "capacitor://localhost"]);
var encoder = new TextEncoder();
function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
__name(decodeBase64Url, "decodeBase64Url");
async function verifyPermit(token, secret, now) {
  if (typeof secret !== "string" || secret.length < 32 || typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, decodeBase64Url(parts[1]), encoder.encode(parts[0]))) return null;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    if (!UUID.test(claims.userId) || !UUID.test(claims.uploadId) || !["post", "story"].includes(claims.kind) || !["original", "playback"].includes(claims.variant) || !TYPES.has(claims.contentType) || claims.variant === "playback" && claims.contentType !== "video/mp4" || !Number.isSafeInteger(claims.size) || claims.size <= 0 || claims.size > MAX_BYTES || !Number.isSafeInteger(claims.expires) || claims.expires <= now || claims.expires > now + MAX_PERMIT_SECONDS) return null;
    return claims;
  } catch {
    return null;
  }
}
__name(verifyPermit, "verifyPermit");
function cors(origin) {
  const headers = { "Vary": "Origin", "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS", "Access-Control-Allow-Headers": "content-type, x-upload-permit, range" };
  if (ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
__name(cors, "cors");
async function verifyDelivery(token, secret, now) {
  if (typeof secret !== "string" || secret.length < 32 || typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, decodeBase64Url(parts[1]), encoder.encode(parts[0]))) return null;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    if (![claims.viewerId, claims.itemId, claims.userId, claims.uploadId].every((value) => UUID.test(value)) || !["post", "story"].includes(claims.kind) || !["original", "playback"].includes(claims.variant) || !Number.isSafeInteger(claims.expires) || claims.expires <= now || claims.expires > now + 60 * 60) return null;
    return claims;
  } catch {
    return null;
  }
}
__name(verifyDelivery, "verifyDelivery");
function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2] || size <= 0) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { offset: start, length: end - start + 1 };
}
__name(parseRange, "parseRange");
async function deliver(request, env, headers) {
  if (!env.MEDIA || typeof env.MEDIA_AUTH_URL !== "string" || typeof env.MEDIA_AUTH_KEY !== "string" || typeof env.MEDIA_CONTROL_SECRET !== "string" || env.MEDIA_CONTROL_SECRET.length < 32) {
    return reply(503, "Media delivery is not configured.", headers);
  }
  const claims = await verifyDelivery(new URL(request.url).searchParams.get("permit"), env.DELIVERY_SECRET, Math.floor(Date.now() / 1e3));
  if (!claims) return reply(401, "Invalid or expired media permit.", headers);
  const auth = await fetch(env.MEDIA_AUTH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.MEDIA_AUTH_KEY}`,
      "apikey": env.MEDIA_AUTH_KEY,
      "X-Media-Control": env.MEDIA_CONTROL_SECRET,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(claims)
  });
  if (auth.status === 403 || auth.status === 404) return reply(403, "Media is unavailable or private.", headers);
  if (!auth.ok) return reply(503, "Media authorization is temporarily unavailable.", headers);
  const authorization = await auth.json();
  if (authorization.allowed !== true || !["original", "playback"].includes(authorization.objectVariant)) {
    return reply(403, "Media is unavailable or private.", headers);
  }
  const path = objectPath("media", claims, authorization.objectVariant);
  const metadata = await env.MEDIA.head(path);
  if (!metadata) return reply(404, "Media not found.", headers);
  const rangeValue = request.headers.get("Range");
  const range = rangeValue ? parseRange(rangeValue, metadata.size) : null;
  if (rangeValue && !range) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${metadata.size}`, "Cache-Control": "no-store" } });
  }
  const responseHeaders = {
    ...headers,
    "Accept-Ranges": "bytes",
    "Content-Type": metadata.httpMetadata?.contentType || "application/octet-stream",
    "Content-Length": String(range ? range.length : metadata.size),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  };
  if (range) responseHeaders["Content-Range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`;
  if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers: responseHeaders });
  const object = await env.MEDIA.get(path, range ? { range } : void 0);
  if (!object) return reply(404, "Media not found.", headers);
  return new Response(object.body, { status: range ? 206 : 200, headers: responseHeaders });
}
__name(deliver, "deliver");
function reply(status, message, headers) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
__name(reply, "reply");
function validObjectRef(body) {
  return body && ["post", "story"].includes(body.kind) && UUID.test(body.userId) && UUID.test(body.uploadId);
}
__name(validObjectRef, "validObjectRef");
function objectPath(prefix, ref, variant) {
  return `${prefix}/${ref.kind}/${ref.userId}/${ref.uploadId}/${variant}`;
}
__name(objectPath, "objectPath");
async function authorizedControl(request, secret) {
  if (typeof secret !== "string" || secret.length < 32) return false;
  const provided = request.headers.get("X-Media-Control");
  if (!provided || provided.length > 512) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const proposedKey = await crypto.subtle.importKey("raw", encoder.encode(provided), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const proposed = await crypto.subtle.sign("HMAC", proposedKey, encoder.encode("vynzo-media-control"));
  return crypto.subtle.verify("HMAC", key, proposed, encoder.encode("vynzo-media-control"));
}
__name(authorizedControl, "authorizedControl");
async function control(request, env, headers) {
  if (!await authorizedControl(request, env.MEDIA_CONTROL_SECRET)) return reply(401, "Unauthorized.", headers);
  let body;
  try {
    body = await request.json();
  } catch {
    return reply(400, "Invalid request.", headers);
  }
  if (!validObjectRef(body)) return reply(400, "Invalid media reference.", headers);
  const action = new URL(request.url).pathname;
  if (action === "/internal/inspect") {
    const objects = await Promise.all(["original", "playback"].map((variant) => env.MEDIA.head(objectPath("staging", body, variant))));
    if (!objects[0]) return reply(404, "Original upload not found.", headers);
    return Response.json({
      original: { size: objects[0].size, contentType: objects[0].httpMetadata?.contentType },
      playback: objects[1] ? { size: objects[1].size, contentType: objects[1].httpMetadata?.contentType } : null
    }, { headers: { ...headers, "Cache-Control": "no-store" } });
  }
  if (action === "/internal/read") {
    if (!["staging", "media"].includes(body.prefix) || !["original", "playback"].includes(body.variant)) {
      return reply(400, "Invalid media reference.", headers);
    }
    const object = await env.MEDIA.get(objectPath(body.prefix, body, body.variant));
    if (!object) return reply(404, "Media not found.", headers);
    return new Response(object.body, {
      headers: { ...headers, "Content-Type": object.httpMetadata?.contentType || "application/octet-stream", "Cache-Control": "no-store" }
    });
  }
  if (action === "/internal/promote") {
    if (!["image", "video"].includes(body.mediaType)) return reply(400, "Invalid media type.", headers);
    const variants = body.mediaType === "video" ? ["original", "playback"] : ["original"];
    const sources = await Promise.all(variants.map((variant) => env.MEDIA.get(objectPath("staging", body, variant))));
    if (sources.some((object) => !object)) return reply(404, "Staged media is incomplete.", headers);
    const type = sources[0].httpMetadata?.contentType;
    if (!TYPES.has(type) || !type.startsWith(`${body.mediaType}/`) || body.mediaType === "video" && sources[1].httpMetadata?.contentType !== "video/mp4" || sources.some((object) => object.size <= 0 || object.size > MAX_BYTES)) {
      return reply(400, "Staged media is invalid.", headers);
    }
    const created = [];
    try {
      for (let i = 0; i < variants.length; i++) {
        const path = objectPath("media", body, variants[i]);
        const object = await env.MEDIA.put(path, sources[i].body, {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: { contentType: sources[i].httpMetadata.contentType }
        });
        if (!object) {
          if (created.length) await env.MEDIA.delete(created);
          return reply(409, "Media has already been promoted.", headers);
        }
        created.push(path);
      }
    } catch (error) {
      if (created.length) {
        try {
          await env.MEDIA.delete(created);
        } catch (cleanupError) {
          console.error("Failed to clean up partially promoted media:", cleanupError);
        }
      }
      throw error;
    }
    return Response.json({ promoted: true }, { headers: { ...headers, "Cache-Control": "no-store" } });
  }
  if (action === "/internal/delete") {
    if (!["staging", "media"].includes(body.prefix)) return reply(400, "Invalid media reference.", headers);
    await env.MEDIA.delete(["original", "playback"].map((variant) => objectPath(body.prefix, body, variant)));
    return Response.json({ deleted: true }, { headers: { ...headers, "Cache-Control": "no-store" } });
  }
  return reply(404, "Not found.", headers);
}
__name(control, "control");
var index_default = {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const headers = cors(origin);
    if (origin && !ORIGINS.has(origin)) return reply(403, "Origin is not allowed.", headers);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (new URL(request.url).pathname === "/media" && ["GET", "HEAD"].includes(request.method)) {
      try {
        return await deliver(request, env, headers);
      } catch (error) {
        console.error("Media delivery failed:", error);
        return reply(503, "Media delivery is temporarily unavailable.", headers);
      }
    }
    if (new URL(request.url).pathname.startsWith("/internal/") && request.method === "POST") {
      if (!env.MEDIA) return reply(503, "Media storage is not configured.", headers);
      try {
        return await control(request, env, headers);
      } catch (error) {
        console.error("Media control operation failed:", error);
        return reply(502, "The media operation could not be completed.", headers);
      }
    }
    if (new URL(request.url).pathname !== "/stage" || request.method !== "PUT") return reply(404, "Not found.", headers);
    if (!env.MEDIA || typeof env.UPLOAD_PERMIT_SECRET !== "string" || env.UPLOAD_PERMIT_SECRET.length < 32) {
      console.error("Media staging is not configured.");
      return reply(503, "Media staging is not configured.", headers);
    }
    const claims = await verifyPermit(request.headers.get("X-Upload-Permit"), env.UPLOAD_PERMIT_SECRET, Math.floor(Date.now() / 1e3));
    if (!claims) return reply(401, "Invalid or expired upload permit.", headers);
    if (request.headers.get("Content-Type") !== claims.contentType || request.headers.get("Content-Length") !== String(claims.size) || !request.body) {
      return reply(400, "Upload does not match its permit.", headers);
    }
    const path = `staging/${claims.kind}/${claims.userId}/${claims.uploadId}/${claims.variant}`;
    try {
      const object = await env.MEDIA.put(path, request.body, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: claims.contentType }
      });
      if (!object) return reply(409, "This upload has already been used.", headers);
      return new Response(JSON.stringify({ uploaded: true }), {
        status: 201,
        headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    } catch (error) {
      console.error("Media staging upload failed:", error);
      return reply(502, "The media upload could not be stored.", headers);
    }
  }
};

// ../../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-mrKep5/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = index_default;

// ../../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-mrKep5/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
