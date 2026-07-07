import { useEffect, useState } from 'react';
import { geosurveyApi } from '../lib/geosurveyApi';

export function useFirestoreCollection<T>(collectionPath: string) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        let items: T[] = [];
        if (collectionPath === 'users') {
          const res = await geosurveyApi.listUsers();
          items = res.items as T[];
        } else if (collectionPath === 'questionnaires') {
          const res = await geosurveyApi.listQuestionnaires();
          items = res.items as T[];
        } else if (collectionPath === 'questionnaireResponses') {
          const res = await geosurveyApi.listResponses();
          items = res.items as T[];
        } else if (collectionPath === 'features') {
          const res = await geosurveyApi.listFeatures();
          items = res.items as T[];
        }
        if (!cancelled) {
          setData(items);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [collectionPath]);

  return { data, loading, error };
}
