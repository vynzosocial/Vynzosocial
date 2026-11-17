import { deliverPush, messagePush } from './push-delivery.mjs';

export async function sendMessagePush({ conversationId, senderId, getRecipients, getInstallations, send, removeUnregistered, onFailure }) {
  const message = messagePush(conversationId);
  const recipients = await getRecipients(conversationId);
  const recipientIds = [...new Set(recipients.filter(id => id !== senderId))];
  if (!recipientIds.length) return { sent: 0, unregistered: 0, failed: 0, cleanupFailed: 0 };
  const devices = await getInstallations(recipientIds);
  const owners = new Map(devices.map(device => [device.installationId, device.userId]));
  if (devices.some(device => !recipientIds.includes(device.userId))) {
    throw new Error('Notification device owner is not a recipient.');
  }
  return deliverPush({
    installations: [...owners.keys()], message,
    send: payload => send({ ...payload, data: { ...payload.data, user_id: owners.get(payload.installationId) } }),
    removeUnregistered, onFailure
  });
}
