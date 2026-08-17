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
  activateGeosurveyProject,
  deactivateGeosurveyProject,
  listActiveGeosurveyProjects,
  updateGeosurveyProjectSegments,
} from './geosurveyProjectsStore';
import {
  countQuestionnairesByProject,
  deleteQuestionnaire,
  listQuestionnaires,
  upsertQuestionnaire,
} from './questionnairesStore';
import {
  deleteResponse,
  getResponseById,
  listResponseLocations,
  listResponses,
  listResponsesByIds,
  upsertResponse,
} from './responsesStore';
import {
  blockDeletedUser,
  findUserById,
  listUsers,
  updateUser,
  userToProfile,
} from './userStore';
import { revokeAuthSession } from './authStore';
import {
  createOrReplaceZoneLayer,
  deleteZoneLayer,
  distinctAssignValues,
  getZoneLayer,
  listZoneLayers,
  listZonePolygons,
  updateZoneLayerMeta,
} from './zoneLayersStore';

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
    const activeProjects = await listActiveGeosurveyProjects();
    const activeIds = new Set(activeProjects.map((item) => item.projectId));
    res.json({
      items: items.map(misProjectToGeosurvey).sort((a, b) => {
        const aa = a.isActive === false ? 1 : 0;
        const bb = b.isActive === false ? 1 : 0;
        if (aa !== bb) return aa - bb;
        return (a.name || '').localeCompare(b.name || '');
      }).map((item) => ({
        ...item,
        activeForGeosurvey: activeIds.has(item.id),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/geosurvey-projects', requireApproved, async (_req, res) => {
  try {
    const items = await listActiveGeosurveyProjects();
    res.json({
      items: items.map((item) => ({
        ...(item.projectPayload || {}),
        id: item.projectId,
        code: item.projectCode,
        name: item.projectName,
        description: item.managerName ? `PM: ${item.managerName}` : '',
        activeForGeosurvey: item.isActive,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/geosurvey-projects/:id/activate', requireAdmin, async (req, res) => {
  try {
    const project = req.body || {};
    if (String(project.id || req.params.id) !== req.params.id) {
      res.status(400).json({ error: 'Project id mismatch.' });
      return;
    }
    const saved = await activateGeosurveyProject(project);
    res.json({
      item: {
        ...(saved.projectPayload || {}),
        id: saved.projectId,
        code: saved.projectCode,
        name: saved.projectName,
        description: saved.managerName ? `PM: ${saved.managerName}` : '',
        activeForGeosurvey: saved.isActive,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/geosurvey-projects/:id/deactivate', requireAdmin, async (req, res) => {
  try {
    await deactivateGeosurveyProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/geosurvey-projects/:id/segments', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const saved = await updateGeosurveyProjectSegments(req.params.id, {
      geospatial: typeof body.geospatial === 'boolean' ? body.geospatial : undefined,
      questionnaire: typeof body.questionnaire === 'boolean' ? body.questionnaire : undefined,
      questionnaireGeofence:
        typeof body.questionnaireGeofence === 'boolean' ? body.questionnaireGeofence : undefined,
      boundaryAppliesTo:
        typeof body.boundaryAppliesTo === 'string' &&
        ['geospatial', 'questionnaire', 'both'].includes(body.boundaryAppliesTo)
          ? body.boundaryAppliesTo
          : undefined,
    });
    if (!saved) {
      res.status(404).json({ error: 'Project not found or not active in GeoSurvey.' });
      return;
    }
    res.json({
      item: {
        ...(saved.projectPayload || {}),
        id: saved.projectId,
        code: saved.projectCode,
        name: saved.projectName,
        description: saved.managerName ? `PM: ${saved.managerName}` : '',
        activeForGeosurvey: saved.isActive,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
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
    delete patch.assignedZoneValues;
    delete patch.projectZoneAssignments;
    delete patch.assignedZoneLayerId;
    delete patch.assignedGeospatialProjectIds;
  }
  const allowedKeys = [
    'displayName',
    'mobileNumber',
    'role',
    'status',
    'landmarkIconScale',
    'assignedWardName',
    'assignedWardNames',
    'projectWardAssignments',
    'assignedQuestionnaireIds',
    'assignedSlumIds',
    'projectSlumAssignments',
    'assignedZoneValues',
    'projectZoneAssignments',
    'assignedZoneLayerId',
    'assignedGeospatialProjectIds',
  ] as const;
  const cleanPatch: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
      cleanPatch[key] = patch[key];
    }
  }
  const updated = await updateUser(req.params.id, cleanPatch);
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
  const slim =
    req.query.slim === '1' ||
    req.query.slim === 'true' ||
    String(req.query.slim || '').toLowerCase() === 'yes';
  const filters = {
    questionnaireId: req.query.questionnaireId ? String(req.query.questionnaireId) : undefined,
    respondentId: isAdmin
      ? req.query.respondentId
        ? String(req.query.respondentId)
        : undefined
      : req.geosurveySession!.user.id,
    status: req.query.status ? String(req.query.status) : undefined,
    projectId: req.query.projectId ? String(req.query.projectId) : undefined,
    slim,
  };
  res.json({ items: await listResponses(filters) });
});

/** Slim GPS pins for the map — avoids shipping full answer payloads. */
app.get('/api/responses/locations', requireApproved, async (req: GeosurveyAuthenticatedRequest, res) => {
  const isAdmin = req.geosurveySession!.user.role === 'admin';
  const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
  const respondentId = isAdmin
    ? req.query.respondentId
      ? String(req.query.respondentId)
      : undefined
    : req.geosurveySession!.user.id;
  res.json({ items: await listResponseLocations({ projectId, respondentId }) });
});

/**
 * Full payloads for a page of ids. CSV/SHP export walks the filtered ids in
 * pages instead of one request per response — a 3,500-response survey with
 * photos was previously 3,500 round trips and never finished in the browser.
 */
const EXPORT_BATCH_MAX_IDS = 200;

app.post('/api/responses/export-batch', requireApproved, async (req: GeosurveyAuthenticatedRequest, res) => {
  const isAdmin = req.geosurveySession!.user.role === 'admin';
  const rawIds = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]) : [];
  const ids = [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))].slice(
    0,
    EXPORT_BATCH_MAX_IDS
  );
  if (ids.length === 0) {
    res.json({ items: [] });
    return;
  }
  const items = await listResponsesByIds(ids);
  res.json({
    items: isAdmin
      ? items
      : items.filter(
          (item) => String(item.respondentId || '') === req.geosurveySession!.user.id
        ),
  });
});

app.get('/api/responses/:id', requireApproved, async (req: GeosurveyAuthenticatedRequest, res) => {
  const isAdmin = req.geosurveySession!.user.role === 'admin';
  const slim =
    req.query.slim === '1' ||
    req.query.slim === 'true' ||
    String(req.query.slim || '').toLowerCase() === 'yes';
  const item = await getResponseById(req.params.id, { slim });
  if (!item) {
    res.status(404).json({ error: 'Response not found.' });
    return;
  }
  if (!isAdmin && String(item.respondentId || '') !== req.geosurveySession!.user.id) {
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }
  res.json({ item });
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

// ── Zone layers (generic SHP boundaries) ─────────────────────────────────
app.get('/api/zone-layers', requireApproved, async (req, res) => {
  const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
  const withPolygons =
    req.query.withPolygons === '1' || String(req.query.withPolygons).toLowerCase() === 'true';
  const items = await listZoneLayers(projectId);
  if (!withPolygons) {
    res.json({ items });
    return;
  }
  // One round-trip for project open: primary layer + its polygons.
  const layer = items[0] || null;
  const polygons = layer
    ? await listZonePolygons({
        layerId: layer.id,
        projectId: projectId || layer.projectId,
      })
    : [];
  res.json({ items, polygons });
});

app.get('/api/zone-layers/:id', requireApproved, async (req, res) => {
  const layer = await getZoneLayer(req.params.id);
  if (!layer) {
    res.status(404).json({ error: 'Zone layer not found.' });
    return;
  }
  res.json(layer);
});

app.get('/api/zone-layers/:id/assign-values', requireApproved, async (req, res) => {
  res.json({ values: await distinctAssignValues(req.params.id) });
});

app.get('/api/zone-polygons', requireApproved, async (req: GeosurveyAuthenticatedRequest, res) => {
  const session = req.geosurveySession!;
  const layerId = req.query.layerId ? String(req.query.layerId) : undefined;
  const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
  let assignValues: string[] | undefined;
  if (session.user.role === 'enumerator') {
    assignValues = session.user.assignedZoneValues || [];
    if (assignValues.length === 0) {
      res.json({ items: [] });
      return;
    }
  } else if (req.query.assignValues) {
    assignValues = String(req.query.assignValues)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const items = await listZonePolygons({ layerId, projectId, assignValues });
  res.json({ items });
});

app.post('/api/zone-layers/import', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const projectId = String(body.projectId || '').trim();
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required.' });
      return;
    }
    const polygons = Array.isArray(body.polygons) ? body.polygons : [];
    if (polygons.length === 0) {
      res.status(400).json({ error: 'No polygons to import.' });
      return;
    }
    const result = await createOrReplaceZoneLayer({
      id: body.id ? String(body.id) : undefined,
      projectId,
      name: String(body.name || 'Zones'),
      assignmentField: body.assignmentField != null ? String(body.assignmentField) : null,
      labelField: body.labelField != null ? String(body.labelField) : null,
      attributeFields: Array.isArray(body.attributeFields)
        ? body.attributeFields.map((f: unknown) => String(f))
        : [],
      strictGeofence: body.strictGeofence !== false,
      polygons: polygons.map((p: Record<string, unknown>) => ({
        id: p.id ? String(p.id) : undefined,
        assignValue: p.assignValue != null ? String(p.assignValue) : null,
        properties: (p.properties as Record<string, unknown>) || {},
        geometry: (p.geometry as Record<string, unknown>) || {},
      })),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/zone-layers/:id', requireAdmin, async (req, res) => {
  const updated = await updateZoneLayerMeta(req.params.id, {
    name: req.body?.name != null ? String(req.body.name) : undefined,
    assignmentField:
      req.body?.assignmentField !== undefined
        ? req.body.assignmentField == null
          ? null
          : String(req.body.assignmentField)
        : undefined,
    labelField:
      req.body?.labelField !== undefined
        ? req.body.labelField == null
          ? null
          : String(req.body.labelField)
        : undefined,
    strictGeofence:
      req.body?.strictGeofence !== undefined ? Boolean(req.body.strictGeofence) : undefined,
  });
  if (!updated) {
    res.status(404).json({ error: 'Zone layer not found.' });
    return;
  }
  res.json(updated);
});

app.delete('/api/zone-layers/:id', requireAdmin, async (req, res) => {
  await deleteZoneLayer(req.params.id);
  res.json({ ok: true });
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
