import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

interface GeoLocationContextType {
  location: { lat: number; lng: number; accuracy: number } | null;
  error: string | null;
  requestLocation: () => void;
}

const GeoLocationContext = createContext<GeoLocationContextType | undefined>(undefined);

export const GeoLocationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [location, setLocation] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watchId = useRef<string | number | null>(null);
  const native = Capacitor.isNativePlatform();

  const updateLocation = useCallback((pos: { coords: { latitude: number; longitude: number; accuracy: number } }) => {
    setLocation({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    });
    setError(null);
  }, []);

  const requestLocation = useCallback(() => {
    const locate = async () => {
      try {
        if (native) {
          let permission = await Geolocation.checkPermissions();
          if (permission.location !== 'granted') permission = await Geolocation.requestPermissions();
          if (permission.location !== 'granted') {
            setError('Location permission denied');
            return;
          }
          updateLocation(await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }));
          return;
        }

        if (!navigator.geolocation) {
          setError('Geolocation not supported');
          return;
        }
        navigator.geolocation.getCurrentPosition(
          updateLocation,
          (err) => setError(err.message),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to get current location');
      }
    };
    void locate();
  }, [native, updateLocation]);

  useEffect(() => {
    let cancelled = false;
    const startWatch = async () => {
      try {
        if (native) {
          let permission = await Geolocation.checkPermissions();
          if (permission.location !== 'granted') permission = await Geolocation.requestPermissions();
          if (permission.location !== 'granted' || cancelled) {
            if (!cancelled) setError('Location permission denied');
            return;
          }
          watchId.current = await Geolocation.watchPosition(
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
            (pos, err) => {
              if (cancelled) return;
              if (pos) updateLocation(pos);
              else if (err) setError(err.message || 'Unable to get current location');
            },
          );
          if (cancelled && typeof watchId.current === 'string') {
            await Geolocation.clearWatch({ id: watchId.current });
          }
          return;
        }

        if (!navigator.geolocation) {
          setError('Geolocation not supported');
          return;
        }
        watchId.current = navigator.geolocation.watchPosition(
          updateLocation,
          (err) => setError(err.message),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to watch current location');
      }
    };

    void startWatch();
    return () => {
      cancelled = true;
      if (typeof watchId.current === 'string') void Geolocation.clearWatch({ id: watchId.current });
      else if (typeof watchId.current === 'number' && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    };
  }, [native, updateLocation]);

  return (
    <GeoLocationContext.Provider value={{ location, error, requestLocation }}>
      {children}
    </GeoLocationContext.Provider>
  );
};

export const useGeoLocation = () => {
  const context = useContext(GeoLocationContext);
  if (!context) throw new Error('useGeoLocation must be used within GeoLocationProvider');
  return context;
};
