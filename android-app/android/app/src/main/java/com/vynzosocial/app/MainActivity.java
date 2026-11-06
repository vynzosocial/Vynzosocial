package com.vynzosocial.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
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
        keepContentInsideSystemBars();
    }

    // Android 15+ draws apps edge-to-edge; pad the web view so it never sits under system bars or the keyboard.
    private void keepContentInsideSystemBars() {
        View root = findViewById(android.R.id.content);
        root.setBackgroundColor(Color.parseColor("#0B0614"));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
        ViewCompat.requestApplyInsets(root);
    }
}
