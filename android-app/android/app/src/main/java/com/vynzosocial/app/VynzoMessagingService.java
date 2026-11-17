package com.vynzosocial.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class VynzoMessagingService extends FirebaseMessagingService {
    static final String ACTION_OPEN = "com.vynzosocial.app.OPEN_PUSH";
    static final String EXTRA_KIND = "push_kind";
    static final String EXTRA_ID = "push_id";
    private static final String MESSAGE_CHANNEL = "vynzo_messages";
    private static final String CALL_CHANNEL = "vynzo_calls";

    @Override
    public void onRegistered(@NonNull String installationId) {
        getSharedPreferences("vynzo_push", MODE_PRIVATE).edit()
            .putString("installation_id", installationId).apply();
        VynzoPushPlugin.notifyRegistration(installationId);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        String owner = getSharedPreferences("vynzo_push", MODE_PRIVATE).getString("owner_id", null);
        if (!PushPayload.isForOwner(message.getData(), owner)) return;
        PushPayload payload = PushPayload.parse(message.getData(), System.currentTimeMillis());
        if (payload == null) return;
        if ("call_end".equals(payload.kind)) {
            rememberCallEnd(payload.id);
            cancelCall(this, payload.id);
            return;
        }
        if (!"message".equals(payload.kind) && callHasEnded(payload.id)) return;
        if (VynzoPushPlugin.isForeground()) return;
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;

        boolean call = !"message".equals(payload.kind);
        createChannels();
        Intent intent = new Intent(this, MainActivity.class).setAction(ACTION_OPEN)
            .setData(Uri.parse("vynzo://push/" + payload.kind + "/" + payload.id))
            .putExtra(EXTRA_KIND, payload.kind).putExtra(EXTRA_ID, payload.id)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, call ? CALL_CHANNEL : MESSAGE_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(getString(call
                ? ("video_call".equals(payload.kind) ? R.string.push_video_call : R.string.push_voice_call)
                : R.string.push_message_title))
            .setContentText(getString(call ? R.string.push_call_body : R.string.push_message_body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(call ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_HIGH)
            .setCategory(call ? NotificationCompat.CATEGORY_CALL : NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        if (call) builder.setTimeoutAfter(payload.remainingMs)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            .setVibrate(new long[] { 0, 800, 600, 800 });
        Notification notification = builder.build();
        if (call && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) notification.flags |= Notification.FLAG_INSISTENT;
        NotificationManagerCompat.from(this).notify((call ? "call:" : "message:") + payload.id, 0, notification);
        if (call && Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            AlarmManager alarm = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            alarm.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + payload.remainingMs, expiryIntent(this, payload.id));
        }
    }

    private void rememberCallEnd(String callId) {
        SharedPreferences prefs = getSharedPreferences("vynzo_ended_calls", MODE_PRIVATE);
        long now = System.currentTimeMillis();
        SharedPreferences.Editor editor = prefs.edit();
        for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            if (CallEndState.isExpired(entry.getValue(), now)) editor.remove(entry.getKey());
        }
        editor.putLong(callId, now + CallEndState.RETENTION_MS).apply();
    }

    private boolean callHasEnded(String callId) {
        return CallEndState.isEnded(getSharedPreferences("vynzo_ended_calls", MODE_PRIVATE).getAll(),
            callId, System.currentTimeMillis());
    }

    private static PendingIntent expiryIntent(Context context, String id) {
        Intent intent = new Intent(context, PushExpiryReceiver.class)
            .setData(Uri.parse("vynzo://push-expiry/" + id)).putExtra(EXTRA_ID, id);
        return PendingIntent.getBroadcast(context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void cancelCall(Context context, String id) {
        NotificationManagerCompat.from(context).cancel("call:" + id, 0);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            AlarmManager alarm = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            PendingIntent expiry = expiryIntent(context, id);
            alarm.cancel(expiry);
            expiry.cancel();
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel messages = new NotificationChannel(MESSAGE_CHANNEL,
            getString(R.string.push_messages_channel), NotificationManager.IMPORTANCE_HIGH);
        NotificationChannel calls = new NotificationChannel(CALL_CHANNEL,
            getString(R.string.push_calls_channel), NotificationManager.IMPORTANCE_HIGH);
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build());
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0, 800, 600, 800 });
        manager.createNotificationChannel(messages);
        manager.createNotificationChannel(calls);
    }
}
