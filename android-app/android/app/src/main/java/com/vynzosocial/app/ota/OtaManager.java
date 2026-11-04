package com.vynzosocial.app.ota;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.util.Base64;
import com.getcapacitor.plugin.WebView;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;

/**
 * Secure web-asset-only OTA updater. A bundle is installed only if the signed manifest
 * verifies against the embedded public key and the downloaded zip matches the signed
 * SHA-256. Bundles can never contain native code. New bundles are activated on the next
 * cold start and roll back automatically if the page never reports ready.
 */
public final class OtaManager {

    private static final String PREFS = "VynzoOta";
    private static final String K_ACTIVE = "active";
    private static final String K_PREVIOUS = "previous";
    private static final String K_STAGED = "staged";
    private static final String K_VERSION = "version";
    private static final String K_PREV_VERSION = "prevVersion";
    private static final String K_STAGED_VERSION = "stagedVersion";
    private static final String K_BAD_VERSION = "badVersion";
    private static final String K_TRIAL = "trial";
    private static final String K_ATTEMPTS = "attempts";
    private static final String K_BINARY = "binary";

    private static final int MAX_MANIFEST_BYTES = 64 * 1024;
    private static final long MAX_BUNDLE_BYTES = 150L * 1024 * 1024;
    private static final long MAX_UNPACKED_BYTES = 400L * 1024 * 1024;
    private static final int MAX_TRIAL_ATTEMPTS = 2;
    private static final String[] BLOCKED_EXTENSIONS = { ".apk", ".aab", ".dex", ".odex", ".vdex", ".jar", ".so", ".aar", ".sh", ".exe" };

    private static final Object LOCK = new Object();

    private OtaManager() {}

    public static File otaRoot(Context context) {
        return new File(context.getFilesDir(), "ota");
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static int binaryVersionCode(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return (int) androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(info);
        } catch (Exception e) {
            return 0;
        }
    }

    /** Called before the bridge starts: promotes a staged bundle, rolls back a failing one, and points Capacitor at the result. */
    public static void prepareOnLaunch(Context context) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(context);
            SharedPreferences.Editor e = p.edit();
            File root = otaRoot(context);

            int binary = binaryVersionCode(context);
            if (p.getInt(K_BINARY, -1) != binary) {
                // A new APK always ships its own web assets, so older OTA content is discarded.
                deleteRecursively(root);
                e.clear().putInt(K_BINARY, binary).apply();
                setCapacitorPath(context, "");
                return;
            }

            String active = p.getString(K_ACTIVE, "");
            String previous = p.getString(K_PREVIOUS, "");
            String staged = p.getString(K_STAGED, "");
            long version = p.getLong(K_VERSION, 0);
            long prevVersion = p.getLong(K_PREV_VERSION, 0);
            long stagedVersion = p.getLong(K_STAGED_VERSION, 0);
            boolean trial = p.getBoolean(K_TRIAL, false);
            int attempts = p.getInt(K_ATTEMPTS, 0);

            if (!staged.isEmpty() && new File(root, staged).isDirectory()) {
                previous = active;
                prevVersion = version;
                active = staged;
                version = stagedVersion;
                trial = true;
                attempts = 0;
                e.putString(K_STAGED, "").putLong(K_STAGED_VERSION, 0);
            }

            if (trial) {
                attempts++;
                if (attempts > MAX_TRIAL_ATTEMPTS) {
                    deleteRecursively(new File(root, active));
                    e.putLong(K_BAD_VERSION, version);
                    active = previous;
                    version = prevVersion;
                    previous = "";
                    prevVersion = 0;
                    trial = false;
                    attempts = 0;
                }
            }

            if (!active.isEmpty() && !new File(new File(root, active), "index.html").isFile()) {
                active = "";
                version = 0;
                trial = false;
                attempts = 0;
            }

            e.putString(K_ACTIVE, active)
                .putString(K_PREVIOUS, previous)
                .putLong(K_VERSION, version)
                .putLong(K_PREV_VERSION, prevVersion)
                .putBoolean(K_TRIAL, trial)
                .putInt(K_ATTEMPTS, attempts)
                .apply();

            setCapacitorPath(context, active.isEmpty() ? "" : new File(root, active).getAbsolutePath());
            cleanup(context);
        }
    }

    private static void setCapacitorPath(Context context, String path) {
        context
            .getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(WebView.CAP_SERVER_PATH, path)
            .apply();
    }

    /** The page loaded correctly: the trial bundle becomes permanent and the previous one is dropped. */
    public static void markReady(Context context) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(context);
            if (!p.getBoolean(K_TRIAL, false)) return;
            p.edit().putBoolean(K_TRIAL, false).putInt(K_ATTEMPTS, 0).putString(K_PREVIOUS, "").putLong(K_PREV_VERSION, 0).apply();
            cleanup(context);
        }
    }

    public static long currentVersion(Context context) {
        return prefs(context).getLong(K_VERSION, 0);
    }

    public static long stagedVersion(Context context) {
        return prefs(context).getLong(K_STAGED_VERSION, 0);
    }

    private static void cleanup(Context context) {
        SharedPreferences p = prefs(context);
        File[] children = otaRoot(context).listFiles();
        if (children == null) return;
        for (File child : children) {
            String name = child.getName();
            if (name.equals(p.getString(K_ACTIVE, "")) || name.equals(p.getString(K_PREVIOUS, "")) || name.equals(p.getString(K_STAGED, ""))) {
                continue;
            }
            deleteRecursively(child);
        }
    }

    public enum Result {
        DISABLED,
        UP_TO_DATE,
        STAGED,
        REJECTED,
        ERROR
    }

    /** Checks for, verifies and stages a newer bundle. Blocking: run off the main thread. */
    public static Result checkAndStage(Context context) {
        String manifestUrl = stringResource(context, "ota_manifest_url");
        String publicKey = stringResource(context, "ota_public_key");
        if (manifestUrl.isEmpty() || publicKey.isEmpty()) return Result.DISABLED;

        File tmpDir = null;
        File zipFile = null;
        try {
            URL manifestLocation = httpsUrl(manifestUrl);
            byte[] manifestBytes = download(manifestLocation, MAX_MANIFEST_BYTES);
            byte[] signature = Base64.decode(new String(download(httpsUrl(manifestUrl + ".sig"), 4096), "UTF-8").trim(), Base64.DEFAULT);
            if (!verifySignature(publicKey, manifestBytes, signature)) return Result.REJECTED;

            JSONObject manifest = new JSONObject(new String(manifestBytes, "UTF-8"));
            long version = manifest.getLong("version");
            long minBinary = manifest.optLong("minBinaryVersionCode", 0);
            String sha256 = manifest.getString("sha256").toLowerCase(Locale.ROOT);
            long size = manifest.getLong("size");
            URL bundleUrl = httpsUrl(new URL(manifestLocation, manifest.getString("bundle")).toString());

            SharedPreferences p = prefs(context);
            long known = Math.max(p.getLong(K_VERSION, 0), p.getLong(K_STAGED_VERSION, 0));
            if (version <= known || version == p.getLong(K_BAD_VERSION, -1)) return Result.UP_TO_DATE;
            if (minBinary > binaryVersionCode(context)) return Result.REJECTED;
            if (size <= 0 || size > MAX_BUNDLE_BYTES || !sha256.matches("[0-9a-f]{64}")) return Result.REJECTED;

            File root = otaRoot(context);
            if (!root.isDirectory() && !root.mkdirs()) return Result.ERROR;
            zipFile = new File(root, "download-" + version + ".zip");
            String actualHash = downloadToFile(bundleUrl, zipFile, size);
            if (!actualHash.equals(sha256)) return Result.REJECTED;

            tmpDir = new File(root, "tmp-" + version);
            deleteRecursively(tmpDir);
            if (!unzipSafely(zipFile, tmpDir)) return Result.REJECTED;

            File finalDir = new File(root, String.valueOf(version));
            deleteRecursively(finalDir);
            if (!tmpDir.renameTo(finalDir)) return Result.ERROR;
            tmpDir = null;

            synchronized (LOCK) {
                String oldStaged = p.getString(K_STAGED, "");
                p.edit().putString(K_STAGED, String.valueOf(version)).putLong(K_STAGED_VERSION, version).apply();
                if (!oldStaged.isEmpty() && !oldStaged.equals(String.valueOf(version))) {
                    deleteRecursively(new File(root, oldStaged));
                }
            }
            return Result.STAGED;
        } catch (Exception e) {
            return Result.ERROR;
        } finally {
            if (zipFile != null) zipFile.delete();
            if (tmpDir != null) deleteRecursively(tmpDir);
        }
    }

    private static String stringResource(Context context, String name) {
        int id = context.getResources().getIdentifier(name, "string", context.getPackageName());
        return id == 0 ? "" : context.getString(id).trim();
    }

    private static URL httpsUrl(String value) throws IOException {
        URL url = new URL(value);
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new IOException("HTTPS required");
        return url;
    }

    private static HttpURLConnection open(URL url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setInstanceFollowRedirects(true);
        connection.setUseCaches(false);
        connection.connect();
        if (connection.getResponseCode() != 200 || !"https".equalsIgnoreCase(connection.getURL().getProtocol())) {
            connection.disconnect();
            throw new IOException("Unexpected response");
        }
        return connection;
    }

    private static byte[] download(URL url, int maxBytes) throws IOException {
        HttpURLConnection connection = open(url);
        try (InputStream in = new BufferedInputStream(connection.getInputStream()); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                if (out.size() > maxBytes) throw new IOException("Too large");
            }
            return out.toByteArray();
        } finally {
            connection.disconnect();
        }
    }

    private static String downloadToFile(URL url, File target, long expectedSize) throws Exception {
        HttpURLConnection connection = open(url);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long total = 0;
        try (InputStream in = new BufferedInputStream(connection.getInputStream()); OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > expectedSize) throw new IOException("Larger than signed size");
                digest.update(buffer, 0, read);
                out.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }
        if (total != expectedSize) throw new IOException("Size mismatch");
        return toHex(digest.digest());
    }

    private static boolean verifySignature(String publicKeyBase64, byte[] data, byte[] signature) throws Exception {
        PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.decode(publicKeyBase64, Base64.DEFAULT)));
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(key);
        verifier.update(data);
        return verifier.verify(signature);
    }

    private static boolean unzipSafely(File zip, File destination) throws IOException {
        if (!destination.mkdirs()) return false;
        String basePath = destination.getCanonicalPath() + File.separator;
        long total = 0;
        boolean hasIndex = false;
        try (ZipInputStream in = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry entry;
            byte[] buffer = new byte[16384];
            while ((entry = in.getNextEntry()) != null) {
                String name = entry.getName();
                File out = new File(destination, name);
                if (!out.getCanonicalPath().startsWith(basePath)) return false;
                if (entry.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                String lower = name.toLowerCase(Locale.ROOT);
                for (String blocked : BLOCKED_EXTENSIONS) {
                    if (lower.endsWith(blocked)) return false;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return false;
                try (OutputStream os = new FileOutputStream(out)) {
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        total += read;
                        if (total > MAX_UNPACKED_BYTES) return false;
                        os.write(buffer, 0, read);
                    }
                }
                if (lower.equals("index.html")) hasIndex = true;
            }
        }
        return hasIndex;
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        file.delete();
    }
}
