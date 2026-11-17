package com.vynzosocial.app;

import java.util.Map;

final class CallEndState {
    static final long RETENTION_MS = 60_000;

    private CallEndState() {}

    static boolean isEnded(Map<String, ?> records, String callId, long now) {
        Object expiry = records.get(callId);
        return expiry instanceof Long && (Long) expiry > now;
    }

    static boolean isExpired(Object expiry, long now) {
        return !(expiry instanceof Long) || (Long) expiry <= now;
    }
}
