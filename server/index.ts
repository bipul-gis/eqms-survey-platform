import './env';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { initDb } from './db';
import {
  adminCreateEnumerator,
  authenticateWithPassword,
  extractSessionToken,
  registerEnumerator,
  requestPasswordReset,
  resolveSessionByToken,
} from './auth';
import {
  requireAdmin,
  requireApproved,
  requireAuth,
  type GeosurveyAuthenticatedRequest,
} from './authMiddleware';
import { buildCorsOptions } from './corsConfig';
import {
  bulkDeleteFeatures,
  bulkUpsertFeatures,
  deleteFeature,
  listFeatures,
  upsertFeature,
} from './featuresStore';
import { fetchMisProjects, misProjectToGeosurvey } from './misProjects';
import {
  countQuestionnairesByProject,
  deleteQuestionnaire,
  listQuestionnaires,
  upsertQuestionnaire,
} from './questionnairesStore';
import { deleteResponse, listResponses, upsertResponse } from './responsesStore';
import {
  blockDeletedUser,
  findUserById,
  listUsers,
  updateUser,
  userToProfile,
} from './userStore';
import { revokeAuthSession } from './authStore';

const PORT = Number(process.env.PORT || 3002);

const app = express();
app.use(cors(buildCorsOptions()));
app.use(compression());
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'eqms-geosurvey' });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    const session = await authenticateWithPassword(email, password);
    if (!session) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    res.json({ profile: session.profile, sessionToken: session.sessionToken });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const displayName = String(req.body?.displayName || '').trim();
    const mobileNumber = req.body?.mobileNumber ? String(req.body.mobileNumber) : undefined;
    if (!email || !password || !displayName) {
      res.status(400).json({ error: 'Email, password, and display name are required.' });
      return;
    }
    const session = await registerEnumerator({ email, password, displayName, mobileNumber });
    res.json({ profile: session.profile, sessionToken: session.sessionToken });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const mobileNumber = String(req.body?.mobileNumber || '');
    const tempPassword = await requestPasswordReset(email, mobileNumber);
    res.json({
      ok: true,
      message: 'Password reset successful. Use the temporary password to sign in.',
      temporaryPassword: tempPassword,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/auth/session', async (req, res) => {
  const token = extractSessionToken(req);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  const session = await resolveSessionByToken(token);
  if (!session) {
    res.status(401).json({ error: 'Session expired.' });
    return;
  }
  res.json({ profile: session.profile, sessionToken: session.sessionToken });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = extractSessionToken(req);
  if (token) await revokeAuthSession(token);
  res.json({ ok: true });
});

app.use('/api', requireAuth);

app.get('/api/mis-projects', requireApproved, async (_req, res) => {
  try {
    const items = await fetchMisProjects();
    res.json({
      items: items.map(misProjectToGeosurvey).sort((a, b) => {
        const aa = a.isActive === false ? 1 : 0;
        const bb = b.isActive === false ? 1 : 0;
        if (aa !== bb) return aa - bb;
        return (a.name || '').localeCompare(b.name || '');
      }),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/users', requireAdmin, async (_req, res) => {
  const users = await listUsers();
  res.json({ items: users.map(userToProfile) });
});

app.get('/api/users/:id', requireAuth, async (req: GeosurveyAuthenticatedRequest, res) => {
  const user = await findUserById(req.params.id);
  if (!user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  const isSelf = req.geosurveySession?.user.id === user.id;
  const isAdmin = req.geosurveySession?.user.role === 'admin';
  if (!isSelf && !isAdmin) {
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }
  res.json({ profile: userToProfile(user) });
});

app.patch('/api/users/:id', requireAuth, async (req: GeosurveyAuthenticatedRequest, res) => {
  const isSelf = req.geosurveySession?.user.id === req.params.id;
  const isAdmin = req.geosurveySession?.user.role === 'admin';
  if (!isSelf && !isAdmin) {
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }
  const patch = req.body || {};
  if (!isAdmin) {
    delete patch.role;
    delete patch.status;
    delete patch.email;
    delete patch.assignedWardNames;
    delete patch.projectWardAssignments;
    delete patch.assignedQuestionnaireIds;
    delete patch.assignedSlumIds;
    delete patch.projectSlumAssignments;
  }
  const updated = await updateUser(req.params.id, {
    displayName: patch.displayName,
    mobileNumber: patch.mobileNumber,
    role: patch.role,
    status: patch.status,
    landmarkIconScale: patch.landmarkIconScale,
    assignedWardName: patch.assignedWardName,
    assignedWardNames: patch.assignedWardNames,
    projectWardAssignments: patch.projectWardAssignments,
    assignedQuestionnaireIds: patch.assignedQuestionnaireIds,
    assignedSlumIds: patch.assignedSlumIds,
    projectSlumAssignments: patch.projectSlumAssignments,
  });
  if (!updated) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  res.json({ profile: userToProfile(updated) });
});

app.post('/api/users/enumerator', requireAdmin, async (req: GeosurveyAuthenticatedRequest, res) => {
  try {
    const profile = await adminCreateEnumerator(req.geosurveySession!.user.id, {
      email: String(req.body?.email || ''),
      password: String(req.body?.password || ''),
      displayName: String(req.body?.displayName || ''),
      mobileNumber: req.body?.mobileNumber ? String(req.body.mobileNumber) : undefined,
    });
    res.json({ profile });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req: GeosurveyAuthenticatedRequest, res) => {
  const user = await findUserById(req.params.id);
  if (!user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  await blockDeletedUser(user.id, user.email, req.geosurveySession!.user.id, userToProfile(user));
  res.json({ ok: true });
});

app.get('/api/questionnaires/counts', requireApproved, async (_req, res) => {
  res.json(await countQuestionnairesByProject());
});

app.get('/api/questionnaires', requireApproved, async (req, res) => {
  const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
  res.json({ items: await listQuestionnaires(projectId) });
});

app.post('/api/questionnaires', requireAdmin, async (req, res) => {
  const saved = await upsertQuestionnaire(req.body?.id, req.body || {});
  res.json(saved);
});

app.put('/api/questionnaires/:id', requireAdmin, async (req, res) => {
  const saved = await upsertQuestionnaire(req.params.id, { ...req.body, id: req.params.id });
  res.json(saved);
});

app.delete('/api/questionnaires/:id', requireAdmin, async (req, res) => {
  await deleteQuestionnaire(req.params.id);
  res.json({ ok: true });
});

app.get('/api/responses', requireApproved, async (req: GeosurveyAuthenticatedRequest, res) => {
  const isAdmin = req.geosurveySession!.user.role === 'admin';
  const filters = {
    questionnaireId: req.query.questionnaireId ? String(req.query.questionnaireId) : undefined,
    respondentId: isAdmin
      ? req.query.respondentId
        ? String(req.query.respondentId)
        : undefined
      : req.geosurveySession!.user.id,
    status: req.query.status ? String(req.query.status) : undefined,
  };
  res.json({ items: await listResponses(filters) });
});

app.post('/api/responses', requireApproved, async (req: GeosurveyAuthenticatedRequest, res) => {
  const body = { ...req.body };
  if (req.geosurveySession!.user.role !== 'admin') {
    body.respondentId = req.geosurveySession!.user.id;
  }
  const saved = await upsertResponse(body.id, body);
  res.json(saved);
});

app.put('/api/responses/:id', requireApproved, async (req: GeosurveyAuthenticatedRequest, res) => {
  const body = { ...req.body, id: req.params.id };
  if (req.geosurveySession!.user.role !== 'admin') {
    body.respondentId = req.geosurveySession!.user.id;
    if (body.status && body.status !== 'draft') {
      const existing = (await listResponses({ respondentId: req.geosurveySession!.user.id })).find(
        (r) => r.id === req.params.id
      );
      if (existing && existing.status !== 'draft' && body.status === 'draft') {
        res.status(403).json({ error: 'Cannot revert submitted response to draft.' });
        return;
      }
    }
  }
  const saved = await upsertResponse(req.params.id, body);
  res.json(saved);
});

app.delete('/api/responses/:id', requireApproved, async (req: GeosurveyAuthenticatedRequest, res) => {
  const items = await listResponses({
    respondentId:
      req.geosurveySession!.user.role === 'admin' ? undefined : req.geosurveySession!.user.id,
  });
  const existing = items.find((r) => r.id === req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  if (req.geosurveySession!.user.role !== 'admin' && existing.status !== 'draft') {
    res.status(403).json({ error: 'Only draft responses can be deleted.' });
    return;
  }
  await deleteResponse(req.params.id);
  res.json({ ok: true });
});

app.get('/api/features', requireApproved, async (req: GeosurveyAuthenticatedRequest, res) => {
  const session = req.geosurveySession!;
  const assignedWards = session.user.assignedWardNames || [];
  const items = await listFeatures({
    role: session.user.role,
    userUid: session.user.id,
    userEmail: session.user.email,
    assignedWards,
  });
  res.json({ items });
});

app.post('/api/features', requireApproved, async (req, res) => {
  const saved = await upsertFeature(req.body?.id, req.body || {});
  res.json(saved);
});

app.put('/api/features/:id', requireApproved, async (req, res) => {
  const saved = await upsertFeature(req.params.id, { ...req.body, id: req.params.id });
  res.json(saved);
});

app.post('/api/features/bulk', requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const count = await bulkUpsertFeatures(items);
  res.json({ count });
});

app.delete('/api/features/:id', requireAdmin, async (req, res) => {
  await deleteFeature(req.params.id);
  res.json({ ok: true });
});

app.post('/api/features/bulk-delete', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const count = await bulkDeleteFeatures(ids);
  res.json({ count });
});

async function start() {
  await initDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`EQMS GeoSurvey API listening on http://0.0.0.0:${PORT}`);
  });
}

void start();
