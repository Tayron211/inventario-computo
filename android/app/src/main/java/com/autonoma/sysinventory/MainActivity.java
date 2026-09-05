package com.autonoma.sysinventory;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.Display;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

public class MainActivity extends AppCompatActivity {

    private static final String TARGET_URL = "https://ivt.onrender.com/";
    private static final int FILE_CHOOSER_REQUEST_CODE = 1002;
    private static final int CAMERA_PERMISSION_REQUEST_CODE = 2001;
    private PermissionRequest pendingPermissionRequest;

    private WebView webView;
    private SwipeRefreshLayout swipeRefreshLayout;
    private ValueCallback<Uri[]> fileUploadCallback;
    private WindowInsetsControllerCompat insetsController;

    private android.widget.RelativeLayout splashOverlay;
    private android.widget.ImageView splashLogo;
    private TextView splashSubtitle;
    private ProgressBar splashLoading;
    private Button btnSplashRetry;
    private boolean isSplashDismissed = false;
    private boolean isCurrentThemeLight = false;
    private long splashStartTime = 0;
    private static final long MIN_SPLASH_TIME = 600;
    private static final long MAX_SPLASH_TIME = 3500;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        splashStartTime = System.currentTimeMillis();

        // 1. Integración Edge-to-Edge total: elimina la barra negra y la raya divisoria
        try {
            Window window = getWindow();
            WindowCompat.setDecorFitsSystemWindows(window, false);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
                window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                window.setStatusBarColor(Color.TRANSPARENT);
                window.setNavigationBarColor(Color.TRANSPARENT);
            }
        } catch (Exception ignored) {}

        // 2. Activar tasa de refresco ultra fluida a 120 Hz en pantallas compatibles
        setupHighRefreshRate();

        insetsController = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (insetsController != null) {
            // Inicialmente tema oscuro para coincidir con la splash screen
            insetsController.setAppearanceLightStatusBars(false);
            insetsController.setAppearanceLightNavigationBars(false);
        }

        setContentView(R.layout.activity_main);

        splashOverlay = findViewById(R.id.splashOverlay);
        splashLogo = findViewById(R.id.splashLogo);
        splashSubtitle = findViewById(R.id.splashSubtitle);
        splashLoading = findViewById(R.id.splashLoading);
        btnSplashRetry = findViewById(R.id.btnSplashRetry);
        TextView splashFooter = findViewById(R.id.splashFooter);
        if (splashFooter != null) {
            splashFooter.setText("v" + getAppVersionName());
        }

        if (btnSplashRetry != null) {
            btnSplashRetry.setOnClickListener(v -> {
                btnSplashRetry.setVisibility(View.GONE);
                if (splashLoading != null) splashLoading.setVisibility(View.VISIBLE);
                if (splashSubtitle != null) splashSubtitle.setText("Conectando...");
                if (webView != null) webView.loadUrl(TARGET_URL);
            });
        }

        swipeRefreshLayout = findViewById(R.id.swipeRefreshLayout);
        webView = findViewById(R.id.webView);

        // Animación de entrada suave del logo en la Splash Screen
        if (splashLogo != null) {
            splashLogo.setScaleX(0.85f);
            splashLogo.setScaleY(0.85f);
            splashLogo.setAlpha(0f);
            splashLogo.animate()
                    .scaleX(1.0f)
                    .scaleY(1.0f)
                    .alpha(1.0f)
                    .setDuration(400)
                    .setInterpolator(new android.view.animation.DecelerateInterpolator())
                    .start();
        }

        // Timer de seguridad infalible: despedir la splash screen a los 3.5 segundos máximo
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(this::dismissSplashScreen, MAX_SPLASH_TIME);

        // Configurar colores de la barra de actualización
        swipeRefreshLayout.setColorSchemeColors(
                ContextCompat.getColor(this, R.color.crimson_primary),
                ContextCompat.getColor(this, R.color.dark_bg)
        );

        setupWebView();

        swipeRefreshLayout.setOnRefreshListener(() -> {
            webView.reload();
        });

        // Solo activar SwipeRefresh cuando el WebView esté en el tope superior y NO haya ventana/modal abierto
        webView.getViewTreeObserver().addOnScrollChangedListener(() -> {
            if (webView.getScrollY() == 0 && !isModalOpen) {
                swipeRefreshLayout.setEnabled(true);
            } else {
                swipeRefreshLayout.setEnabled(false);
            }
        });

        swipeRefreshLayout.setOnChildScrollUpCallback((parent, child) -> {
            return isModalOpen || webView.getScrollY() > 0;
        });

        // Cargar la aplicación web en Render
        webView.loadUrl(TARGET_URL);
    }

    private boolean isModalOpen = false;

    /**
     * Activa el modo de 120 Hz / alta tasa de refresco si el panel del teléfono lo soporta
     */
    private void setupHighRefreshRate() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                Window window = getWindow();
                Display display = getWindowManager().getDefaultDisplay();
                Display.Mode[] modes = display.getSupportedModes();
                Display.Mode highestMode = null;
                float maxRate = 60.0f;
                for (Display.Mode mode : modes) {
                    if (mode.getRefreshRate() > maxRate) {
                        maxRate = mode.getRefreshRate();
                        highestMode = mode;
                    }
                }
                if (highestMode != null) {
                    WindowManager.LayoutParams params = window.getAttributes();
                    params.preferredDisplayModeId = highestMode.getModeId();
                    window.setAttributes(params);
                }
            } catch (Exception ignored) {}
        }
    }

    /**
     * Puente JavaScript para interactuar con la app nativa:
     * - Tema de la barra de estado
     * - Descarga directa del APK de actualización
     * - Control de swipe en ventanas/modales
     */
    public class AndroidBridgeInterface {
        @JavascriptInterface
        public void onThemeChanged(final boolean isLight, final String hexColor) {
            runOnUiThread(() -> updateStatusBarTheme(isLight));
        }

        @JavascriptInterface
        public void downloadApk(final String downloadUrl) {
            runOnUiThread(() -> triggerDownload(downloadUrl));
        }

        @JavascriptInterface
        public void setModalOpen(final boolean isOpen) {
            runOnUiThread(() -> {
                isModalOpen = isOpen;
                if (swipeRefreshLayout != null) {
                    swipeRefreshLayout.setEnabled(!isOpen);
                }
            });
        }

        @JavascriptInterface
        public void requestCameraPermission() {
            runOnUiThread(() -> {
                if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST_CODE);
                }
            });
        }

        @JavascriptInterface
        public boolean hasCameraPermission() {
            return ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void syncNow() {
            runOnUiThread(() -> {
                if (webView != null) {
                    webView.evaluateJavascript("if (typeof fetchInventory === 'function') fetchInventory(true);", null);
                }
            });
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            try {
                webView.resumeTimers();
                // Al desbloquear el teléfono o volver a la app, forzar actualización y revivir SSE
                webView.evaluateJavascript(
                    "if (typeof fetchInventory === 'function') { fetchInventory(true); } if (typeof initRealtimeSSE === 'function') { initRealtimeSSE(); }",
                    null
                );
            } catch (Exception ignored) {}
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            try {
                webView.pauseTimers();
            } catch (Exception ignored) {}
        }
    }

    private void dismissSplashScreen() {
        if (isSplashDismissed || isFinishing()) return;
        isSplashDismissed = true;

        if (splashOverlay != null) {
            splashOverlay.animate()
                    .alpha(0f)
                    .scaleX(1.04f)
                    .scaleY(1.04f)
                    .setDuration(340)
                    .setInterpolator(new android.view.animation.AccelerateDecelerateInterpolator())
                    .withEndAction(() -> {
                        splashOverlay.setVisibility(View.GONE);
                        int bgColor = isCurrentThemeLight ? Color.WHITE : Color.parseColor("#08080C");
                        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(bgColor));
                    })
                    .start();
        }
    }

    public void updateStatusBarTheme(boolean isLight) {
        isCurrentThemeLight = isLight;
        if (insetsController != null) {
            insetsController.setAppearanceLightStatusBars(isLight);
            insetsController.setAppearanceLightNavigationBars(isLight);
        }
        try {
            int bgColor = isLight ? Color.parseColor("#F8FAFC") : Color.parseColor("#08080C");
            getWindow().getDecorView().setBackgroundColor(bgColor);
            if (webView != null) {
                webView.setBackgroundColor(bgColor);
            }
        } catch (Exception ignored) {}
    }

    private String getAppVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "2.1.5";
        }
    }

    /**
     * Dispara la descarga del APK directamente a través del DownloadManager nativo de Android
     * para que aparezca en la barra de notificaciones y permita instalación inmediata.
     */
    public void triggerDownload(String url) {
        try {
            final String officialLatestUrl = "https://github.com/Tayron211/inventario-computo/releases/latest/download/SysInventory.apk";
            final String downloadUrl = (url != null && url.startsWith("http") && !url.contains("download-apk")) ? url : officialLatestUrl;

            // 1. Descarga nativa en segundo plano con notificación del sistema
            try {
                DownloadManager downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (downloadManager != null) {
                    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(downloadUrl));
                    String apkName = "SysInventory-v" + getAppVersionName() + ".apk";
                    request.setTitle("SysInventory v" + getAppVersionName());
                    request.setDescription("Descargando " + apkName + "...");
                    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, apkName);
                    request.setMimeType("application/vnd.android.package-archive");
                    downloadManager.enqueue(request);

                    Toast.makeText(this, "Descargando " + apkName + " en segundo plano. Mira tus notificaciones para instalarla.", Toast.LENGTH_LONG).show();
                    return;
                }
            } catch (Exception dmEx) {
                // Si DownloadManager tiene alguna restricción en el dispositivo, continuar con fallback
            }

            // 2. Fallback: Abrir en el navegador externo del sistema
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            Toast.makeText(this, "Iniciando descarga de la última versión...", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "No se pudo iniciar la descarga del APK", Toast.LENGTH_SHORT).show();
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Optimización de rendimiento para animaciones y transiciones ultra fluidas a 120 FPS
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            settings.setOffscreenPreRaster(true);
        }

        // Conectar puente de JavaScript para sincronización de tema y descargas
        webView.addJavascriptInterface(new AndroidBridgeInterface(), "AndroidBridge");

        // Escuchador de descargas nativo: permite descargar APKs directamente al tocarlos
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                triggerDownload(url);
            }
        });

        webView.setScrollBarStyle(View.SCROLLBARS_INSIDE_OVERLAY);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                return handleUrl(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }

            private boolean handleUrl(String url) {
                // Interceptar enlaces de descarga de APKs para abrirlos en el gestor de descargas
                if (url.endsWith(".apk") || url.contains("SysInventory.apk") || url.contains("/download-apk") || url.contains("/apk")) {
                    triggerDownload(url);
                    return true;
                }

                if (url.startsWith("tel:") || url.startsWith("mailto:") || url.startsWith("whatsapp:")) {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        startActivity(intent);
                        return true;
                    } catch (Exception e) {
                        return true;
                    }
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    if (btnSplashRetry != null) btnSplashRetry.setVisibility(View.VISIBLE);
                    if (splashLoading != null) splashLoading.setVisibility(View.GONE);
                    if (splashSubtitle != null) splashSubtitle.setText("Problema de conexión con el servidor");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                swipeRefreshLayout.setRefreshing(false);

                // Despedir la Splash Screen inmediatamente
                long elapsed = System.currentTimeMillis() - splashStartTime;
                long delay = Math.max(0, MIN_SPLASH_TIME - elapsed);
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(MainActivity.this::dismissSplashScreen, delay);

                // Sincronizar tema de barra de estado
                try {
                    view.evaluateJavascript(
                            "(function() { return (document.documentElement.getAttribute('data-theme') || 'dark') === 'light'; })()",
                            value -> {
                                if (value != null && value.contains("true")) {
                                    updateStatusBarTheme(true);
                                }
                            }
                    );
                } catch (Exception ignored) {}
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            // Otorgar permiso a la cámara bajo demanda (únicamente cuando el usuario abre el escáner)
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                MainActivity.this.runOnUiThread(() -> {
                    boolean needsCamera = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            needsCamera = true;
                            break;
                        }
                    }
                    if (needsCamera) {
                        if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        } else {
                            pendingPermissionRequest = request;
                            ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST_CODE);
                        }
                    } else {
                        request.grant(request.getResources());
                    }
                });
            }

            // Manejar selección de archivos / fotos
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }
                fileUploadCallback = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
                } catch (Exception e) {
                    fileUploadCallback = null;
                    Toast.makeText(MainActivity.this, "No se pudo abrir el selector de archivos", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST_CODE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                if (pendingPermissionRequest != null) {
                    runOnUiThread(() -> {
                        try {
                            pendingPermissionRequest.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        } catch (Exception ignored) {}
                        pendingPermissionRequest = null;
                    });
                }
                Toast.makeText(this, "Permiso de cámara concedido", Toast.LENGTH_SHORT).show();
            } else {
                if (pendingPermissionRequest != null) {
                    runOnUiThread(() -> {
                        try {
                            pendingPermissionRequest.deny();
                        } catch (Exception ignored) {}
                        pendingPermissionRequest = null;
                    });
                }
                Toast.makeText(this, "Se requiere permiso de cámara para escanear", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (fileUploadCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    String dataString = data.getDataString();
                    if (dataString != null) {
                        results = new Uri[]{Uri.parse(dataString)};
                    } else if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    }
                }
                fileUploadCallback.onReceiveValue(results);
                fileUploadCallback = null;
            }
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
