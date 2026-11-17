package com.vynzosocial.app;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.app.NotificationManager;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import android.util.Base64;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;
import java.lang.ref.WeakReference;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;

@CapacitorPlugin(name = "VynzoPush", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class VynzoPushPlugin extends Plugin {
    private static volatile boolean foreground;
    private static WeakReference<VynzoPushPlugin> instance = new WeakReference<>(null);

    @Override
    public void load() {
        instance = new WeakReference<>(this);
        handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        foreground = true;
    }

    @Override
    protected void handleOnPause() {
        foreground = false;
        super.handleOnPause();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null || !VynzoMessagingService.ACTION_OPEN.equals(intent.getAction())) return;
        String kind = intent.getStringExtra(VynzoMessagingService.EXTRA_KIND);
        String id = intent.getStringExtra(VynzoMessagingService.EXTRA_ID);
        intent.setAction(Intent.ACTION_MAIN);
        if (!PushPayload.validId(id) ||
            !("message".equals(kind) || "voice_call".equals(kind) || "video_call".equals(kind))) return;
        if ("message".equals(kind)) NotificationManagerCompat.from(getContext()).cancel("message:" + id, 0);
        else VynzoMessagingService.cancelCall(getContext(), id);
        JSObject payload = new JSObject();
        payload.put("type", kind);
        payload.put("id", id);
        notifyListeners("notificationOpen", payload, true);
    }

    static boolean isForeground() {
        return foreground;
    }

    static void notifyRegistration(String installationId) {
        VynzoPushPlugin plugin = instance.get();
        if (plugin == null) return;
        JSObject payload = new JSObject();
        payload.put("installationId", installationId);
        plugin.notifyListeners("registration", payload, true);
    }

    @PluginMethod
    public void register(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permissionResult");
            return;
        }
        registerWithFirebase(call);
    }

    @PluginMethod
    public synchronized void getRegistration(PluginCall call) {
        SharedPreferences preferences = getContext().getSharedPreferences("vynzo_push", 0);
        String installationId = preferences.getString("installation_id", null);
        String deviceId = preferences.getString("device_id", null);
        String deviceSecret = preferences.getString("device_secret", null);
        if (deviceId == null || deviceSecret == null) {
            byte[] secret = new byte[32];
            new SecureRandom().nextBytes(secret);
            deviceId = UUID.randomUUID().toString();
            deviceSecret = Base64.encodeToString(secret, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
            if (!preferences.edit().putString("device_id", deviceId).putString("device_secret", deviceSecret).commit()) {
                call.reject("Could not save notification device credentials.");
                return;
            }
        }
        JSObject result = new JSObject();
        result.put("installationId", installationId);
        result.put("deviceId", deviceId);
        result.put("deviceSecret", deviceSecret);
        result.put("enabled", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        result.put("ownerId", preferences.getString("owner_id", null));
        call.resolve(result);
    }

    @PluginMethod
    public void syncUnreadNotifications(PluginCall call) {
        String owner = getContext().getSharedPreferences("vynzo_push", 0).getString("owner_id", null);
        String userId = call.getString("userId");
        JSONArray ids = call.getArray("readConversationIds");
        Long before = call.getLong("before");
        if (owner == null || !owner.equals(userId)) {
            call.reject("Notification account changed. Please sign in again.");
            return;
        }
        if (ids == null || before == null || before <= 0) {
            call.reject("Invalid unread notification state.");
            return;
        }
        Set<String> readIds = new HashSet<>();
        try {
            for (int i = 0; i < ids.length(); i++) {
                String id = ids.getString(i);
                if (!PushPayload.validId(id)) throw new JSONException("Invalid conversation.");
                readIds.add(id);
            }
        } catch (JSONException error) {
            call.reject("Invalid read conversation.", error);
            return;
        }
        NotificationManager manager = (NotificationManager) getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        long cutoff = Math.min(before, System.currentTimeMillis());
        for (StatusBarNotification notification : manager.getActiveNotifications()) {
            if (shouldClearMessageNotification(notification.getTag(), notification.getPostTime(), cutoff, readIds)) {
                manager.cancel(notification.getTag(), notification.getId());
            }
        }
        call.resolve();
    }

    static boolean shouldClearMessageNotification(String tag, long postedAt, long before, Set<String> readIds) {
        return tag != null && tag.startsWith("message:") && postedAt <= before
            && readIds.contains(tag.substring("message:".length()));
    }

    @PluginMethod
    public void setOwner(PluginCall call) {
        String userId = call.getString("userId");
        if (userId != null && !PushPayload.validId(userId)) {
            call.reject("Invalid notification account.");
            return;
        }
        SharedPreferences.Editor editor = getContext().getSharedPreferences("vynzo_push", 0).edit();
        if (userId == null) editor.remove("owner_id");
        else editor.putString("owner_id", userId);
        if (!editor.commit()) {
            call.reject("Could not save notification account.");
            return;
        }
        if (userId == null) NotificationManagerCompat.from(getContext()).cancelAll();
        call.resolve();
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("Notification permission was not granted.");
            return;
        }
        registerWithFirebase(call);
    }

    private void registerWithFirebase(PluginCall call) {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            call.reject("Notifications are disabled in Android settings.");
            return;
        }
        FirebaseMessaging.getInstance().register().addOnCompleteListener(task -> {
            if (!task.isSuccessful()) {
                call.reject("Could not register this device for notifications.", task.getException());
                return;
            }
            call.resolve();
        });
    }
}
