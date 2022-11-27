const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

async function ensureTeam(teamId) {
  const doc = db.collection('teams').doc(teamId);
  const existing = await doc.get();
  console.log(existing);
  if (existing.exists) {
    console.log('exists!', existing.data());
    return existing.data();
  } else {
    doc.set({});
    return {};
  }
}

async function createResource(teamId, name) {
  const resources = db.collection(`teams/${teamId}/resources`);
  await resources.add({name, deletedAt: null});
}

async function getResources(teamId) {
  const resources = db.collection(`teams/${teamId}/resources`).where('deletedAt', '=', null);
  const docs = await resources.get();
  return docs.docs.map(doc => ({...doc.data(), id: doc.id}));
}

async function getResource(teamId, resourceId) {
  const ref = db.doc(`teams/${teamId}/resources/${resourceId}`);
  const doc = await ref.get();
  return {...doc.data(), id: doc.id};
}

async function deleteResource(teamId, resourceId) {
  const ref = db.doc(`teams/${teamId}/resources/${resourceId}`);
  const doc = await ref.update({deletedAt: new Date().valueOf()});
}

module.exports = {
  ensureTeam,
  createResource,
  getResources,
  getResource,
  deleteResource
}
