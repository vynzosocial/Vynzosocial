package com.vynzosocial.app;

import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class CallEndStateTest {
    @Test
    public void suppressesOnlyUnexpiredEndedCalls() {
        Map<String, Object> records = new HashMap<>();
        records.put("call", 61_000L);
        assertTrue(CallEndState.isEnded(records, "call", 1_000));
        assertFalse(CallEndState.isEnded(records, "other", 1_000));
        assertFalse(CallEndState.isEnded(records, "call", 61_000));
        assertTrue(CallEndState.isExpired(records.get("call"), 61_000));
        assertTrue(CallEndState.isExpired("invalid", 1_000));
    }
}
