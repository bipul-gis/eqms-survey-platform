import landmarkGeoJsonUrl from '../data/CCC_all_Landmark.geojson?url';

/** Resolved asset URL (content-hashed in production builds). */
export { landmarkGeoJsonUrl };

/** Avoid stale landmark reference GeoJSON after deploys (browser HTTP cache). */
export const landmarkGeoJsonFetchInit: RequestInit = { cache: 'no-store' };

export function fetchLandmarkGeoJson(): Promise<Response> {
  return fetch(landmarkGeoJsonUrl, landmarkGeoJsonFetchInit);
}
