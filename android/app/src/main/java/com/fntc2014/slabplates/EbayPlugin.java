package com.fntc2014.slabplates;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Talks to eBay for the listing panel.
 *
 *   status      - whether this build has eBay keys and whether an account is connected
 *   connect     - eBay's own sign-in page in a window inside the app; returns once access is granted
 *   disconnect  - forgets the account on this phone
 *   request     - one eBay API call (REST or Trading), signed here so the page never sees a token
 *   uploadImage - puts a JPG on eBay's picture service and returns its URL for a listing
 *   openUrl     - opens a link (a new listing, say) in the phone's browser
 *
 * The app's eBay keys come from the build (repository secrets). The account's tokens are kept in
 * this app's private storage on the phone and only ever sent to eBay.
 */
@CapacitorPlugin(name = "Ebay")
public class EbayPlugin extends Plugin {

    private static final String AUTH_URL = "https://auth.ebay.com/oauth2/authorize";
    private static final String TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
    private static final String TRADING_URL = "https://api.ebay.com/ws/api.dll";
    private static final String MEDIA_URL = "https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file";
    private static final String USER_URL = "https://apiz.ebay.com/commerce/identity/v1/user/";
    private static final String SCOPES =
        "https://api.ebay.com/oauth/api_scope "
        + "https://api.ebay.com/oauth/api_scope/sell.inventory "
        + "https://api.ebay.com/oauth/api_scope/sell.account.readonly "
        + "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly";
    private static final String APP_SCOPE = "https://api.ebay.com/oauth/api_scope";
    private static final String TRADING_LEVEL = "1477";
    private static final String TRADING_SITE = "2"; // eBay Canada (English)
    private static final String[] HOSTS = { "api.ebay.com", "apiz.ebay.com", "apim.ebay.com" };

    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private final Object tokenLock = new Object();
    private SharedPreferences prefs;
    private String appToken;
    private long appTokenExpiry;

    static class EbayException extends Exception {
        final int status;
        final String code;
        EbayException(String message, int status, String code) {
            super(message);
            this.status = status;
            this.code = code == null ? "" : code;
        }
    }

    static class Resp {
        int status;
        String body = "";
        String location;
    }

    @Override
    public void load() {
        prefs = getContext().getSharedPreferences("ebay", Activity.MODE_PRIVATE);
    }

    private static String clientId() { return BuildConfig.EBAY_CLIENT_ID; }
    private static String clientSecret() { return BuildConfig.EBAY_CLIENT_SECRET; }
    private static String ruName() { return BuildConfig.EBAY_RUNAME; }

    private static boolean configured() {
        return !clientId().isEmpty() && !clientSecret().isEmpty() && !ruName().isEmpty();
    }

    private boolean connected() {
        return prefs.getString("refresh", null) != null && prefs.getLong("refreshExpiry", 0) > System.currentTimeMillis();
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    /* ---------- account ---------- */

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("configured", configured());
        r.put("connected", configured() && connected());
        r.put("user", prefs.getString("user", ""));
        call.resolve(r);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (!configured()) {
            call.reject("This copy of the app doesn't have the eBay keys yet.", "NOT_CONFIGURED");
            return;
        }
        byte[] rnd = new byte[16];
        new SecureRandom().nextBytes(rnd);
        final String state = Base64.encodeToString(rnd, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        final String url = AUTH_URL + "?client_id=" + enc(clientId()) + "&redirect_uri=" + enc(ruName())
            + "&response_type=code&scope=" + enc(SCOPES) + "&state=" + enc(state);
        getActivity().runOnUiThread(() -> showSignIn(call, url, state));
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getContext().getResources().getDisplayMetrics()));
    }

    private void showSignIn(final PluginCall call, String url, final String state) {
        final Activity act = getActivity();
        final boolean[] done = { false };
        final Dialog dialog = new Dialog(act, android.R.style.Theme_DeviceDefault_Light_NoActionBar);

        LinearLayout root = new LinearLayout(act);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        root.setFitsSystemWindows(true);

        LinearLayout bar = new LinearLayout(act);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(16), dp(6), dp(6), dp(6));
        TextView title = new TextView(act);
        title.setText("Connect eBay");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        title.setTextColor(0xFF15181C);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button cancel = new Button(act, null, android.R.attr.borderlessButtonStyle);
        cancel.setText("Cancel");
        bar.addView(cancel, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final ProgressBar progress = new ProgressBar(act, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4)));

        final WebView web = new WebView(act);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            // eBay sends the browser to the accepted page with ?code=…, or to the declined page.
            // Either is caught here before it loads.
            private boolean intercept(Uri u) {
                if (done[0]) return true;
                if (u == null || !u.isHierarchical()) return false;
                String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
                boolean ebay = host.equals("ebay.com") || host.endsWith(".ebay.com") || host.endsWith(".ebay.ca") || host.equals("ebay.ca");
                String code = u.getQueryParameter("code");
                if (code != null && !code.isEmpty() && !ebay) {
                    done[0] = true;
                    dialog.dismiss();
                    if (!state.equals(u.getQueryParameter("state"))) {
                        call.reject("eBay's reply didn't match this sign-in. Try connecting again.", "STATE");
                    } else {
                        exchange(call, code);
                    }
                    return true;
                }
                if (host.equals("github.com") || host.endsWith(".github.io")) {
                    done[0] = true;
                    dialog.dismiss();
                    call.reject("eBay access wasn't granted.", "DECLINED");
                    return true;
                }
                return false;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.isForMainFrame() && intercept(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String u, Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
                if (u != null && intercept(Uri.parse(u))) view.stopLoading();
            }

            @Override
            public void onPageFinished(WebView view, String u) {
                progress.setVisibility(View.GONE);
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        dialog.setContentView(root);
        dialog.setOnDismissListener(d -> {
            try {
                web.stopLoading();
                web.destroy();
            } catch (Exception ignored) {
                // already gone
            }
            if (!done[0]) {
                done[0] = true;
                call.reject("Sign-in was cancelled.", "CANCELLED");
            }
        });
        cancel.setOnClickListener(v -> dialog.dismiss());
        dialog.show();
        web.loadUrl(url);
    }

    private void exchange(final PluginCall call, final String code) {
        io.execute(() -> {
            try {
                JSONObject t = tokenRequest("grant_type=authorization_code&code=" + enc(code) + "&redirect_uri=" + enc(ruName()));
                saveTokens(t);
                String user = "";
                try {
                    Map<String, String> h = new LinkedHashMap<>();
                    h.put("Authorization", "Bearer " + t.getString("access_token"));
                    h.put("Accept", "application/json");
                    Resp r = http("GET", USER_URL, h, null);
                    if (r.status == 200) user = new JSONObject(r.body).optString("username", "");
                } catch (Exception ignored) {
                    // the name is only for display
                }
                prefs.edit().putString("user", user).apply();
                JSObject res = new JSObject();
                res.put("connected", true);
                res.put("user", user);
                call.resolve(res);
            } catch (EbayException e) {
                call.reject("Couldn't finish connecting to eBay: " + e.getMessage(), e.code);
            } catch (Exception e) {
                call.reject("Couldn't reach eBay to finish connecting. Check your connection and try again.", "NETWORK");
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        synchronized (tokenLock) {
            prefs.edit().clear().apply();
        }
        try {
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
        } catch (Exception ignored) {
            // nothing to clear
        }
        call.resolve();
    }

    /* ---------- tokens ---------- */

    private JSONObject tokenRequest(String form) throws Exception {
        Map<String, String> h = new LinkedHashMap<>();
        String basic = Base64.encodeToString((clientId() + ":" + clientSecret()).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        h.put("Authorization", "Basic " + basic);
        h.put("Content-Type", "application/x-www-form-urlencoded");
        h.put("Accept", "application/json");
        Resp r = http("POST", TOKEN_URL, h, form.getBytes(StandardCharsets.UTF_8));
        JSONObject j;
        try {
            j = new JSONObject(r.body.isEmpty() ? "{}" : r.body);
        } catch (Exception e) {
            j = new JSONObject();
        }
        if (r.status != 200 || !j.has("access_token")) {
            String msg = j.optString("error_description", "");
            if (msg.isEmpty()) msg = j.optString("error", "eBay answered " + r.status + ".");
            throw new EbayException(msg, r.status, j.optString("error", "TOKEN"));
        }
        return j;
    }

    private void saveTokens(JSONObject t) throws Exception {
        long now = System.currentTimeMillis();
        SharedPreferences.Editor e = prefs.edit();
        e.putString("access", t.getString("access_token"));
        e.putLong("accessExpiry", now + Math.max(60, t.optLong("expires_in", 7200) - 300) * 1000L);
        if (t.has("refresh_token")) {
            e.putString("refresh", t.getString("refresh_token"));
            e.putLong("refreshExpiry", now + t.optLong("refresh_token_expires_in", 47304000L) * 1000L);
        }
        e.apply();
    }

    private String userToken(boolean forceRefresh) throws Exception {
        synchronized (tokenLock) {
            String a = prefs.getString("access", null);
            if (!forceRefresh && a != null && prefs.getLong("accessExpiry", 0) > System.currentTimeMillis()) return a;
            String rt = prefs.getString("refresh", null);
            if (rt == null || !connected()) throw new EbayException("Connect your eBay account first.", 401, "NOT_CONNECTED");
            try {
                JSONObject t = tokenRequest("grant_type=refresh_token&refresh_token=" + enc(rt) + "&scope=" + enc(SCOPES));
                saveTokens(t);
                return t.getString("access_token");
            } catch (EbayException ex) {
                if ("invalid_grant".equals(ex.code)) {
                    prefs.edit().remove("access").remove("refresh").remove("refreshExpiry").apply();
                    throw new EbayException("eBay has signed this app out. Connect your eBay account again.", 401, "NOT_CONNECTED");
                }
                throw ex;
            }
        }
    }

    private String applicationToken() throws Exception {
        synchronized (tokenLock) {
            if (appToken != null && appTokenExpiry > System.currentTimeMillis()) return appToken;
            JSONObject t = tokenRequest("grant_type=client_credentials&scope=" + enc(APP_SCOPE));
            appToken = t.getString("access_token");
            appTokenExpiry = System.currentTimeMillis() + Math.max(60, t.optLong("expires_in", 7200) - 300) * 1000L;
            return appToken;
        }
    }

    /* ---------- API calls ---------- */

    private static boolean allowed(String url) {
        try {
            URL u = new URL(url);
            if (!"https".equals(u.getProtocol())) return false;
            for (String h : HOSTS) if (h.equals(u.getHost())) return true;
        } catch (Exception ignored) {
            // not a URL
        }
        return false;
    }

    @PluginMethod
    public void request(final PluginCall call) {
        if (!configured()) {
            call.reject("This copy of the app doesn't have the eBay keys yet.", "NOT_CONFIGURED");
            return;
        }
        final String trading = call.getString("trading");
        final String method = trading != null ? "POST" : call.getString("method", "GET");
        final String url = trading != null ? TRADING_URL : call.getString("url", "");
        final String body = call.getString("body");
        final boolean app = Boolean.TRUE.equals(call.getBoolean("app", false));
        final JSObject extra = call.getObject("headers", new JSObject());
        if (!allowed(url)) {
            call.reject("That address isn't an eBay API.", "BAD_URL");
            return;
        }
        io.execute(() -> {
            try {
                Resp r = null;
                for (int attempt = 0; attempt < 2; attempt++) {
                    String token = app ? applicationToken() : userToken(attempt > 0);
                    Map<String, String> h = new LinkedHashMap<>();
                    if (extra != null) {
                        Iterator<String> keys = extra.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            if (!k.equalsIgnoreCase("Authorization") && !k.toUpperCase().startsWith("X-EBAY-API-IAF")) h.put(k, extra.getString(k));
                        }
                    }
                    if (trading != null) {
                        h.put("X-EBAY-API-CALL-NAME", trading);
                        h.put("X-EBAY-API-SITEID", TRADING_SITE);
                        h.put("X-EBAY-API-COMPATIBILITY-LEVEL", TRADING_LEVEL);
                        h.put("X-EBAY-API-IAF-TOKEN", token);
                        h.put("Content-Type", "text/xml; charset=utf-8");
                    } else {
                        h.put("Authorization", "Bearer " + token);
                        if (!h.containsKey("Accept")) h.put("Accept", "application/json");
                        if (body != null && !h.containsKey("Content-Type")) h.put("Content-Type", "application/json");
                    }
                    r = http(method, url, h, body == null ? null : body.getBytes(StandardCharsets.UTF_8));
                    boolean expired = trading != null
                        ? r.body.contains("<ErrorCode>21917053</ErrorCode>") || r.body.contains("<ErrorCode>932</ErrorCode>") || r.body.contains("<ErrorCode>931</ErrorCode>")
                        : r.status == 401;
                    if (!expired || app) break;
                }
                JSObject res = new JSObject();
                res.put("status", r.status);
                res.put("body", r.body);
                res.put("location", r.location == null ? "" : r.location);
                call.resolve(res);
            } catch (EbayException e) {
                call.reject(e.getMessage(), e.code);
            } catch (Exception e) {
                call.reject("Couldn't reach eBay. Check your connection and try again.", "NETWORK");
            }
        });
    }

    @PluginMethod
    public void uploadImage(final PluginCall call) {
        if (!configured()) {
            call.reject("This copy of the app doesn't have the eBay keys yet.", "NOT_CONFIGURED");
            return;
        }
        String data = call.getString("data", "");
        int comma = data.indexOf(',');
        if (data.startsWith("data:") && comma > 0) data = data.substring(comma + 1);
        final byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("There was no photo to upload.", "NO_IMAGE");
            return;
        }
        final String name = call.getString("filename", "photo.jpg").replaceAll("[^A-Za-z0-9._ -]", "_");
        io.execute(() -> {
            try {
                String boundary = "SlabPlates" + System.nanoTime();
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                b.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"" + name
                    + "\"\r\nContent-Type: image/jpeg\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                b.write(bytes);
                b.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
                byte[] payload = b.toByteArray();
                Resp r = null;
                for (int attempt = 0; attempt < 2; attempt++) {
                    Map<String, String> h = new LinkedHashMap<>();
                    h.put("Authorization", "Bearer " + userToken(attempt > 0));
                    h.put("Content-Type", "multipart/form-data; boundary=" + boundary);
                    h.put("Accept", "application/json");
                    r = http("POST", MEDIA_URL, h, payload);
                    if (r.status != 401) break;
                }
                if (r.status != 200 && r.status != 201) throw new EbayException(restError(r), r.status, "UPLOAD");
                String imageUrl = "";
                try {
                    imageUrl = new JSONObject(r.body).optString("imageUrl", "");
                } catch (Exception ignored) {
                    // empty body: look it up below
                }
                if (imageUrl.isEmpty() && r.location != null && allowed(r.location)) {
                    Map<String, String> h = new LinkedHashMap<>();
                    h.put("Authorization", "Bearer " + userToken(false));
                    h.put("Accept", "application/json");
                    Resp g = http("GET", r.location, h, null);
                    if (g.status == 200) imageUrl = new JSONObject(g.body).optString("imageUrl", "");
                }
                if (imageUrl.isEmpty()) throw new EbayException("eBay took the photo but didn't return its address.", r.status, "UPLOAD");
                JSObject res = new JSObject();
                res.put("imageUrl", imageUrl);
                res.put("imageId", r.location == null ? "" : r.location.substring(r.location.lastIndexOf('/') + 1));
                call.resolve(res);
            } catch (EbayException e) {
                call.reject("Photo upload failed: " + e.getMessage(), e.code);
            } catch (Exception e) {
                call.reject("Couldn't reach eBay to upload the photo. Check your connection and try again.", "NETWORK");
            }
        });
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) {
            call.reject("Only web links can be opened.", "BAD_URL");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No browser could open that link.", "NO_BROWSER");
        }
    }

    /* ---------- plumbing ---------- */

    private static String restError(Resp r) {
        try {
            JSONArray errs = new JSONObject(r.body).optJSONArray("errors");
            if (errs != null && errs.length() > 0) {
                JSONObject e = errs.getJSONObject(0);
                String m = e.optString("longMessage", "");
                return m.isEmpty() ? e.optString("message", "eBay answered " + r.status + ".") : m;
            }
        } catch (Exception ignored) {
            // not JSON
        }
        return "eBay answered " + r.status + ".";
    }

    private static Resp http(String method, String url, Map<String, String> headers, byte[] body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(20000);
            c.setReadTimeout(90000);
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
            if (body != null) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream o = c.getOutputStream()) {
                    o.write(body);
                }
            }
            Resp r = new Resp();
            r.status = c.getResponseCode();
            InputStream in = r.status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                try (InputStream s = in) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
                    r.body = new String(out.toByteArray(), StandardCharsets.UTF_8);
                }
            }
            r.location = c.getHeaderField("Location");
            return r;
        } finally {
            c.disconnect();
        }
    }
}
