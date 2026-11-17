package com.vynzosocial.app;

import static org.junit.Assert.*;
import java.util.Set;
import org.junit.Test;

public class UnreadNotificationsTest {
    @Test
    public void clearsOnlyReadMessageNotificationsFromTheCheckedSnapshot() {
        Set<String> read = Set.of("read-chat");
        assertTrue(VynzoPushPlugin.shouldClearMessageNotification("message:read-chat", 100, 200, read));
        assertTrue(VynzoPushPlugin.shouldClearMessageNotification("message:read-chat", 200, 200, read));
        assertFalse(VynzoPushPlugin.shouldClearMessageNotification("message:unread-chat", 100, 200, read));
        assertFalse(VynzoPushPlugin.shouldClearMessageNotification("message:unknown-chat", 100, 200, read));
        assertFalse(VynzoPushPlugin.shouldClearMessageNotification("message:read-chat", 201, 200, read));
        assertFalse(VynzoPushPlugin.shouldClearMessageNotification("call:incoming-call", 100, 200, read));
        assertFalse(VynzoPushPlugin.shouldClearMessageNotification(null, 100, 200, read));
    }
}
