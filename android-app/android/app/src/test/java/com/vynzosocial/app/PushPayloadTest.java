package com.vynzosocial.app;

import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class PushPayloadTest {
    private final String id = "75bb349d-14a4-4a14-85c3-c36710292d43";

    private Map<String, String> data(String kind, String expiry) {
        Map<String, String> data = new HashMap<>();
        data.put("type", kind);
        data.put("id", id);
        if (expiry != null) data.put("expires_at", expiry);
        return data;
    }

    @Test
    public void acceptsPrivateMessagesAndCallEnd() {
        assertEquals("message", PushPayload.parse(data("message", null), 100).kind);
        assertEquals("call_end", PushPayload.parse(data("call_end", null), 100).kind);
    }

    @Test
    public void limitsCallRingingAndRejectsExpiredCalls() {
        assertEquals(900, PushPayload.parse(data("voice_call", "1000"), 100).remainingMs);
        assertEquals(45_000, PushPayload.parse(data("video_call", "100000"), 100).remainingMs);
        assertNull(PushPayload.parse(data("voice_call", "100"), 100));
        assertNull(PushPayload.parse(data("video_call", null), 100));
        assertNull(PushPayload.parse(data("voice_call", "invalid"), 100));
    }

    @Test
    public void rejectsUnknownKindsAndMalformedIds() {
        assertNull(PushPayload.parse(data("other", null), 100));
        Map<String, String> invalid = data("message", null);
        invalid.put("id", "1-1-1-1-1");
        assertNull(PushPayload.parse(invalid, 100));
        invalid.remove("id");
        assertNull(PushPayload.parse(invalid, 100));
    }

    @Test
    public void onlyAcceptsNotificationsForTheActiveAccount() {
        Map<String, String> message = data("message", null);
        message.put("user_id", id);
        assertTrue(PushPayload.isForOwner(message, id));
        assertFalse(PushPayload.isForOwner(message, null));
        assertFalse(PushPayload.isForOwner(message, "a53375ac-319a-4507-8cb8-4496b1060d0a"));
        message.remove("user_id");
        assertFalse(PushPayload.isForOwner(message, id));
    }
}
