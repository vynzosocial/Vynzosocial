package com.vynzo.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenGuardPlugin.class);
        registerPlugin(ShareTargetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
