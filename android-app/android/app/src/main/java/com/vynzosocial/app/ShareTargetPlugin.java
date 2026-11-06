package com.vynzosocial.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Parcelable;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.UUID;

@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    private static final String CAPCUT_PACKAGE = "com.lemon.lvoverseas";
    private static final long MAX_BYTES = 50L * 1024 * 1024;
    private static final long STALE_MS = 24L * 60 * 60 * 1000;
    private static final String SHARE_DIR = "shared-videos";

    @Override
    public void load() {
        handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;

        final ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri single = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (single != null) uris.add(single);
        } else {
            ArrayList<Parcelable> items = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (items != null) {
                for (Parcelable item : items) {
                    if (item instanceof Uri) uris.add((Uri) item);
                }
            }
        }
        final String sharedType = intent.getType();
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        if (uris.isEmpty()) return;

        new Thread(() -> {
            JSArray files = new JSArray();
            JSArray errors = new JSArray();
            cleanStaleFiles();
            for (Uri uri : uris) {
                try {
                    files.put(copyToCache(uri, sharedType));
                } catch (Exception error) {
                    errors.put(error.getMessage() != null ? error.getMessage() : "Could not receive the shared video.");
                }
            }
            JSObject payload = new JSObject();
            payload.put("files", files);
            payload.put("errors", errors);
            notifyListeners("sharedVideo", payload, true);
        }, "vynzo-share-target").start();
    }

    private JSObject copyToCache(Uri uri, String fallbackType) throws Exception {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            throw new Exception("Only videos shared from other apps can be received.");
        }
        ContentResolver resolver = getContext().getContentResolver();
        String mimeType = resolver.getType(uri);
        if (mimeType == null) mimeType = fallbackType;
        if (mimeType == null || !mimeType.startsWith("video/")) {
            throw new Exception("That file is not a supported video.");
        }

        String name = "shared-video";
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                if (!cursor.isNull(0)) name = cursor.getString(0);
                if (!cursor.isNull(1) && cursor.getLong(1) > MAX_BYTES) {
                    throw new Exception("The video is larger than 50 MB. Export it at a lower quality and share it again.");
                }
            }
        }

        String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType);
        File dir = new File(getContext().getCacheDir(), SHARE_DIR);
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("Could not prepare storage for the video.");
        File target = new File(dir, UUID.randomUUID() + "." + (extension != null ? extension : "mp4"));

        long total = 0;
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new Exception("Could not read the shared video.");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > MAX_BYTES) {
                    throw new Exception("The video is larger than 50 MB. Export it at a lower quality and share it again.");
                }
                out.write(buffer, 0, read);
            }
        } catch (Exception error) {
            target.delete();
            throw error;
        }

        JSObject file = new JSObject();
        file.put("path", target.getAbsolutePath());
        file.put("name", name);
        file.put("mimeType", mimeType);
        file.put("size", total);
        return file;
    }

    private void cleanStaleFiles() {
        File[] old = new File(getContext().getCacheDir(), SHARE_DIR).listFiles();
        if (old == null) return;
        long cutoff = System.currentTimeMillis() - STALE_MS;
        for (File file : old) {
            if (file.lastModified() < cutoff) file.delete();
        }
    }

    private boolean capCutInstalled() {
        return getContext().getPackageManager().getLaunchIntentForPackage(CAPCUT_PACKAGE) != null;
    }

    @PluginMethod
    public void isCapCutInstalled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("installed", capCutInstalled());
        call.resolve(result);
    }

    @PluginMethod
    public void openCapCut(PluginCall call) {
        Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(CAPCUT_PACKAGE);
        JSObject result = new JSObject();
        if (launch == null) {
            result.put("installed", false);
            call.resolve(result);
            return;
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(launch);
        result.put("installed", true);
        call.resolve(result);
    }

    @PluginMethod
    public void editInCapCut(PluginCall call) {
        if (!capCutInstalled()) {
            JSObject result = new JSObject();
            result.put("installed", false);
            call.resolve(result);
            return;
        }
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.setType("video/*");
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(call, pick, "pickedForCapCut");
    }

    @ActivityCallback
    private void pickedForCapCut(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;
        if (uri == null) {
            call.reject("cancelled");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("video/*");
        send.setPackage(CAPCUT_PACKAGE);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.setClipData(ClipData.newRawUri("video", uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(send);
            JSObject ok = new JSObject();
            ok.put("installed", true);
            call.resolve(ok);
        } catch (Exception error) {
            call.reject("Could not open CapCut.");
        }
    }
}
