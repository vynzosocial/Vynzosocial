package com.vynzosocial.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static final long MAX_APK_BYTES = 250L * 1024 * 1024;
    private boolean downloading;

    @PluginMethod
    public synchronized void install(PluginCall call) {
        String url = call.getString("url");
        String sha256 = call.getString("sha256");
        Integer build = call.getInt("build");
        if (url == null || !url.matches("https://vynzo-app-download\\.vynzolive\\.workers\\.dev/vynzo-android-[0-9]+\\.[0-9]+\\.apk")
            || sha256 == null || !sha256.matches("[a-f0-9]{64}") || build == null || build < 1) {
            call.reject("Invalid Android update information.");
            return;
        }
        if (downloading) {
            call.reject("An Android update is already downloading.");
            return;
        }
        try {
            PackageInfo installed = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            if (build <= PackageInfoCompat.getLongVersionCode(installed)) {
                call.reject("This Android update is not newer than the installed app.");
                return;
            }
        } catch (PackageManager.NameNotFoundException error) {
            call.reject("Could not check the installed app version.", error);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(settings);
                call.reject("Allow installs from VynzoSocial in Android settings, return to the app, and tap Update again.");
            } catch (ActivityNotFoundException | SecurityException error) {
                call.reject("Could not open Android installation settings.", error);
            }
            return;
        }
        downloading = true;
        new Thread(() -> downloadAndInstall(call, url, sha256, build), "vynzo-app-update").start();
    }

    private void downloadAndInstall(PluginCall call, String url, String expectedHash, int build) {
        File apk = new File(getContext().getCacheDir(), "android-update.apk");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                throw new IOException("Download failed (HTTP " + connection.getResponseCode() + ").");
            }
            long expectedLength = connection.getContentLengthLong();
            if (expectedLength > MAX_APK_BYTES) throw new IOException("The update is too large.");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long total = 0;
            int lastPercent = -1;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(apk)) {
                byte[] buffer = new byte[16384];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_APK_BYTES) throw new IOException("The update is too large.");
                    output.write(buffer, 0, count);
                    digest.update(buffer, 0, count);
                    if (expectedLength > 0) {
                        int percent = (int) Math.min(100, total * 100 / expectedLength);
                        if (percent != lastPercent) {
                            JSObject progress = new JSObject();
                            progress.put("percent", percent);
                            notifyListeners("progress", progress);
                            lastPercent = percent;
                        }
                    }
                }
            }
            StringBuilder hash = new StringBuilder();
            for (byte value : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            if (total == 0 || (expectedLength >= 0 && total != expectedLength) || !hash.toString().equals(expectedHash)) {
                throw new IOException("The downloaded update failed its integrity check.");
            }
            PackageInfo archive = getContext().getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
            if (archive == null || !getContext().getPackageName().equals(archive.packageName)
                || PackageInfoCompat.getLongVersionCode(archive) != build) {
                throw new IOException("The downloaded update has an unexpected app or version.");
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().runOnUiThread(() -> {
                try {
                    getActivity().startActivity(install);
                    call.resolve();
                } catch (ActivityNotFoundException | SecurityException error) {
                    call.reject("Could not open the Android installer: " + error.getMessage(), error);
                }
            });
        } catch (IOException | NoSuchAlgorithmException | IllegalArgumentException | ActivityNotFoundException | SecurityException error) {
            if (apk.exists() && !apk.delete()) android.util.Log.w("AppUpdate", "Could not delete the failed update download.");
            call.reject("Could not download or open the Android update: " + error.getMessage(), error);
        } finally {
            if (connection != null) connection.disconnect();
            synchronized (this) { downloading = false; }
        }
    }
}
