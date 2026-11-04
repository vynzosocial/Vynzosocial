package com.vynzosocial.app.ota;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Ota")
public class OtaPlugin extends Plugin {

    private static final long MIN_CHECK_INTERVAL_MS = 30 * 60 * 1000L;
    private volatile long lastCheck = 0;
    private volatile boolean checking = false;

    @Override
    public void load() {
        runCheck(null);
    }

    @Override
    protected void handleOnResume() {
        if (System.currentTimeMillis() - lastCheck > MIN_CHECK_INTERVAL_MS) runCheck(null);
    }

    private void runCheck(PluginCall call) {
        if (checking) {
            if (call != null) call.resolve(info("busy"));
            return;
        }
        checking = true;
        new Thread(() -> {
            OtaManager.Result result = OtaManager.checkAndStage(getContext());
            lastCheck = System.currentTimeMillis();
            checking = false;
            if (call != null) call.resolve(info(result.name().toLowerCase()));
        }, "vynzo-ota").start();
    }

    private JSObject info(String status) {
        JSObject o = new JSObject();
        o.put("status", status);
        o.put("version", OtaManager.currentVersion(getContext()));
        o.put("stagedVersion", OtaManager.stagedVersion(getContext()));
        return o;
    }

    @PluginMethod
    public void notifyReady(PluginCall call) {
        OtaManager.markReady(getContext());
        call.resolve();
    }

    @PluginMethod
    public void checkNow(PluginCall call) {
        runCheck(call);
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        call.resolve(info("info"));
    }
}
