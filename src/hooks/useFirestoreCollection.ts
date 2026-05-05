import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, QueryConstraint } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';

export function useFirestoreCollection<T>(collectionPath: string, ...queryConstraints: QueryConstraint[]) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const q = query(collection(db, collectionPath), ...queryConstraints);
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as T[];
      setData(items);
      setLoading(false);
    }, (err) => {
      setError(err);
      setLoading(false);
      // Avoid crashing the React tree on permission/auth transient errors.
      // The caller can read `error` and decide what to render.
      try {
        handleFirestoreError(err, OperationType.GET, collectionPath);
      } catch (e) {
        console.error('useFirestoreCollection listener error:', e);
      }
    });

    return unsubscribe;
  }, [collectionPath]);

  return { data, loading, error };
}
