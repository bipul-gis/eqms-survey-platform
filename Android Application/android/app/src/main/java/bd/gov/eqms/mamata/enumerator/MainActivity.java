package bd.gov.eqms.mamata.enumerator;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

/**
 * EQMS Geosurvey launcher activity.
 *
 * Why we override onCreate: the web UI captures GPS via the standard
 * `navigator.geolocation.watchPosition` API. Inside an Android WebView, that
 * call goes to `WebChromeClient.onGeolocationPermissionsShowPrompt`, and the
 * Capacitor BridgeWebChromeClient grants it ONLY if the host app already
 * holds `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`. If those haven't
 * been granted yet, the prompt silently denies and the JS layer sees the
 * generic "Location permission denied" error — exactly what the enumerator
 * was reporting on the device.
 *
 * Solution: ask for the runtime permissions up-front on first launch so by
 * the time the user reaches the GPS-capture step, the WebView already has
 * what it needs. The OS will skip the dialog automatically on subsequent
 * launches once the user accepts.
 */
public class MainActivity extends BridgeActivity {

    private static final int LOCATION_PERMISSION_REQUEST = 1001;
    private static final long BACK_EXIT_WINDOW_MS = 2500;
    private long lastBackPressTime = 0L;
    private Toast backToast;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ensureLocationPermissions();
    }

    /**
     * Hardware back-button policy.
     *
     * 1. If the WebView has navigable history (a modal, drawer, sub-page, or
     *    form pushed a history entry), pop it so the user backs out of the
     *    current layer first — same behaviour as a browser tab.
     * 2. Once we're at the root of the SPA (nothing left to pop), implement
     *    a native "press back again to exit" pattern with a short Toast.
     *    The first press just shows the toast; a second press within
     *    BACK_EXIT_WINDOW_MS exits the app. This works on every screen
     *    (login, admin, enumerator) regardless of the React app's state,
     *    so the user never sees the app close abruptly on a single press.
     */
    @Override
    public void onBackPressed() {
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }

        long now = System.currentTimeMillis();
        if (now - lastBackPressTime < BACK_EXIT_WINDOW_MS) {
            if (backToast != null) {
                backToast.cancel();
            }
            super.onBackPressed();
            return;
        }
        lastBackPressTime = now;
        if (backToast != null) {
            backToast.cancel();
        }
        backToast = Toast.makeText(this, "Press back again to exit", Toast.LENGTH_SHORT);
        backToast.show();
    }

    private void ensureLocationPermissions() {
        boolean fineGranted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED;
        boolean coarseGranted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED;

        if (!fineGranted || !coarseGranted) {
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                    },
                    LOCATION_PERMISSION_REQUEST
            );
        }
    }
}
