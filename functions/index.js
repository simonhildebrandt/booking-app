// Inspired by this: https://github.com/seratch/bolt-on-cloud-functions-for-firebase

const functions = require("firebase-functions");
const config = functions.config();

const {
  storeTeam,
  ensureTeam,
  getResources,
  getResource,
  getResourceByName,
  createResource,
  deleteResource,
  bookResource,
  getUnresolvedBookings,
  setPublishingChannel,
  resolveActiveBooking,
  BookingNotFoundError,
} = require('./firebase');


const { App, ExpressReceiver, directMention } = require('@slack/bolt');


const APPNAME = "Tesorau";


const expressReceiver = new ExpressReceiver({
  signingSecret: config.slack.signing_secret,
  stateSecret: 'tesoro-secret',
  clientId: config.slack.client_id,
  clientSecret: config.slack.client_secret,
  scopes: ['channels:history', 'channels:manage', 'chat:write'],
  endpoints: '/events',
  processBeforeResponse: true,
  installer: {}
});

const app = new App({
  receiver: expressReceiver,
  // token: config.slack.bot_token,
  processBeforeResponse: true,
  installerOptions: {
    directInstall: true
  },
  scopes: ['channels:history', 'channels:manage', 'chat:write'],
  installationStore: {
    storeInstallation: async (installation) => {
      console.log('storing installation!', installation);
      if (installation.team !== undefined) {
        return await storeTeam(installation.team.id)
      } else {
        throw new Error('Only team-based installs supported');
      }
    },
    fetchInstallation: async (installQuery) => {
      if (installQuery.teamId !== undefined) {
        return await ensureTeam(installQuery.teamId);
      }
      throw new Error('Failed fetching installation');
    },
    deleteInstallation: async (installQuery) => {
      console.log('deleting installation', installQuery);
    },
  }
});


const CREATE_REGEX = / (create|add) (\S+)/;
app.message(directMention(), CREATE_REGEX, async ({ message, say, context }) => {
  const { teamId } = context;
  await ensureTeam(teamId);
  const [_m, _v, name] = message.text.match(CREATE_REGEX);

  const existing = await getResourceByName(teamId, name);
  if (existing) {
    say(`❌ '${name}' already exists!`);
  } else {
    await createResource(teamId, name);
    say(`✅ ${name} created!`);
  }

  await publishStatus(teamId);
});

const RESOLVE_REGEX = / (resolve|done) (\S+)/;
app.message(directMention(), RESOLVE_REGEX, async ({ message, say, context }) => {
  const { teamId } = context;
  await ensureTeam(teamId);
  const [_m, _v, name] = message.text.match(RESOLVE_REGEX);

  const existing = await getResourceByName(teamId, name);
  if (!existing) {
    say(`❌ resource '${name}' not found.`);
    return;
  }

  try {
    const newActiveBooking = await resolveActiveBooking(teamId, existing);
    const extra = newActiveBooking ? `\n'${name}' now assigned to <@${newActiveBooking.userId}>.` : '';
    say(`✅ booking for '${name}' resolved.${extra}`);

    if (newActiveBooking) {
      app.client.chat.postMessage({
        token: config.slack.bot_token,
        channel: newActiveBooking.userId,
        text: `resource '${name}' is now assigned to you.`
      });
    }
  } catch(err) {
    if (err instanceof BookingNotFoundError) {
      say(`❌ booking for resource '${name}' not found.`);
      return;
    } else {
      throw err;
    }
  }

  await publishStatus(teamId);
});

const BOOK_REGEX = / book (\S+)/;
app.message(directMention(), BOOK_REGEX, async ({ message, say, context }) => {

  const { teamId } = context;
  await ensureTeam(teamId);

  const { user: userId, text: messageText } = message;
  const [_m, name] = messageText.match(BOOK_REGEX);

  const existing = await getResourceByName(teamId, name);

  if (!existing) {
    say(`❌ resource '${name}' not found.`);
    return;
  }

  const now = new Date().valueOf();
  const bookings = await bookResource(teamId, userId, existing, now);
  const previous = new Intl.ListFormat().format(bookings.map(b => `<@${b.userId}>`));

  if (bookings.length == 0) {
    say(`✅ ${name} is now yours.`);
  } else {
    say(`✅ ${name} booked! You're in the queue behind ${previous}`);
  }

  await publishStatus(teamId);
});

const LIST_REGEX = / list/;
app.message(directMention(), LIST_REGEX, async ({ message, say, context }) => {
  const { teamId } = context;
  await ensureTeam(teamId);

  const resources = await getResources(teamId);
  const bookings = await getUnresolvedBookings(teamId);

  function bookingForResource(resourceId) {
    const booking = bookings.find(b => b.resourceId == resourceId && b.startedAt !== null);

    if (booking) {
      const { userId } = booking;
      return `booked by <@${userId}>`
    } else {
      return "free"
    }
  }

  say({
    text: "Current resource list",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Current resource bookings*"
        }
      },
      ...resources.map(({name, id}) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${name}* - ${bookingForResource(id)}`
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "Delete resource"
          },
          action_id: `delete?${id}`
        }
      }))
    ]
  });
});

const DELETE_REQUEST_REGEX = /delete\?(\w+)/;
app.action(DELETE_REQUEST_REGEX, async ({action, ack, say, context}) => {
  await ack();

  const { teamId } = context;
  await ensureTeam(teamId);

  const [_m, resourceId] = action.action_id.match(DELETE_REQUEST_REGEX);
  const resource = await getResource(teamId, resourceId);

  say({
    blocks: [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `Are you sure you want to delete ${resource.name}?`
        },
        "accessory": {
          "type": "button",
          "text": {
            "type": "plain_text",
            "text": "Delete!"
          },
          "action_id": `delete!${resource.id}`
        }
      }
    ]
  });
});

const PUBLISH_REGEX = /publish (start|stop)/;
app.message(directMention(), PUBLISH_REGEX, async ({ message, say, context }) => {
  const { teamId } = context;
  const { channel } = message;
  await ensureTeam(teamId);

  const [_m, verb] = message.text.match(PUBLISH_REGEX);

  const start = verb == 'start';

  console.log({message, context})
  await setPublishingChannel(teamId, start ? channel : null)

  const text = start ?
    "Now publishing status to this channel."
    :
    "No longer publishing status to this channel.";

  say({ text });

  await publishStatus(teamId);
});

const DELETE_CONFIRM_REGEX = /delete\!(\w+)/;
app.action(DELETE_CONFIRM_REGEX, async ({action, ack, respond, context}) => {
  const { teamId } = context;
  await ensureTeam(teamId);

  await ack();

  const [_m, resourceId] = action.action_id.match(DELETE_CONFIRM_REGEX);
  const resource = await getResource(teamId, resourceId);
  await deleteResource(teamId, resourceId);

  respond(`✅ ${resource.name} deleted!`);

  await publishStatus(teamId);
});


const HELP_REGEX = / help/;
app.message(directMention(), HELP_REGEX, async ({ message, say, context }) => {

  const { teamId, botUserId } = context;
  await ensureTeam(teamId);

  say({
    text: "Help message",
    blocks: [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": `${APPNAME} help`
        },
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*${APPNAME}* helps you track who's currently using a resource.

Invoke commands using \`<@${botUserId}> <command>\`.

Get started using the following commands:`
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `\`<@${botUserId}> list\` - list all the resources ${APPNAME} is managing, and whether they're booked. (To delete resources, select 'delete resource' in this list.)`
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `\`<@${botUserId}> create <resource name>\` - creates a new resource for the ${APPNAME} bot to manage. (To delete, use the \`list\` command and click 'delete resource'.)`
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `\`<@${botUserId}> book <resource name>\` - books a resource for your use. If the resource is already booked, you'll be added the the queue to use it when it becomes free.`
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `\`<@${botUserId}> resolve <resource name>\` - resolves the active booking for a resource. If there's a queue for the resource, the next person in the queue will be notified, and become the new active booking.`
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `\`<@${botUserId}> publish [start|stop]\` - start or stop publishing in this channel. Publishing involves updating the channel's topic with the list of resources and the current bookings for them.`
        }
      },
    ]
  });
});


async function publishStatus(teamId) {
  const { publishingChannel } = await ensureTeam(teamId);

  if (publishingChannel == null) {
    return;
  }

  const resources = await getResources(teamId);
  const bookings = await getUnresolvedBookings(teamId);

  resourceDetails = resources.map(r => {
    const resBookings = bookings
      .filter(b => b.resourceId == r.id)
      .sort((a, b) => b.createdAt - a.createdAt);

    const status = resBookings.map(b => `<@${b.userId}>`).join(" ➡️ ");

    return `${r.name} - ${status || 'free'}`;
  });

  const topic = resourceDetails.join("\n")

  await app.client.conversations.setTopic({
    token: config.slack.bot_token,
    channel: publishingChannel,
    topic
  });
}

// Check the details of the error to handle cases where you should retry sending a message or stop the app
app.error(console.error);
exports.slack = functions.https.onRequest(expressReceiver.app);
