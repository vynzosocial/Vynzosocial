package com.vynzosocial.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.vynzosocial.app.ota.OtaManager;
import com.vynzosocial.app.ota.OtaPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        OtaManager.prepareOnLaunch(this);
        registerPlugin(OtaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
