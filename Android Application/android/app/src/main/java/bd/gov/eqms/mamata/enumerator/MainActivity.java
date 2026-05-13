package bd.gov.eqms.mamata.enumerator;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ensureLocationPermissions();
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
