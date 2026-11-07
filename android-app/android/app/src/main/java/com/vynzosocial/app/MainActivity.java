package com.vynzosocial.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.vynzosocial.app.ota.OtaManager;
import com.vynzosocial.app.ota.OtaPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        OtaManager.prepareOnLaunch(this);
        registerPlugin(ScreenGuardPlugin.class);
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(PasswordManagerPlugin.class);
        registerPlugin(OtaPlugin.class);
        super.onCreate(savedInstanceState);
        styleSystemBars();
    }

    private void styleSystemBars() {
        View root = findViewById(android.R.id.content);
        root.setBackgroundColor(Color.parseColor("#0B0614"));
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
    }
}
