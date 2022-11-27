// Inspired by this: https://github.com/seratch/bolt-on-cloud-functions-for-firebase

const functions = require("firebase-functions");
const config = functions.config();

const {
  ensureTeam,
  getResources,
  getResource,
  createResource,
  deleteResource
} = require('./firebase');


const { App, ExpressReceiver, directMention } = require('@slack/bolt');

const expressReceiver = new ExpressReceiver({
  signingSecret: config.slack.signing_secret,
  endpoints: '/events',
  processBeforeResponse: true
});

const app = new App({
  receiver: expressReceiver,
  token: config.slack.bot_token,
  processBeforeResponse: true,
});

// app.client.chat.postMessage({
//   token: config.slack.bot_token,
//   channel: "C04AWK55G83",
//   text: "I've booted up!"
// });

// React to message.channels event
const CREATE_REGEX = / create (\S+)/;
app.message(directMention(), CREATE_REGEX, async ({ message, say, context }) => {
  const { teamId } = context;
  const team = await ensureTeam(teamId);
  const [_m, name] = message.text.match(CREATE_REGEX);

  // find name, or error
  // search for existing resource with same name - error
  // create resource with name
  await createResource(teamId, name);

  console.error(message, team);
  say("Resource created!");
});

const LIST_REGEX = / list/;
app.message(directMention(), LIST_REGEX, async ({ message, say, context }) => {
  console.error({context})

  const { teamId } = context;
  const team = await ensureTeam(teamId);

  const resources = await getResources(teamId);

  console.error(message, team);
  say({
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Current resources*"
        }
      },
      ...resources.map(({name, id}) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: name
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "Delete"
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
})

const DELETE_CONFIRM_REGEX = /delete\!(\w+)/;
app.action(DELETE_CONFIRM_REGEX, async ({action, ack, respond, context}) => {
  const { teamId } = context;
  await ack();
  const [_m, resourceId] = action.action_id.match(DELETE_CONFIRM_REGEX);
  const resource = await getResource(teamId, resourceId);
  await deleteResource(teamId, resourceId);

  respond(`${resource.name} deleted!`);
})

// Check the details of the error to handle cases where you should retry sending a message or stop the app
app.error(console.error);
exports.slack = functions.https.onRequest(expressReceiver.app);
