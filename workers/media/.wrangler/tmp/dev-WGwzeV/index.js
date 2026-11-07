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
  const headers = { "Vary": "Origin", "Access-Control-Allow-Methods": "PUT, OPTIONS", "Access-Control-Allow-Headers": "content-type, x-upload-permit" };
  if (ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
__name(cors, "cors");
function reply(status, message, headers) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
__name(reply, "reply");
var index_default = {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const headers = cors(origin);
    if (origin && !ORIGINS.has(origin)) return reply(403, "Origin is not allowed.", headers);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
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

// .wrangler/tmp/bundle-Mh0rYS/middleware-insertion-facade.js
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

// .wrangler/tmp/bundle-Mh0rYS/middleware-loader.entry.ts
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
