package com.vynzosocial.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class PushExpiryReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra(VynzoMessagingService.EXTRA_ID);
        if (PushPayload.validId(id)) VynzoMessagingService.cancelCall(context, id);
    }
}
