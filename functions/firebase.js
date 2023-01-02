const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { datetimeString } = require('firebase-tools/lib/utils');

initializeApp();
const db = getFirestore();


class TeamNotFoundError extends Error {}
class ResourceNotFoundError extends Error {}
class BookingNotFoundError extends Error {}



async function ensureTeam(teamId) {
  const doc = db.collection('teams').doc(teamId);
  const existing = await doc.get();
  if (existing.exists) {
    return existing.data();
  } else {
    const data = {
      createdAt: new Date().valueOf(),
      publishingChannel: null
    };
    await doc.set(data);
    return data;
  }
}

async function createResource(teamId, name) {
  const resources = db.collection(`teams/${teamId}/resources`);
  await resources.add({name, deletedAt: null});
}

function getTeamResourcesQuery(teamId) {
  return db.collection(`teams/${teamId}/resources`).where('deletedAt', '==', null);
}

async function getResources(teamId) {
  const resources = getTeamResourcesQuery(teamId);
  const docs = await resources.get();
  return docs.docs.map(doc => ({...doc.data(), id: doc.id}));
}

async function getResource(teamId, resourceId) {
  const ref = db.doc(`teams/${teamId}/resources/${resourceId}`);
  const doc = await ref.get();
  return {...doc.data(), id: doc.id};
}

async function getResourceByName(teamId, name) {
  const query = getTeamResourcesQuery(teamId).where('name', '==', name).limit(1);
  const docs = await query.get();

  if (docs.docs.length == 1) {
    const doc = docs.docs[0];
    return {...doc.data(), id: doc.id};
  } else {
    return;
  }
}

async function deleteResource(teamId, resourceId) {
  const ref = db.doc(`teams/${teamId}/resources/${resourceId}`);
  const doc = await ref.update({deletedAt: new Date().valueOf()});
}

async function getUnresolvedBookings(teamId, resource=null) {
  let bookings = db
    .collection(`teams/${teamId}/bookings`)
    .where('resolvedAt', '==', null);

  if (resource) {
    bookings = bookings.where('resourceId', '==', resource.id);
  }

  const docs = await bookings.get();
  return docs.docs.map(doc => ({...doc.data(), id: doc.id}));
}

async function bookResource(teamId, userId, resource, now) {
  const actives = await getUnresolvedBookings(teamId, resource);
  await createResourceBooking(teamId, userId, resource, now, actives.length > 0);
  return actives;
}

async function createResourceBooking(teamId, userId, resource, now, existing) {
  db.collection(`teams/${teamId}/bookings`).add({
    resourceId: resource.id,
    userId,
    createdAt: now,
    startedAt: existing ? null : now,
    resolvedAt: null
  })
}

async function setPublishingChannel(teamId, channelId) {
  const doc = db.doc(`teams/${teamId}`);
  await doc.update({publishingChannel: channelId});
}

async function updateBooking(teamId, bookingId, data) {
  await db.doc(`teams/${teamId}/bookings/${bookingId}`).update(data);
}

async function resolveActiveBooking(teamId, resource) {
  const bookings = await getUnresolvedBookings(teamId, resource);
  bookings.sort((a, b) => a.createdAt - b.createdAt)

  console.log({bookings})

  if (bookings.length == 0) {
    throw new BookingNotFoundError();
  }

  const next = bookings[0];
  await updateBooking(teamId, next.id, { resolvedAt: new Date().valueOf() })

  const after = bookings[1];
  if (after) {
    await updateBooking(teamId, after.id, { startedAt: new Date().valueOf() })
  }

  return next;
}

module.exports = {
  ensureTeam,
  createResource,
  getResources,
  getResource,
  getResourceByName,
  deleteResource,
  bookResource,
  getUnresolvedBookings,
  setPublishingChannel,
  resolveActiveBooking,
  BookingNotFoundError
}
