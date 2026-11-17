package com.vynzosocial.app;

import java.util.Map;
import java.util.UUID;

final class PushPayload {
    private static final long MAX_RING_MS = 45_000;
    final String kind;
    final String id;
    final long remainingMs;

    private PushPayload(String kind, String id, long remainingMs) {
        this.kind = kind;
        this.id = id;
        this.remainingMs = remainingMs;
    }

    static PushPayload parse(Map<String, String> data, long now) {
        String kind = data.get("type");
        String id = data.get("id");
        if (!validId(id)) return null;
        if ("message".equals(kind) || "call_end".equals(kind)) return new PushPayload(kind, id, 0);
        if (!"voice_call".equals(kind) && !"video_call".equals(kind)) return null;
        try {
            long expiresAt = Long.parseLong(data.get("expires_at"));
            if (expiresAt <= now) return null;
            return new PushPayload(kind, id, Math.min(MAX_RING_MS, expiresAt - now));
        } catch (NumberFormatException error) {
            return null;
        }
    }

    static boolean validId(String id) {
        if (id == null) return false;
        try {
            return UUID.fromString(id).toString().equalsIgnoreCase(id);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    static boolean isForOwner(Map<String, String> data, String ownerId) {
        return validId(ownerId) && ownerId.equals(data.get("user_id"));
    }
}
