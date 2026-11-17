const userId = "c86cf40c-d629-4d7a-919f-4d2055498f90";
const itemId = "a4e777de-3d68-4f4e-9e7a-843f3229dabc";
const viewerId = "d86cf40c-d629-4d7a-919f-4d2055498f90";

function assertEqual(actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}`);
  }
}

function assertEmail(actual: string, expected: string) {
  if (actual !== expected) throw new Error("Login used an incorrect email");
}

Deno.test({
  name:
    "public preview endpoints hide inactive owners and fail closed on lookup errors",
  fn: async () => {
    const originalServe = Object.getOwnPropertyDescriptor(Deno, "serve")!;
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      url: Deno.env.get("SUPABASE_URL"),
      key: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
      anonKey: Deno.env.get("SUPABASE_ANON_KEY"),
      callSecret: Deno.env.get("CALL_LIFECYCLE_SECRET"),
      enabled: Deno.env.get("ACCOUNT_LIFECYCLE_ENABLED"),
      workerUrl: Deno.env.get("R2_MEDIA_WORKER_URL"),
      workerSecret: Deno.env.get("R2_MEDIA_CONTROL_SECRET"),
    };
    const handlers: Array<(request: Request) => Promise<Response>> = [];
    let state: string | null = null;
    let viewerState: string | null = null;
    let lifecycleError = false;
    let ownerReads = 0;
    let authenticated = false;
    let connectionMode: "none" | "mutual" | "incoming" = "none";
    let blockedMode = false;
    let liveMode = false;
    let blogsMode = false;
    let messagesMode = false;
    let viewOnceMode = false;
    let viewOnceClaims = 0;
    let viewOnceDeletes = 0;
    let messageInsertions = 0;
    let loginMode = false;
    let signedInUserId = userId;
    let loginEmail = "";
    let signOutCount = 0;
    let signOutError = false;
    let authLookupError = false;
    let reviewInterval: ReturnType<typeof setInterval> | undefined;
    try {
      Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");
      Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
      Deno.env.set("CALL_LIFECYCLE_SECRET", "s".repeat(32));
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "true");
      Deno.env.set("R2_MEDIA_WORKER_URL", "https://worker.example");
      Deno.env.set("R2_MEDIA_CONTROL_SECRET", "a".repeat(32));
      Object.defineProperty(Deno, "serve", {
        configurable: true,
        value: (handler: (request: Request) => Promise<Response>) =>
          handlers.push(handler),
      });
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        const table = url.pathname.split("/").pop();
        if (viewOnceMode && url.pathname.includes("/storage/v1/object/")) {
          if (init?.method === "DELETE") {
            viewOnceDeletes++;
            return Response.json([]);
          }
          return new Response("photo", {
            headers: { "Content-Type": "image/png" },
          });
        }
        if (loginMode && url.pathname === `/auth/v1/admin/users/${userId}`) {
          if (authLookupError) {
            return Response.json({ message: "Auth unavailable" }, {
              status: 503,
            });
          }
          return Response.json({ id: userId, email: "current@example.com" });
        }
        if (loginMode && url.pathname === "/auth/v1/token") {
          const body = JSON.parse(String(init?.body));
          loginEmail = body.email;
          const signedInUser = {
            id: signedInUserId,
            email: body.email,
            email_confirmed_at: "2026-01-01T00:00:00Z",
          };
          return Response.json({
            access_token: "mock-access-token",
            refresh_token: "mock-refresh-token",
            expires_in: 3600,
            token_type: "bearer",
            user: signedInUser,
          });
        }
        if (loginMode && url.pathname === "/auth/v1/logout") {
          signOutCount++;
          if (signOutError) {
            return Response.json({ message: "Auth unavailable" }, {
              status: 503,
            });
          }
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/auth/v1/user") {
          return Response.json({ id: viewerId });
        }
        if (url.pathname === "/rest/v1/rpc/consume_rate_limit") {
          return Response.json(true);
        }
        if (url.pathname === "/rest/v1/rpc/claim_view_once_message" && viewOnceMode) {
          if (state !== null || viewerState !== null) return Response.json([]);
          viewOnceClaims++;
          return Response.json([{ view_once_path: `${userId}/photo.png` }]);
        }
        if (table === "account_lifecycle") {
          if (
            authenticated &&
            url.searchParams.get("user_id") === `eq.${viewerId}`
          ) {
            return Response.json(
              viewerState === null ? null : { state: viewerState },
            );
          }
          return lifecycleError
            ? Response.json({ message: "database unavailable" }, {
              status: 500,
            })
            : Response.json(
              url.searchParams.get("user_id")?.startsWith("in.")
                ? (state === null ? [] : [{ user_id: userId }])
                : (state === null ? null : { state }),
            );
        }
        if (table === "blocks" && blockedMode) {
          return Response.json([{ blocked_id: userId }]);
        }
        if (table === "posts" || table === "stories") {
          const row = {
            id: itemId,
            user_id: userId,
            media_url: `r2://${
              table === "posts" ? "post" : "story"
            }/${userId}/${itemId}`,
            media_type: "image",
            privacy: "everyone",
            is_protected: false,
            expires_at: "2099-01-01T00:00:00Z",
            created_at: "2026-01-01T00:00:00Z",
          };
          return Response.json(
            authenticated ? [{ ...row, media_url: "/test-image" }] : row,
          );
        }
        if (table === "blog_articles") {
          const row = {
            id: itemId,
            title: "Title",
            cover_url: null,
            status: "published",
            author_id: userId,
            content_html: "<p>text</p>",
            content_text: "text",
            language: "en",
            tags: ["tag"],
            author: { username: "owner" },
            views_count: 0,
          };
          return Response.json(
            init?.method === "PATCH"
              ? []
              : url.searchParams.get("id")?.startsWith("eq.")
              ? row
              : blogsMode
              ? [row]
              : [],
          );
        }
        if (table === "blog_reports") return Response.json([]);
        if (table === "blog_bookmarks") {
          return Response.json(blogsMode ? [{ article_id: itemId }] : []);
        }
        if (messagesMode && table === "conversation_members") {
          const members = [viewerId, userId].map((id) => ({
            conversation_id: itemId,
            user_id: id,
            joined_at: "2026-01-01T00:00:00Z",
            hidden_senders: {},
          }));
          return Response.json(
            url.searchParams.has("user_id") ? [members[0]] : members,
          );
        }
        if (messagesMode && table === "conversations") {
          if (url.searchParams.get("select") === "is_group") {
            return Response.json({ is_group: true });
          }
          return Response.json([{
            id: itemId,
            is_group: false,
            created_at: "2026-01-01T00:00:00Z",
          }]);
        }
        if (messagesMode && table === "messages") {
          if (viewOnceMode) {
            if (init?.method === "PATCH") {
              if (url.searchParams.get("view_once") === "eq.true") {
                viewOnceClaims++;
                return Response.json({ view_once_path: `${userId}/photo.png` });
              }
              return Response.json([]);
            }
            return Response.json({ sender_id: userId });
          }
          const message = {
            id: itemId,
            conversation_id: itemId,
            sender_id: userId,
            content: "Kept message",
            media_url: null,
            view_once: false,
            created_at: "2026-01-01T00:00:00Z",
            reply_to_id: null,
          };
          if (init?.method === "POST") {
            messageInsertions++;
            return Response.json({
              ...message,
              sender_id: viewerId,
              content: "Reply",
              reply_to_id: itemId,
            });
          }
          if (url.searchParams.get("id") === `eq.${itemId}`) {
            return Response.json(message);
          }
          if (url.searchParams.get("id")?.startsWith("in.")) {
            return Response.json([message]);
          }
          return Response.json([message, {
            ...message,
            id: "c4e777de-3d68-4f4e-9e7a-843f3229dabc",
            sender_id: viewerId,
            content: "Reply",
            reply_to_id: itemId,
          }]);
        }
        if (table === "users") {
          ownerReads++;
          const owner = {
            id: userId,
            username: "owner",
            is_private: false,
            posts_privacy: "everyone",
          };
          if (loginMode) {
            return Response.json([{ ...owner, email: "old@example.com" }]);
          }
          if (messagesMode) {
            if (url.searchParams.get("id") === `eq.${viewerId}`) {
              return Response.json({
                username: "viewer",
                display_name: "Viewer",
                read_receipts: true,
              });
            }
            if (url.searchParams.get("id") === `eq.${userId}`) {
              return Response.json({ ...owner, display_name: "Owner" });
            }
            return Response.json([{
              ...owner,
              display_name: "Owner",
              avatar_url: "https://example.com/avatar.png",
              read_receipts: true,
            }, {
              id: viewerId,
              username: "viewer",
              display_name: "Viewer",
              read_receipts: true,
            }]);
          }
          if (
            authenticated && url.searchParams.get("id") === `eq.${viewerId}`
          ) return Response.json({ is_admin: false });
          return Response.json(authenticated ? [owner] : owner);
        }
        if (table === "follows") {
          const outgoing =
            url.searchParams.get("follower_id") === `eq.${viewerId}`;
          const rows = connectionMode === "none" ||
              (connectionMode === "incoming" && outgoing)
            ? []
            : [{
              follower_id: userId,
              following_id: userId,
              status: "accepted",
              created_at: "2026-01-01T00:00:00Z",
            }];
          return Response.json(rows);
        }
        if (table === "live_sessions") {
          return Response.json(
            liveMode && init?.method !== "DELETE"
              ? [{
                id: itemId,
                host_id: userId,
                title: "Live",
                visibility: "public",
                viewer_count: 1,
              }]
              : [],
          );
        }
        if (
          [
            "blocks",
            "likes",
            "story_likes",
            "story_comments",
            "blog_likes",
            "blog_comments",
          ].includes(table || "")
        ) return Response.json([]);
        if (
          url.origin === "https://worker.example" &&
          url.pathname === "/internal/read"
        ) {
          return new Response("image", {
            headers: { "Content-Type": "image/png" },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      };
      await import("../supabase/functions/public-share-media/index.ts");
      await import("../supabase/functions/blog-preview/index.ts");
      reviewInterval =
        (await import("../supabase/functions/vynzo-api/index.ts"))
          .blogAutoReviewInterval;
      const cases = [
        {
          handler: 0,
          request: new Request(
            `https://example.com/?kind=post&id=${itemId}&type=image`,
          ),
        },
        {
          handler: 0,
          request: new Request(
            `https://example.com/?kind=story&id=${itemId}&type=image`,
          ),
        },
        {
          handler: 1,
          request: new Request(`https://example.com/?id=${itemId}`),
        },
        {
          handler: 1,
          request: new Request(`https://example.com/?id=${itemId}&full=1`),
        },
        {
          handler: 1,
          request: new Request(`https://example.com/?id=${itemId}&image=1`),
        },
        {
          handler: 2,
          request: new Request(
            `https://example.com/api/media/public-preview?kind=post&id=${itemId}`,
          ),
        },
        {
          handler: 2,
          request: new Request(
            `https://example.com/api/media/public-preview?kind=story&id=${itemId}`,
          ),
        },
      ];
      assertEqual(handlers.length, 3);
      const participantStatus = (secret: string, userIds: unknown) =>
        handlers[2](new Request(
          "https://example.com/api/calls/participant-status",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Call-Lifecycle": secret,
            },
            body: JSON.stringify({ userIds }),
          },
        ));
      assertEqual((await participantStatus("wrong", [userId])).status, 401);
      assertEqual((await participantStatus("s".repeat(32), ["invalid"])).status, 400);
      assertEqual((await participantStatus("s".repeat(32), [userId, userId])).status, 400);
      state = "deactivated";
      const participantResponse = await participantStatus("s".repeat(32), [userId]);
      assertEqual(participantResponse.status, 200);
      if ((await participantResponse.json()).inactiveIds[0] !== userId) {
        throw new Error("Inactive call participant was not identified");
      }
      lifecycleError = true;
      assertEqual((await participantStatus("s".repeat(32), [userId])).status, 500);
      lifecycleError = false;
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "false");
      assertEqual((await participantStatus("s".repeat(32), [userId])).status, 503);
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "true");
      loginMode = true;
      state = null;
      const login = (identifier: string) => handlers[2](new Request(
        "https://example.com/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier, password: "example-password" }),
        },
      ));
      for (const identifier of ["owner", "+15555555555"]) {
        const response = await login(identifier);
        assertEqual(response.status, 200);
        assertEmail(loginEmail, "current@example.com");
      }
      signedInUserId = viewerId;
      const mismatchedLogin = await login("owner");
      assertEqual(mismatchedLogin.status, 401);
      assertEqual(signOutCount, 1);
      signOutError = true;
      assertEqual((await login("owner")).status, 500);
      signOutError = false;
      signedInUserId = userId;
      for (const blockedState of ["deactivating", "deleting"]) {
        state = blockedState;
        const previousSignOuts = signOutCount;
        assertEqual((await login("owner")).status, 403);
        assertEqual(signOutCount, previousSignOuts + 1);
      }
      state = null;
      assertEqual((await login("current@example.com")).status, 200);
      assertEmail(loginEmail, "current@example.com");
      authLookupError = true;
      assertEqual((await login("owner")).status, 500);
      authLookupError = false;
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "false");
      const oldLogin = await login("owner");
      assertEqual(oldLogin.status, 200);
      assertEmail(loginEmail, "old@example.com");
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "true");
      loginMode = false;
      for (const { handler, request } of cases) {
        for (const inactive of ["deactivating", "deactivated", "deleting"]) {
          state = inactive;
          ownerReads = 0;
          assertEqual((await handlers[handler](request)).status, 404);
          assertEqual(ownerReads, 0);
        }
        lifecycleError = true;
        ownerReads = 0;
        assertEqual(
          (await handlers[handler](request)).status,
          handler === 2 ? 500 : 503,
        );
        assertEqual(ownerReads, 0);
        lifecycleError = false;
        state = null;
        const activeStatus = new URL(request.url).searchParams.has("image")
          ? 404
          : 200;
        assertEqual((await handlers[handler](request)).status, activeStatus);
        assertEqual(ownerReads, 1);
        Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "false");
        state = "deactivated";
        ownerReads = 0;
        assertEqual((await handlers[handler](request)).status, activeStatus);
        assertEqual(ownerReads, 1);
        Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "true");
      }
      authenticated = true;
      const api = handlers[2];
      let sessionResponse = await api(
        new Request("https://example.com/api/calls/session", {
          headers: { Authorization: "Bearer test-token" },
        }),
      );
      assertEqual(sessionResponse.status, 200);
      if ((await sessionResponse.json()).userId !== viewerId) {
        throw new Error("Wrong call session identity");
      }
      for (const inactive of ["deactivating", "deactivated", "deleting"]) {
        viewerState = inactive;
        sessionResponse = await api(
          new Request("https://example.com/api/calls/session", {
            headers: { Authorization: "Bearer test-token" },
          }),
        );
        assertEqual(sessionResponse.status, 401);
      }
      viewerState = null;
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "false");
      sessionResponse = await api(
        new Request("https://example.com/api/calls/session", {
          headers: { Authorization: "Bearer test-token" },
        }),
      );
      assertEqual(sessionResponse.status, 503);
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "true");
      for (
        const [path, key] of [["posts/feed?scope=all", "posts"], [
          "stories?scope=all",
          "usersWithStories",
        ]]
      ) {
        const request = new Request(`https://example.com/api/${path}`, {
          headers: { Authorization: "Bearer test-token" },
        });
        for (const inactive of ["deactivating", "deactivated", "deleting"]) {
          state = inactive;
          const response = await api(request);
          assertEqual(response.status, 200);
          assertEqual((await response.json())[key].length, 0);
        }
        state = null;
        let response = await api(request);
        assertEqual(response.status, 200);
        assertEqual((await response.json())[key].length, 1);
        lifecycleError = true;
        response = await api(request);
        assertEqual(response.status, 500);
        lifecycleError = false;
        Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "false");
        state = "deactivated";
        response = await api(request);
        assertEqual(response.status, 200);
        assertEqual((await response.json())[key].length, 1);
        Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "true");
      }
      state = "deactivated";
      ownerReads = 0;
      const profile = await api(
        new Request(`https://example.com/api/users/${userId}/profile`, {
          headers: { Authorization: "Bearer test-token" },
        }),
      );
      assertEqual(profile.status, 404);
      assertEqual(ownerReads, 0);
      const follow = await api(
        new Request(`https://example.com/api/users/${userId}/follow`, {
          method: "POST",
          headers: { Authorization: "Bearer test-token" },
        }),
      );
      assertEqual(follow.status, 404);
      const callInvite = await api(
        new Request("https://example.com/api/calls/authorize-invite", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ targetId: userId }),
        }),
      );
      assertEqual(callInvite.status, 404);
      const conversation = await api(
        new Request("https://example.com/api/messages/conversations", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ recipientId: userId }),
        }),
      );
      assertEqual(conversation.status, 403);
      messagesMode = true;
      const messageRequests = [
        new Request("https://example.com/api/messages", {
          headers: { Authorization: ["Bearer", "test-token"].join(" ") },
        }),
        new Request(`https://example.com/api/messages/${itemId}/messages`, {
          headers: { Authorization: ["Bearer", "test-token"].join(" ") },
        }),
      ];
      for (const inactive of [null, "deactivating", "deactivated", "deleting"]) {
        state = inactive;
        const listResponse = await api(messageRequests[0]);
        assertEqual(listResponse.status, 200);
        const list = (await listResponse.json()).conversations;
        assertEqual(list.length, 1);
        if (list[0].last_message.content !== "Kept message") {
          throw new Error("Existing conversation message was not preserved");
        }
        if (list[0].other_username !== (inactive ? null : "owner")) {
          throw new Error("Conversation peer visibility is incorrect");
        }
        const detailResponse = await api(messageRequests[1]);
        assertEqual(detailResponse.status, 200);
        const detail = await detailResponse.json();
        if (detail.messages[0].content !== "Kept message" ||
          detail.messages[0].sender_username !== (inactive ? undefined : "owner") ||
          detail.members[1].username !== (inactive ? undefined : "owner") ||
          detail.messages[1].reply_to.sender_name !== (inactive ? "Unknown" : "Owner") ||
          detail.messages[1].reply_to.text !== "Kept message") {
          throw new Error("Message or sender visibility is incorrect");
        }
      }
      lifecycleError = true;
      for (const request of messageRequests) {
        assertEqual((await api(request)).status, 500);
      }
      lifecycleError = false;
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "false");
      state = "deactivated";
      const legacyMessages = await api(messageRequests[1]);
      assertEqual(legacyMessages.status, 200);
      if ((await legacyMessages.json()).messages[0].sender_username !== "owner") {
        throw new Error("Disabled lifecycle flag changed message behavior");
      }
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "true");
      for (const inactive of [null, "deactivated"]) {
        state = inactive;
        const reply = await api(new Request(
          `https://example.com/api/messages/${itemId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: ["Bearer", "test-token"].join(" "),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ content: "Reply", reply_to_id: itemId }),
          },
        ));
        assertEqual(reply.status, 201);
        const preview = (await reply.json()).message.reply_to;
        if (preview.sender_name !== (inactive ? "Unknown" : "Owner") ||
          preview.text !== "Kept message") {
          throw new Error("Sent reply preview visibility is incorrect");
        }
      }
      lifecycleError = true;
      const countBeforeFailure = messageInsertions;
      const failedReply = await api(new Request(
        `https://example.com/api/messages/${itemId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: ["Bearer", "test-token"].join(" "),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Reply", reply_to_id: itemId }),
        },
      ));
      assertEqual(failedReply.status, 500);
      assertEqual(messageInsertions, countBeforeFailure);
      lifecycleError = false;
      messagesMode = false;
      messagesMode = true;
      viewOnceMode = true;
      const openViewOnce = () => api(new Request(
        `https://example.com/api/messages/${itemId}/messages/${itemId}/view-once`,
        {
          method: "POST",
          headers: { Authorization: ["Bearer", "test-token"].join(" ") },
        },
      ));
      for (const inactive of ["deactivating", "deactivated", "deleting"]) {
        state = inactive;
        const unavailable = await openViewOnce();
        assertEqual(unavailable.status, 423);
        if ((await unavailable.json()).code !== "view_once_temporarily_unavailable") {
          throw new Error("Missing temporary unavailability code");
        }
        assertEqual(viewOnceClaims, 0);
        assertEqual(viewOnceDeletes, 0);
      }
      lifecycleError = true;
      assertEqual((await openViewOnce()).status, 500);
      assertEqual(viewOnceClaims, 0);
      assertEqual(viewOnceDeletes, 0);
      lifecycleError = false;
      state = null;
      assertEqual((await openViewOnce()).status, 200);
      assertEqual(viewOnceClaims, 1);
      assertEqual(viewOnceDeletes, 1);
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "false");
      state = "deactivated";
      assertEqual((await openViewOnce()).status, 200);
      assertEqual(viewOnceClaims, 2);
      assertEqual(viewOnceDeletes, 2);
      Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "true");
      viewOnceMode = false;
      messagesMode = false;
      const block = await api(
        new Request(`https://example.com/api/moderation/block/${userId}`, {
          method: "POST",
          headers: { Authorization: "Bearer test-token" },
        }),
      );
      assertEqual(block.status, 404);
      blockedMode = true;
      const blockList = new Request(
        "https://example.com/api/moderation/blocks",
        {
          headers: { Authorization: "Bearer test-token" },
        },
      );
      let blockedResponse = await api(blockList);
      assertEqual(blockedResponse.status, 200);
      assertEqual((await blockedResponse.json()).users.length, 0);
      state = null;
      blockedResponse = await api(blockList);
      assertEqual(blockedResponse.status, 200);
      assertEqual((await blockedResponse.json()).users.length, 1);
      blockedMode = false;
      state = "deactivated";
      const search = new Request(
        "https://example.com/api/users/search?q=owner",
        { headers: { Authorization: "Bearer test-token" } },
      );
      let response = await api(search);
      assertEqual(response.status, 200);
      assertEqual((await response.json()).users.length, 0);
      state = null;
      response = await api(search);
      assertEqual(response.status, 200);
      assertEqual((await response.json()).users.length, 1);
      lifecycleError = true;
      response = await api(search);
      assertEqual(response.status, 500);
      lifecycleError = false;
      for (
        const [path, key, mode] of [
          ["users/friends", "friends", "mutual"],
          ["users/connections?type=followers", "users", "mutual"],
          ["users/follow-requests", "requests", "incoming"],
        ] as const
      ) {
        connectionMode = mode;
        const request = new Request(`https://example.com/api/${path}`, {
          headers: { Authorization: "Bearer test-token" },
        });
        state = "deactivated";
        response = await api(request);
        assertEqual(response.status, 200);
        assertEqual((await response.json())[key].length, 0);
        state = null;
        response = await api(request);
        assertEqual(response.status, 200);
        assertEqual((await response.json())[key].length, 1);
        lifecycleError = true;
        response = await api(request);
        assertEqual(response.status, 500);
        lifecycleError = false;
      }
      liveMode = true;
      for (const token of [false, true]) {
        const request = new Request("https://example.com/api/live", {
          headers: token ? { Authorization: "Bearer test-token" } : {},
        });
        state = "deactivated";
        response = await api(request);
        assertEqual(response.status, 200);
        assertEqual((await response.json()).liveStreams.length, 0);
        state = null;
        response = await api(request);
        assertEqual(response.status, 200);
        assertEqual((await response.json()).liveStreams.length, 1);
        lifecycleError = true;
        response = await api(request);
        assertEqual(response.status, 500);
        lifecycleError = false;
      }
      liveMode = false;
      blogsMode = true;
      for (
        const [path, key] of [
          ["blogs", "articles"],
          ["blogs/tags/trending", "tags"],
          ["blogs/bookmarks", "articles"],
        ]
      ) {
        const request = new Request(`https://example.com/api/${path}`, {
          headers: { Authorization: "Bearer test-token" },
        });
        state = "deactivated";
        response = await api(request);
        assertEqual(response.status, 200);
        assertEqual((await response.json())[key].length, 0);
        state = null;
        response = await api(request);
        assertEqual(response.status, 200);
        assertEqual((await response.json())[key].length, 1);
        lifecycleError = true;
        response = await api(request);
        assertEqual(response.status, 500);
        lifecycleError = false;
        Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "false");
        state = "deactivated";
        response = await api(request);
        assertEqual(response.status, 200);
        assertEqual((await response.json())[key].length, 1);
        Deno.env.set("ACCOUNT_LIFECYCLE_ENABLED", "true");
      }
      state = "deactivated";
      for (const path of [`blogs/${itemId}`, `blogs/authors/${userId}`]) {
        response = await api(
          new Request(`https://example.com/api/${path}`, {
            headers: { Authorization: "Bearer test-token" },
          }),
        );
        assertEqual(response.status, 404);
      }
      for (const action of ["like", "bookmark", "share", "comments"]) {
        response = await api(
          new Request(`https://example.com/api/blogs/${itemId}/${action}`, {
            method: action === "comments" ? "GET" : "POST",
            headers: { Authorization: "Bearer test-token" },
          }),
        );
        assertEqual(response.status, 404);
      }
      state = null;
      response = await api(
        new Request(`https://example.com/api/blogs/${itemId}`, {
          headers: { Authorization: "Bearer test-token" },
        }),
      );
      assertEqual(response.status, 200);
      response = await api(
        new Request(`https://example.com/api/blogs/${itemId}/comments`, {
          headers: { Authorization: "Bearer test-token" },
        }),
      );
      assertEqual(response.status, 200);
    } finally {
      if (reviewInterval !== undefined) clearInterval(reviewInterval);
      globalThis.fetch = originalFetch;
      Object.defineProperty(Deno, "serve", originalServe);
      for (
        const [name, value] of Object.entries({
          SUPABASE_URL: originalEnv.url,
          SUPABASE_SERVICE_ROLE_KEY: originalEnv.key,
          SUPABASE_ANON_KEY: originalEnv.anonKey,
          CALL_LIFECYCLE_SECRET: originalEnv.callSecret,
          ACCOUNT_LIFECYCLE_ENABLED: originalEnv.enabled,
          R2_MEDIA_WORKER_URL: originalEnv.workerUrl,
          R2_MEDIA_CONTROL_SECRET: originalEnv.workerSecret,
        })
      ) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  },
});
