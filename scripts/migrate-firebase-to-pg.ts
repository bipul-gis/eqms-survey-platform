/**
 * Migrate Firebase Firestore data into PostgreSQL (eqms-geosurvey).
 *
 * Prerequisites:
 *   1. npm run db:setup
 *   2. Set GOOGLE_APPLICATION_CREDENTIALS to Firebase service account JSON
 *   3. Set DATABASE_URL in .env
 *
 * Usage: npm run db:migrate-firebase
 */
import '../server/env';
import admin from 'firebase-admin';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { pool, initDb } from '../server/db';
import { hashPassword, getDefaultPassword } from '../server/passwordUtils';
import firebaseConfig from '../firebase-applet-config.json';

const DEFAULT_PROJECT_ID = 'project_20612601105';

async function getFirestoreClient() {
  let app: admin.app.App;
  if (!admin.apps.length) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath) {
      throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS to your Firebase service account JSON path.');
    }
    const serviceAccount = JSON.parse(readFileSync(credPath, 'utf8'));
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: firebaseConfig.projectId,
    });
  } else {
    app = admin.app();
  }
  const dbId = process.env.FIRESTORE_DATABASE_ID || firebaseConfig.firestoreDatabaseId;
  return getAdminFirestore(app, dbId);
}

function tsToIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return undefined;
}

async function migrateUsers(db: FirebaseFirestore.Firestore) {
  const snap = await db.collection('users').get();
  let count = 0;
  for (const docSnap of snap.docs) {
    const d = docSnap.data();
    await pool.query(
      `INSERT INTO users (
        id, email, display_name, mobile_number, role, status,
        landmark_icon_scale, assigned_ward_name, assigned_ward_names,
        project_ward_assignments, assigned_questionnaire_ids,
        assigned_slum_ids, project_slum_assignments, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        mobile_number = EXCLUDED.mobile_number,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        landmark_icon_scale = EXCLUDED.landmark_icon_scale,
        assigned_ward_name = EXCLUDED.assigned_ward_name,
        assigned_ward_names = EXCLUDED.assigned_ward_names,
        project_ward_assignments = EXCLUDED.project_ward_assignments,
        assigned_questionnaire_ids = EXCLUDED.assigned_questionnaire_ids,
        assigned_slum_ids = EXCLUDED.assigned_slum_ids,
        project_slum_assignments = EXCLUDED.project_slum_assignments,
        updated_at = NOW()`,
      [
        docSnap.id,
        String(d.email || '').toLowerCase(),
        String(d.displayName || ''),
        d.mobileNumber ?? null,
        d.role === 'admin' ? 'admin' : 'enumerator',
        d.status === 'approved' || d.status === 'rejected' ? d.status : 'pending',
        d.landmarkIconScale ?? null,
        d.assignedWardName ?? null,
        JSON.stringify(d.assignedWardNames || []),
        JSON.stringify(d.projectWardAssignments || {}),
        JSON.stringify(d.assignedQuestionnaireIds || []),
        JSON.stringify(d.assignedSlumIds || []),
        JSON.stringify(d.projectSlumAssignments || {}),
      ]
    );
    const hash = hashPassword(getDefaultPassword());
    await pool.query(
      `INSERT INTO user_credentials (user_id, password_hash, updated_at)
       VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO NOTHING`,
      [docSnap.id, hash]
    );
    count += 1;
  }
  console.log(`users: ${count}`);
}

async function migrateBlocklists(db: FirebaseFirestore.Firestore) {
  const deletedUsers = await db.collection('deleted_users').get();
  for (const docSnap of deletedUsers.docs) {
    const d = docSnap.data();
    await pool.query(
      `INSERT INTO deleted_users (uid, email, deleted_by, payload, deleted_at)
       VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, NOW()))
       ON CONFLICT (uid) DO NOTHING`,
      [
        docSnap.id,
        d.email ?? null,
        d.deletedBy ?? null,
        JSON.stringify(d),
        tsToIso(d.deletedAt) ?? null,
      ]
    );
  }
  const deletedEmails = await db.collection('deleted_user_emails').get();
  for (const docSnap of deletedEmails.docs) {
    const d = docSnap.data();
    await pool.query(
      `INSERT INTO deleted_user_emails (email_key, email, deleted_at)
       VALUES ($1,$2,COALESCE($3::timestamptz, NOW()))
       ON CONFLICT (email_key) DO NOTHING`,
      [docSnap.id, d.email ?? docSnap.id, tsToIso(d.deletedAt) ?? null]
    );
  }
  console.log(`blocklists: ${deletedUsers.size} users, ${deletedEmails.size} emails`);
}

async function migrateQuestionnaires(db: FirebaseFirestore.Firestore) {
  const snap = await db.collection('questionnaires').get();
  for (const docSnap of snap.docs) {
    const payload = { ...docSnap.data(), id: docSnap.id };
    const projectId = String(payload.projectId || DEFAULT_PROJECT_ID);
    await pool.query(
      `INSERT INTO questionnaires (id, project_id, payload, created_at, updated_at)
       VALUES ($1,$2,$3,COALESCE($4::timestamptz,NOW()),COALESCE($5::timestamptz,NOW()))
       ON CONFLICT (id) DO UPDATE SET project_id = EXCLUDED.project_id, payload = EXCLUDED.payload, updated_at = NOW()`,
      [
        docSnap.id,
        projectId,
        JSON.stringify(payload),
        tsToIso(payload.createdAt) ?? null,
        tsToIso(payload.updatedAt) ?? null,
      ]
    );
    await pool.query(
      `INSERT INTO project_id_map (legacy_id, mis_project_id, mapped_at)
       VALUES ($1, $2, NOW()) ON CONFLICT (legacy_id) DO NOTHING`,
      [projectId, projectId]
    );
  }
  console.log(`questionnaires: ${snap.size}`);
}

async function migrateResponses(db: FirebaseFirestore.Firestore) {
  const snap = await db.collection('questionnaireResponses').get();
  for (const docSnap of snap.docs) {
    const payload = { ...docSnap.data(), id: docSnap.id };
    await pool.query(
      `INSERT INTO questionnaire_responses (id, questionnaire_id, respondent_id, status, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()),COALESCE($7::timestamptz,NOW()))
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, status = EXCLUDED.status, updated_at = NOW()`,
      [
        docSnap.id,
        String(payload.questionnaireId || ''),
        String(payload.respondentId || ''),
        String(payload.status || 'draft'),
        JSON.stringify(payload),
        tsToIso(payload.submittedAt) ?? tsToIso(payload.createdAt) ?? null,
        tsToIso(payload.updatedAt) ?? null,
      ]
    );
  }
  console.log(`responses: ${snap.size}`);
}

async function migrateFeatures(db: FirebaseFirestore.Firestore) {
  const snap = await db.collection('features').get();
  let count = 0;
  for (const docSnap of snap.docs) {
    const payload = { ...docSnap.data(), id: docSnap.id };
    const attrs = (payload.attributes as Record<string, unknown>) || {};
    await pool.query(
      `INSERT INTO features (id, payload, type, status, created_by_uid, created_by, task_ward, ward_name, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,NOW()))
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [
        docSnap.id,
        JSON.stringify(payload),
        String(payload.type || 'point'),
        String(payload.status || 'pending'),
        payload.createdByUid ?? null,
        payload.createdBy ?? null,
        attrs.__taskWard != null ? String(attrs.__taskWard) : null,
        attrs.Ward_Name != null ? String(attrs.Ward_Name) : attrs.WARDNAME != null ? String(attrs.WARDNAME) : null,
        tsToIso(payload.updatedAt) ?? null,
      ]
    );
    count += 1;
    if (count % 500 === 0) console.log(`features: ${count}/${snap.size}`);
  }
  console.log(`features: ${snap.size}`);
}

async function main() {
  await initDb();
  const db = await getFirestoreClient();
  console.log('Starting Firebase → PostgreSQL migration...');
  await migrateUsers(db);
  await migrateBlocklists(db);
  await migrateQuestionnaires(db);
  await migrateResponses(db);
  await migrateFeatures(db);
  console.log('Migration complete. Users should sign in with DEFAULT_GEOSURVEY_PASSWORD unless you import Firebase Auth hashes separately.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
