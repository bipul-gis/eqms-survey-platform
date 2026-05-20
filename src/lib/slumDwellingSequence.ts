import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { getCached, invalidateCached, setCached } from './firestoreReadCache';
import { parseDwellingSequence } from './slumRegistry';

const DWELLING_CACHE_TTL_MS = 45_000;

/** Call after saving a response so the next form open sees the latest sequence. */
export function invalidateDwellingIdCache(questionnaireId: string): void {
  invalidateCached(`dwelling:${questionnaireId}`);
}

/**
 * Collect dwelling-id answer values already stored for a questionnaire.
 * Scans all responses (every enumerator) so `{SLUMID}_1`, `_2`, … stay in one
 * shared sequence when multiple enumerators survey the same slum.
 */
export async function loadDwellingIdValuesForQuestionnaire(
  questionnaireId: string,
  slumId: string
): Promise<unknown[]> {
  const cacheKey = `dwelling:${questionnaireId}:${slumId}`;
  const cached = getCached<unknown[]>(cacheKey, DWELLING_CACHE_TTL_MS);
  if (cached) return cached;

  const q = query(
    collection(db, 'questionnaireResponses'),
    where('questionnaireId', '==', questionnaireId)
  );
  const snap = await getDocs(q);
  const values: unknown[] = [];
  snap.forEach((docSnap) => {
    const data = docSnap.data() as {
      responses?: Record<string, unknown>;
      enumeratorInfo?: Record<string, unknown>;
    };
    for (const pool of [data.responses, data.enumeratorInfo]) {
      if (!pool || typeof pool !== 'object') continue;
      for (const v of Object.values(pool)) {
        if (parseDwellingSequence(v, slumId) !== null) values.push(v);
      }
    }
  });
  setCached(cacheKey, values);
  return values;
}
