import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { parseDwellingSequence } from './slumRegistry';

/** Collect dwelling-id answer values already stored for a questionnaire. */
export async function loadDwellingIdValuesForQuestionnaire(
  questionnaireId: string,
  slumId: string
): Promise<unknown[]> {
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
  return values;
}
